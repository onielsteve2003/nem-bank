package developer

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unicode"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/developer/developerdb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/jobs"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/pagination"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/transfers"
)

// Outbound webhooks (DEV-3). An event becomes one delivery row per subscribed endpoint; a job
// sends it, signed with the endpoint's secret, and retries with exponential backoff. A
// receiver can verify the signature and deduplicate by Nem-Event-Id.

var eventTypes = []string{"payment_link.paid", "transfer.completed", "transfer.failed", "transfer.reversed", "account.credited", "test.ping"}

// retryDelays are the waits after the first seven failures; the eighth ends the delivery.
var retryDelays = []time.Duration{time.Minute, 5 * time.Minute, 30 * time.Minute, 2 * time.Hour, 6 * time.Hour, 12 * time.Hour, 24 * time.Hour}

const (
	maxAttempts      = 8
	deliveryTimeout  = 10 * time.Second
	secretOverlap    = 24 * time.Hour
	disableAfter     = 3 * 24 * time.Hour
	responseExcerpt  = 500
	maxResponseBytes = 4096
)

var (
	errBadURL = func(msg string) *problem.Error { return problem.Validation(problem.Field("/url", "invalid", msg)) }
	errNoHook = problem.NotFound("Webhook endpoint")
	errNoSend = problem.NotFound("Webhook delivery")
)

// ---------------------------------------------------------------- safe delivery target

// blocked says whether an address is somewhere a webhook must never go: this machine, the
// private network, link-local (the cloud metadata address lives there), carrier-grade NAT,
// multicast or unspecified. Checked on the address actually dialled, after DNS, so a hostname
// that points inward is refused too.
func blocked(a netip.Addr) bool {
	a = a.Unmap()
	return !a.IsValid() || a.IsLoopback() || a.IsPrivate() || a.IsLinkLocalUnicast() || a.IsLinkLocalMulticast() ||
		a.IsMulticast() || a.IsUnspecified() || netip.MustParsePrefix("100.64.0.0/10").Contains(a)
}

// safeClient is the HTTP client webhooks go out on: no redirects, a hard timeout, and a dialer
// that refuses internal addresses (SSRF defence).
func safeClient() *http.Client {
	d := &net.Dialer{
		Timeout: 5 * time.Second,
		Control: func(_, address string, _ syscall.RawConn) error {
			host, _, err := net.SplitHostPort(address)
			if err != nil {
				return err
			}
			a, err := netip.ParseAddr(host)
			if err != nil || blocked(a) {
				return errors.New("webhook target is not a public address")
			}
			return nil
		},
	}
	return &http.Client{
		Timeout:       deliveryTimeout,
		Transport:     &http.Transport{DialContext: d.DialContext, TLSHandshakeTimeout: 5 * time.Second, DisableKeepAlives: true},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
}

// checkURL is the cheap, early check: HTTPS, a host, no credentials in the URL, and not a literal
// internal address or "localhost". The dialer repeats the address check at send time.
func (s *Service) checkURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || len(raw) > 500 {
		return errBadURL("Use an https:// address without a username or password.")
	}
	if s.private {
		return nil
	}
	host := strings.ToLower(u.Hostname())
	if host == "localhost" || strings.HasSuffix(host, ".localhost") || strings.HasSuffix(host, ".internal") || strings.HasSuffix(host, ".local") {
		return errBadURL("That address is not reachable from the internet.")
	}
	if a, err := netip.ParseAddr(host); err == nil && blocked(a) {
		return errBadURL("That address is not reachable from the internet.")
	}
	return nil
}

// ---------------------------------------------------------------- endpoints

func endpointJSON(e developerdb.WebhookEndpoint) api.WebhookEndpoint {
	evs := make([]api.WebhookEventType, len(e.Events))
	for i, v := range e.Events {
		evs[i] = api.WebhookEventType(v)
	}
	return api.WebhookEndpoint{
		Id: e.ID, Url: e.Url, Description: e.Description, Events: evs, Status: api.WebhookEndpointStatus(e.Status),
		SecretPrefix: e.SecretPrefix, ConsecutiveFailures: int(e.ConsecutiveFailures), CreatedAt: e.CreatedAt.UTC(),
	}
}

func checkEvents(evs []string) error {
	if len(evs) == 0 {
		return problem.Validation(problem.Field("/events", "required", "Pick at least one event."))
	}
	for _, e := range evs {
		if !slices.Contains(eventTypes, e) {
			return problem.Validation(problem.Field("/events", "invalid", "Unknown event: "+e))
		}
	}
	return nil
}

func endpointAAD(id uuid.UUID) []byte { return []byte("webhook.secret:" + id.String()) }

func (s *Service) newSecret(id uuid.UUID) (secret string, ciphertext []byte, err error) {
	rest, err := randomString(32)
	if err != nil {
		return "", nil, err
	}
	secret = secretPrefix + rest
	ciphertext, err = s.keyring.Encrypt([]byte(secret), endpointAAD(id))
	return secret, ciphertext, err
}

// CreateEndpoint adds an endpoint and returns its signing secret, once.
func (s *Service) CreateEndpoint(ctx context.Context, req api.CreateWebhookEndpointRequest) (developerdb.WebhookEndpoint, string, error) {
	uid, err := owner(ctx)
	if err != nil {
		return developerdb.WebhookEndpoint{}, "", err
	}
	events := make([]string, len(req.Events))
	for i, e := range req.Events {
		events[i] = string(e)
	}
	if err := checkEvents(events); err != nil {
		return developerdb.WebhookEndpoint{}, "", err
	}
	if err := s.checkURL(req.Url); err != nil {
		return developerdb.WebhookEndpoint{}, "", err
	}
	if req.Description != nil && len([]rune(*req.Description)) > 100 {
		return developerdb.WebhookEndpoint{}, "", problem.Validation(problem.Field("/description", "length", "Use at most 100 characters."))
	}
	id, err := uuid.NewV7()
	if err != nil {
		return developerdb.WebhookEndpoint{}, "", fmt.Errorf("endpoint id: %w", err)
	}
	secret, ct, err := s.newSecret(id)
	if err != nil {
		return developerdb.WebhookEndpoint{}, "", err
	}
	now := s.now().UTC()
	err = s.inTx(ctx, func(_ pgx.Tx, q *developerdb.Queries) error {
		n, err := q.CountLiveEndpoints(ctx, uid)
		if err != nil {
			return fmt.Errorf("count endpoints: %w", err)
		}
		if n >= maxEndpoints {
			return problem.Conflict("You already have 5 webhook endpoints. Delete one first.")
		}
		return q.InsertEndpoint(ctx, developerdb.InsertEndpointParams{
			ID: id, UserID: uid, Url: req.Url, Description: req.Description, Events: events, SecretPrefix: secret[:secretShownLen],
			SecretCiphertext: ct, CreatedAt: now,
		})
	})
	if err != nil {
		return developerdb.WebhookEndpoint{}, "", err
	}
	e, err := s.q.GetEndpoint(ctx, developerdb.GetEndpointParams{ID: id, UserID: uid})
	return e, secret, err
}

// Endpoints lists the caller's endpoints.
func (s *Service) Endpoints(ctx context.Context) ([]developerdb.WebhookEndpoint, error) {
	uid, err := owner(ctx)
	if err != nil {
		return nil, err
	}
	rows, err := s.q.ListEndpoints(ctx, uid)
	if err != nil {
		return nil, fmt.Errorf("list endpoints: %w", err)
	}
	return rows, nil
}

// Endpoint returns one of the caller's endpoints; another customer's is "not found".
func (s *Service) Endpoint(ctx context.Context, id uuid.UUID) (developerdb.WebhookEndpoint, error) {
	uid, err := owner(ctx)
	if err != nil {
		return developerdb.WebhookEndpoint{}, err
	}
	e, err := s.q.GetEndpoint(ctx, developerdb.GetEndpointParams{ID: id, UserID: uid})
	if errors.Is(err, pgx.ErrNoRows) {
		return developerdb.WebhookEndpoint{}, errNoHook
	}
	if err != nil {
		return developerdb.WebhookEndpoint{}, fmt.Errorf("load endpoint: %w", err)
	}
	return e, nil
}

// UpdateEndpoint changes the fields sent. Switching a disabled endpoint back on clears its
// failure count, so it gets a fresh three days.
func (s *Service) UpdateEndpoint(ctx context.Context, id uuid.UUID, req api.UpdateWebhookEndpointRequest) (developerdb.WebhookEndpoint, error) {
	cur, err := s.Endpoint(ctx, id)
	if err != nil {
		return developerdb.WebhookEndpoint{}, err
	}
	args := developerdb.UpdateEndpointParams{ID: id, UserID: cur.UserID, Url: cur.Url, Description: cur.Description, Events: cur.Events, NewStatus: cur.Status}
	if req.Url != nil {
		if err := s.checkURL(*req.Url); err != nil {
			return developerdb.WebhookEndpoint{}, err
		}
		args.Url = *req.Url
	}
	if req.Description != nil {
		if len([]rune(*req.Description)) > 100 {
			return developerdb.WebhookEndpoint{}, problem.Validation(problem.Field("/description", "length", "Use at most 100 characters."))
		}
		args.Description = req.Description
	}
	if req.Events != nil {
		args.Events = make([]string, len(*req.Events))
		for i, e := range *req.Events {
			args.Events[i] = string(e)
		}
		if err := checkEvents(args.Events); err != nil {
			return developerdb.WebhookEndpoint{}, err
		}
	}
	if req.Status != nil {
		args.NewStatus = string(*req.Status)
	}
	e, err := s.q.UpdateEndpoint(ctx, args)
	if errors.Is(err, pgx.ErrNoRows) {
		return developerdb.WebhookEndpoint{}, errNoHook
	}
	if err != nil {
		return developerdb.WebhookEndpoint{}, fmt.Errorf("update endpoint: %w", err)
	}
	return e, nil
}

// DeleteEndpoint removes an endpoint and cancels whatever was waiting to be delivered to it.
func (s *Service) DeleteEndpoint(ctx context.Context, id uuid.UUID) error {
	uid, err := owner(ctx)
	if err != nil {
		return err
	}
	now := s.now().UTC()
	return s.inTx(ctx, func(_ pgx.Tx, q *developerdb.Queries) error {
		if _, err := q.DeleteEndpoint(ctx, developerdb.DeleteEndpointParams{ID: id, UserID: uid, Now: &now}); errors.Is(err, pgx.ErrNoRows) {
			return errNoHook
		} else if err != nil {
			return fmt.Errorf("delete endpoint: %w", err)
		}
		return q.CancelEndpointDeliveries(ctx, developerdb.CancelEndpointDeliveriesParams{EndpointID: id, Now: now})
	})
}

// RotateSecret makes a new signing secret; the old one keeps signing next to it for 24 hours,
// so a receiver can switch over without dropping events.
func (s *Service) RotateSecret(ctx context.Context, id uuid.UUID) (developerdb.WebhookEndpoint, string, error) {
	uid, err := owner(ctx)
	if err != nil {
		return developerdb.WebhookEndpoint{}, "", err
	}
	secret, ct, err := s.newSecret(id)
	if err != nil {
		return developerdb.WebhookEndpoint{}, "", err
	}
	exp := s.now().UTC().Add(secretOverlap)
	e, err := s.q.RotateSecret(ctx, developerdb.RotateSecretParams{ID: id, UserID: uid, PrevExpiresAt: &exp, SecretCiphertext: ct, SecretPrefix: secret[:secretShownLen]})
	if errors.Is(err, pgx.ErrNoRows) {
		return developerdb.WebhookEndpoint{}, "", errNoHook
	}
	if err != nil {
		return developerdb.WebhookEndpoint{}, "", fmt.Errorf("rotate secret: %w", err)
	}
	return e, secret, nil
}

// ---------------------------------------------------------------- deliveries

func deliveryJSON(d developerdb.WebhookDelivery) (api.WebhookDelivery, error) {
	out := api.WebhookDelivery{
		Id: d.ID, EndpointId: d.EndpointID, EventId: d.EventID, EventType: api.WebhookEventType(d.EventType), Attempt: int(d.Attempt),
		Status: api.WebhookDeliveryStatus(d.Status), ResponseBodyExcerpt: d.ResponseExcerpt, NextRetryAt: d.NextRetryAt, CreatedAt: d.CreatedAt.UTC(),
	}
	if d.ResponseStatus.Valid {
		v := int(d.ResponseStatus.Int32)
		out.ResponseStatus = &v
	}
	if d.DurationMs.Valid {
		v := int(d.DurationMs.Int32)
		out.DurationMs = &v
	}
	var body api.WebhookEvent
	if err := json.Unmarshal(d.Payload, &body); err != nil {
		return api.WebhookDelivery{}, fmt.Errorf("delivery body: %w", err)
	}
	out.RequestBody = &body
	return out, nil
}

// Deliveries is an endpoint's log, newest first.
func (s *Service) Deliveries(ctx context.Context, endpointID uuid.UUID, status *string, cursor *string, limit *int) ([]api.WebhookDelivery, api.PageInfo, error) {
	if _, err := s.Endpoint(ctx, endpointID); err != nil {
		return nil, api.PageInfo{}, err
	}
	after, err := pagination.Decode(cursor)
	if err != nil {
		return nil, api.PageInfo{}, err
	}
	if after.IsZero() {
		after = pagination.Cursor{Time: s.now().Add(24 * time.Hour), ID: uuid.Max}
	}
	n := pagination.Limit(limit)
	args := developerdb.ListDeliveriesParams{EndpointID: endpointID, AfterTime: after.Time, AfterID: after.ID, PageSize: int32(n + 1)} //nolint:gosec // n is at most 100
	if status != nil {
		args.Status = *status
	}
	rows, err := s.q.ListDeliveries(ctx, args)
	if err != nil {
		return nil, api.PageInfo{}, fmt.Errorf("list deliveries: %w", err)
	}
	rows, page := pagination.Page(rows, n, func(r developerdb.WebhookDelivery) pagination.Cursor {
		return pagination.Cursor{Time: r.CreatedAt, ID: r.ID}
	})
	out := make([]api.WebhookDelivery, len(rows))
	for i, r := range rows {
		if out[i], err = deliveryJSON(r); err != nil {
			return nil, api.PageInfo{}, err
		}
	}
	return out, page, nil
}

// queue records a delivery of body to the endpoint and schedules its first attempt. A second
// original delivery of the same event to the same endpoint is a no-op (the outbox may hand
// an event over twice).
func (s *Service) queue(ctx context.Context, tx pgx.Tx, q *developerdb.Queries, endpoint uuid.UUID, eventID uuid.UUID, eventType string, body []byte, original bool) (developerdb.WebhookDelivery, bool, error) {
	id, err := uuid.NewV7()
	if err != nil {
		return developerdb.WebhookDelivery{}, false, fmt.Errorf("delivery id: %w", err)
	}
	d, err := q.InsertDelivery(ctx, developerdb.InsertDeliveryParams{ID: id, EndpointID: endpoint, EventID: eventID, EventType: eventType, Payload: body, Original: original, Now: s.now().UTC()})
	if errors.Is(err, pgx.ErrNoRows) {
		return developerdb.WebhookDelivery{}, false, nil
	}
	if err != nil {
		return developerdb.WebhookDelivery{}, false, fmt.Errorf("insert delivery: %w", err)
	}
	if _, err := s.insert.InsertTx(ctx, tx, DeliverArgs{DeliveryID: d.ID}, nil); err != nil {
		return developerdb.WebhookDelivery{}, false, fmt.Errorf("queue delivery: %w", err)
	}
	return d, true, nil
}

func eventBody(id uuid.UUID, eventType string, at time.Time, object any) ([]byte, error) {
	b, err := json.Marshal(map[string]any{
		"id": id, "type": eventType, "created_at": at.UTC(), "livemode": false, "data": map[string]any{"object": object},
	})
	if err != nil {
		return nil, fmt.Errorf("encode webhook event: %w", err)
	}
	return b, nil
}

// SendTest queues a test.ping to one endpoint, whatever events it listens for.
func (s *Service) SendTest(ctx context.Context, endpointID uuid.UUID) (api.WebhookDelivery, error) {
	e, err := s.Endpoint(ctx, endpointID)
	if err != nil {
		return api.WebhookDelivery{}, err
	}
	eventID, err := uuid.NewV7()
	if err != nil {
		return api.WebhookDelivery{}, fmt.Errorf("event id: %w", err)
	}
	body, err := eventBody(eventID, "test.ping", s.now(), map[string]string{"message": "ping"})
	if err != nil {
		return api.WebhookDelivery{}, err
	}
	var d developerdb.WebhookDelivery
	err = s.inTx(ctx, func(tx pgx.Tx, q *developerdb.Queries) error {
		var ok bool
		d, ok, err = s.queue(ctx, tx, q, e.ID, eventID, "test.ping", body, true)
		if err == nil && !ok {
			err = errors.New("test event was a duplicate")
		}
		return err
	})
	if err != nil {
		return api.WebhookDelivery{}, err
	}
	return deliveryJSON(d)
}

// Replay sends the same event again, with the same Nem-Event-Id so a receiver can tell it is
// the same event. It is a new delivery with its own log.
func (s *Service) Replay(ctx context.Context, deliveryID uuid.UUID) (api.WebhookDelivery, error) {
	uid, err := owner(ctx)
	if err != nil {
		return api.WebhookDelivery{}, err
	}
	old, err := s.q.GetDelivery(ctx, developerdb.GetDeliveryParams{ID: deliveryID, UserID: uid})
	if errors.Is(err, pgx.ErrNoRows) {
		return api.WebhookDelivery{}, errNoSend
	}
	if err != nil {
		return api.WebhookDelivery{}, fmt.Errorf("load delivery: %w", err)
	}
	var d developerdb.WebhookDelivery
	err = s.inTx(ctx, func(tx pgx.Tx, q *developerdb.Queries) error {
		var ok bool
		d, ok, err = s.queue(ctx, tx, q, old.EndpointID, old.EventID, old.EventType, old.Payload, false)
		if err == nil && !ok {
			err = errors.New("replay was a duplicate")
		}
		return err
	})
	if err != nil {
		return api.WebhookDelivery{}, err
	}
	return deliveryJSON(d)
}

// ---------------------------------------------------------------- dispatch from the outbox

// Subscriber turns the bank's events into webhook deliveries for the customers who asked.
func (s *Service) Subscriber() jobs.Subscriber {
	return jobs.Subscriber{
		Name:   "developer_webhooks",
		Topics: []string{"transfer.completed", "transfer.failed", transfers.TopicLinkPaid},
		Handle: s.dispatch,
	}
}

type outboxEvent struct {
	TransferID      uuid.UUID  `json:"transfer_id"`
	UserID          uuid.UUID  `json:"user_id"`
	RecipientUserID *uuid.UUID `json:"recipient_user_id"`
	PaymentLinkID   uuid.UUID  `json:"payment_link_id"`
	Reversed        bool       `json:"reversed"`
}

type target struct {
	user      uuid.UUID
	eventType string
}

func (s *Service) dispatch(ctx context.Context, d jobs.Delivery) error {
	var e outboxEvent
	if err := json.Unmarshal(d.Payload, &e); err != nil {
		return fmt.Errorf("%s payload: %w", d.Topic, err)
	}
	var targets []target
	switch d.Topic {
	case "transfer.completed":
		targets = []target{{e.UserID, "transfer.completed"}}
		if e.RecipientUserID != nil {
			targets = append(targets, target{*e.RecipientUserID, "account.credited"})
		}
	case "transfer.failed":
		targets = []target{{e.UserID, "transfer.failed"}}
		if e.Reversed { // a failed external transfer is given back: the contract names that too
			targets = append(targets, target{e.UserID, "transfer.reversed"})
		}
	case transfers.TopicLinkPaid:
		targets = []target{{e.UserID, "payment_link.paid"}}
	}
	var object json.RawMessage
	for _, t := range targets {
		endpoints, err := s.q.ListActiveEndpointsFor(ctx, developerdb.ListActiveEndpointsForParams{UserID: t.user, EventType: t.eventType})
		if err != nil {
			return fmt.Errorf("list endpoints: %w", err)
		}
		if len(endpoints) == 0 {
			continue
		}
		if object == nil { // built once, and only if somebody is listening
			var err error
			if object, err = s.object(ctx, d.Topic, e); err != nil {
				return err
			}
		}
		// The event ID is derived from the outbox event, so a redelivered job makes the same ID.
		eventID := uuid.NewSHA1(d.ID, []byte(t.user.String()+t.eventType))
		body, err := eventBody(eventID, t.eventType, d.CreatedAt, object)
		if err != nil {
			return err
		}
		if err := s.inTx(ctx, func(tx pgx.Tx, q *developerdb.Queries) error {
			for _, ep := range endpoints {
				if _, _, err := s.queue(ctx, tx, q, ep.ID, eventID, t.eventType, body, true); err != nil {
					return err
				}
			}
			return nil
		}); err != nil {
			return err
		}
	}
	return nil
}

// object is the resource an event is about, in the shape the API returns it.
func (s *Service) object(ctx context.Context, topic string, e outboxEvent) (json.RawMessage, error) {
	if topic == transfers.TopicLinkPaid {
		l, err := s.transfers.LinkJSONByID(ctx, e.PaymentLinkID)
		if err != nil {
			return nil, err
		}
		return json.Marshal(l)
	}
	v, err := s.transfers.StaffView(ctx, e.TransferID)
	if err != nil {
		return nil, err
	}
	t, err := transfers.TransferJSON(v)
	if err != nil {
		return nil, err
	}
	return json.Marshal(t)
}

// ---------------------------------------------------------------- sending

// DeliverArgs is the job that makes one delivery attempt.
type DeliverArgs struct {
	DeliveryID uuid.UUID `json:"delivery_id"`
}

// Kind implements river.JobArgs.
func (DeliverArgs) Kind() string { return "webhook_deliver" }

type deliverWorker struct {
	river.WorkerDefaults[DeliverArgs]
	s *Service
}

func (w *deliverWorker) Work(ctx context.Context, job *river.Job[DeliverArgs]) error {
	return w.s.Attempt(ctx, job.Args.DeliveryID)
}

// Register adds the delivery worker to the job runner.
func (s *Service) Register(w *river.Workers) { river.AddWorker(w, &deliverWorker{s: s}) }

// Signature is the Nem-Signature header: a timestamp and one HMAC-SHA256 of "t.body" per live
// secret (two during a rotation), so a receiver can check either.
func Signature(at time.Time, body []byte, secrets ...[]byte) string {
	t := strconv.FormatInt(at.Unix(), 10)
	parts := []string{"t=" + t}
	for _, sec := range secrets {
		m := hmac.New(sha256.New, sec)
		m.Write([]byte(t + "."))
		m.Write(body)
		parts = append(parts, "v1="+hex.EncodeToString(m.Sum(nil)))
	}
	return strings.Join(parts, ",")
}

func (s *Service) secrets(e developerdb.WebhookEndpoint) ([][]byte, error) {
	cur, err := s.keyring.Decrypt(e.SecretCiphertext, endpointAAD(e.ID))
	if err != nil {
		return nil, fmt.Errorf("decrypt webhook secret: %w", err)
	}
	out := [][]byte{cur}
	if e.PrevSecretCiphertext != nil && e.PrevSecretExpiresAt != nil && s.now().Before(*e.PrevSecretExpiresAt) {
		prev, err := s.keyring.Decrypt(e.PrevSecretCiphertext, endpointAAD(e.ID))
		if err != nil {
			return nil, fmt.Errorf("decrypt previous webhook secret: %w", err)
		}
		out = append(out, prev)
	}
	return out, nil
}

// printable keeps what a person can read, so a hostile response cannot fill the log with
// control characters or markup that a console might render.
func printable(b []byte) string {
	var sb strings.Builder
	for _, r := range string(b) {
		if sb.Len() >= responseExcerpt {
			break
		}
		if unicode.IsPrint(r) {
			sb.WriteRune(r)
		} else {
			sb.WriteByte(' ')
		}
	}
	return strings.TrimSpace(sb.String())
}

// Attempt makes the next try for a delivery and records the outcome. Only a delivery that is
// pending or waiting to retry is tried; a deleted or disabled endpoint ends it.
func (s *Service) Attempt(ctx context.Context, id uuid.UUID) error {
	d, err := s.q.GetDeliveryForUpdate(ctx, id) // outside a transaction: only a read here
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("load delivery: %w", err)
	}
	if d.Status != "pending" && d.Status != "retrying" {
		return nil
	}
	ep, err := s.q.GetEndpointByID(ctx, d.EndpointID)
	if err != nil {
		return fmt.Errorf("load endpoint: %w", err)
	}
	now := s.now().UTC()
	if ep.DeletedAt != nil || ep.Status != "active" {
		return s.q.RecordAttempt(ctx, developerdb.RecordAttemptParams{ID: d.ID, Status: "failed", Attempt: d.Attempt, Now: now, ResponseExcerpt: ptr("Endpoint is deleted or disabled.")})
	}
	attempt := d.Attempt
	if d.Status == "retrying" {
		attempt++
	}
	secrets, err := s.secrets(ep)
	if err != nil {
		return err
	}

	status, excerpt, took, sendErr := s.post(ctx, ep.Url, d, secrets)
	ok := sendErr == nil && status >= 200 && status < 300
	rec := developerdb.RecordAttemptParams{ID: d.ID, Attempt: attempt, Now: s.now().UTC(), ResponseExcerpt: &excerpt}
	rec.DurationMs.Int32, rec.DurationMs.Valid = int32(took.Milliseconds()), true //nolint:gosec // bounded by the 10 s timeout
	if status != 0 {
		rec.ResponseStatus.Int32, rec.ResponseStatus.Valid = int32(status), true //nolint:gosec // an HTTP status
	}
	if sendErr != nil && excerpt == "" {
		msg := "Could not reach the endpoint."
		rec.ResponseExcerpt = &msg
	}
	return s.inTx(ctx, func(tx pgx.Tx, q *developerdb.Queries) error {
		switch {
		case ok:
			rec.Status = "succeeded"
			if err := q.EndpointSucceeded(ctx, ep.ID); err != nil {
				return fmt.Errorf("endpoint succeeded: %w", err)
			}
		case int(attempt) >= maxAttempts:
			rec.Status = "failed"
		default:
			rec.Status = "retrying"
			next := rec.Now.Add(retryDelays[attempt-1])
			rec.NextRetryAt = &next
			if _, err := s.insert.InsertTx(ctx, tx, DeliverArgs{DeliveryID: d.ID}, &river.InsertOpts{ScheduledAt: next}); err != nil {
				return fmt.Errorf("queue retry: %w", err)
			}
		}
		if !ok {
			if _, err := q.EndpointFailed(ctx, developerdb.EndpointFailedParams{ID: ep.ID, Now: rec.Now}); err != nil {
				return fmt.Errorf("endpoint failed: %w", err)
			}
		}
		return q.RecordAttempt(ctx, rec)
	})
}

func (s *Service) post(ctx context.Context, rawURL string, d developerdb.WebhookDelivery, secrets [][]byte) (int, string, time.Duration, error) {
	ctx, cancel := context.WithTimeout(ctx, deliveryTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, rawURL, bytes.NewReader(d.Payload))
	if err != nil {
		return 0, "", 0, fmt.Errorf("build webhook request: %w", err)
	}
	now := s.now()
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "NemBank-Webhooks/1")
	req.Header.Set("Nem-Event-Id", d.EventID.String())
	req.Header.Set("Nem-Event-Type", d.EventType)
	req.Header.Set("Nem-Signature", Signature(now, d.Payload, secrets...))
	start := time.Now()
	resp, err := s.client.Do(req)
	took := time.Since(start)
	if err != nil {
		return 0, "", took, err
	}
	defer func() { _ = resp.Body.Close() }()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes))
	return resp.StatusCode, printable(b), took, nil
}

func ptr[T any](v T) *T { return &v }
