// Package support is where a customer gets help: disputes over a transaction (DSP-1/2) and
// live chat with an agent (SUP-1), plus the attachments both accept.
//
// Staff act through the methods that take an Agent or a reviewer; the console's HTTP operations
// (T30.5) authenticate them and call those methods. Customers act through the contract's
// operations in http.go. Both sides reach the customer in real time through outbox events.
package support

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"slices"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/jobs"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/realtime"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/support/supportdb"
)

// Policy. Each number has a reason.
const (
	// MaxFileBytes is the contract's 5 MB attachment limit.
	MaxFileBytes = 5 << 20
	// uploadsPerHour bounds what one customer can store.
	uploadsPerHour = 20
	// chatsPerDay stops a customer opening endless chats; one open chat is the norm.
	chatsPerDay = 5
	// disputeWindow is how long after a transaction it can be disputed (the usual 120-day card rule).
	disputeWindow = 120 * 24 * time.Hour
	// urlLifetime is how long a signed attachment link works.
	urlLifetime = 5 * time.Minute
	// maxAttachments per dispute or message.
	maxAttachments = 5
)

// Problems.
var (
	errTooLarge = problem.New(http.StatusRequestEntityTooLarge, "payload_too_large", "That file is too large").WithDetail("Send a JPEG, PNG or PDF of at most 5 MB.")
	errBadType  = problem.New(http.StatusUnsupportedMediaType, "unsupported_media_type", "That file type is not accepted").WithDetail("Send a JPEG, PNG or PDF.")
	errNoFile   = problem.Validation(problem.Field("/file", "required", "Choose a file first."))
	errBadFiles = problem.Validation(problem.Field("/attachment_ids", "invalid", "One of these files is not yours, was already used or does not exist."))
)

// Config holds the service's dependencies.
type Config struct {
	Pool *pgxpool.Pool
	// FilesKey signs attachment links (HMAC-SHA256); at least 32 bytes.
	FilesKey []byte
	// PublicURL prefixes attachment links ("https://api.example.com"); empty gives paths.
	PublicURL string
	// Hub carries realtime events to open apps; nil sends none.
	Hub    *realtime.Hub
	Logger *slog.Logger
	// Now defaults to time.Now.
	Now func() time.Time
}

// Service is the support domain.
type Service struct {
	pool    *pgxpool.Pool
	q       *supportdb.Queries
	key     []byte
	baseURL string
	hub     *realtime.Hub
	log     *slog.Logger
	now     func() time.Time
}

// NewService builds the service.
func NewService(cfg Config) (*Service, error) {
	if cfg.Pool == nil || cfg.Logger == nil {
		return nil, errors.New("support: pool and logger are required")
	}
	if len(cfg.FilesKey) < 32 {
		return nil, errors.New("support: the files key must be at least 32 bytes")
	}
	s := &Service{
		pool: cfg.Pool, q: supportdb.New(cfg.Pool), key: cfg.FilesKey, baseURL: cfg.PublicURL, hub: cfg.Hub,
		log: cfg.Logger.With("component", "support"), now: cfg.Now,
	}
	if s.now == nil {
		s.now = time.Now
	}
	return s, nil
}

func principal(ctx context.Context) (identity.Principal, error) {
	p, ok := identity.PrincipalFrom(ctx)
	if !ok {
		return identity.Principal{}, problem.Unauthorized()
	}
	return p, nil
}

func (s *Service) inTx(ctx context.Context, fn func(tx pgx.Tx, q *supportdb.Queries) error) error {
	return pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error { return fn(tx, s.q.WithTx(tx)) })
}

// emit writes an outbox event in the caller's transaction.
func emit(ctx context.Context, tx pgx.Tx, topic, aggregateType string, id uuid.UUID, payload map[string]any) error {
	if _, err := jobs.Write(ctx, tx, jobs.Event{Topic: topic, AggregateType: aggregateType, AggregateID: id.String(), Payload: payload}); err != nil {
		return fmt.Errorf("write %s event: %w", topic, err)
	}
	return nil
}

// ---------------------------------------------------------------- attachments

// Upload reads one multipart upload ("file" and an optional "caption") for purpose ("dispute" or
// "support"), checks the bytes and stores it. The body is read to at most 5 MB.
func (s *Service) Upload(ctx context.Context, form *multipart.Reader, purpose string) (api.Attachment, error) {
	p, err := principal(ctx)
	if err != nil {
		return api.Attachment{}, err
	}
	a, err := s.store(ctx, p.UserID, form, purpose)
	if err != nil {
		return api.Attachment{}, err
	}
	return s.attachmentJSON(a), nil
}

type stored struct {
	ID          uuid.UUID
	UserID      uuid.UUID
	FileName    string
	ContentType string
	Size        int
	CreatedAt   time.Time
}

func (s *Service) store(ctx context.Context, userID uuid.UUID, form *multipart.Reader, purpose string) (stored, error) {
	if form == nil {
		return stored{}, errNoFile
	}
	var data []byte
	var name, caption string
	for range 8 {
		part, err := form.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return stored{}, problem.Validation(problem.Field("/", "malformed", "The upload could not be read."))
		}
		switch part.FormName() {
		case "caption":
			b, _ := io.ReadAll(io.LimitReader(part, 400))
			caption = string(b)
		case "file":
			name = part.FileName()
			data, err = io.ReadAll(io.LimitReader(part, MaxFileBytes+1))
			if err != nil {
				return stored{}, problem.Validation(problem.Field("/file", "malformed", "The file could not be read."))
			}
			if len(data) > MaxFileBytes {
				return stored{}, errTooLarge
			}
		}
		_ = part.Close()
	}
	if len(data) == 0 {
		return stored{}, errNoFile
	}
	// The type comes from the bytes, never from the name or the header the client sent.
	contentType := http.DetectContentType(data)
	if !slices.Contains([]string{"image/jpeg", "image/png", "application/pdf"}, contentType) {
		return stored{}, errBadType
	}
	if len(caption) > 200 {
		return stored{}, problem.Validation(problem.Field("/caption", "too_long", "The caption can be at most 200 characters."))
	}
	now := s.now().UTC()
	recent, err := s.q.CountAttachmentsSince(ctx, supportdb.CountAttachmentsSinceParams{UserID: userID, Since: now.Add(-time.Hour)})
	if err != nil {
		return stored{}, fmt.Errorf("count uploads: %w", err)
	}
	if recent >= uploadsPerHour {
		return stored{}, problem.RateLimited(now.Add(time.Hour))
	}
	id, err := uuid.NewV7()
	if err != nil {
		return stored{}, fmt.Errorf("attachment id: %w", err)
	}
	// The name is only a label for the download: keep it short and printable.
	name = safeName(name, contentType)
	var label *string
	if caption != "" {
		label = &caption
	}
	if err := s.q.InsertAttachment(ctx, supportdb.InsertAttachmentParams{
		ID: id, UserID: userID, Purpose: purpose, FileName: name, ContentType: contentType, SizeBytes: int32(len(data)), //nolint:gosec // at most 5 MB
		Caption: label, Data: data, CreatedAt: now,
	}); err != nil {
		return stored{}, fmt.Errorf("store attachment: %w", err)
	}
	return stored{ID: id, UserID: userID, FileName: name, ContentType: contentType, Size: len(data), CreatedAt: now}, nil
}

func safeName(name, contentType string) string {
	out := make([]rune, 0, len(name))
	for _, r := range name {
		if r >= ' ' && r != '/' && r != '\\' && r != '"' && r < 0x7f {
			out = append(out, r)
		}
		if len(out) == 100 {
			break
		}
	}
	if len(out) == 0 {
		return "attachment" + map[string]string{"image/jpeg": ".jpg", "image/png": ".png", "application/pdf": ".pdf"}[contentType]
	}
	return string(out)
}

// attachmentJSON is the contract's Attachment with a fresh signed link.
func (s *Service) attachmentJSON(a stored) api.Attachment {
	return api.Attachment{
		Id: a.ID, FileName: a.FileName, ContentType: api.AttachmentContentType(a.ContentType), SizeBytes: a.Size,
		Url: s.SignedURL(a.ID, s.now()), UploadedAt: a.CreatedAt.UTC(),
	}
}

func (s *Service) attachments(ctx context.Context, q *supportdb.Queries, ids []uuid.UUID) ([]api.Attachment, error) {
	out := []api.Attachment{}
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := q.ListAttachmentMeta(ctx, ids)
	if err != nil {
		return nil, fmt.Errorf("load attachments: %w", err)
	}
	byID := map[uuid.UUID]supportdb.ListAttachmentMetaRow{}
	for _, r := range rows {
		byID[r.ID] = r
	}
	for _, id := range ids { // keep the order the customer attached them in
		if r, ok := byID[id]; ok {
			out = append(out, s.attachmentJSON(stored{ID: r.ID, UserID: r.UserID, FileName: r.FileName, ContentType: r.ContentType, Size: int(r.SizeBytes), CreatedAt: r.CreatedAt}))
		}
	}
	return out, nil
}

// claim checks that ids are the customer's own uploads (of one of purposes) and not yet used.
func (s *Service) claim(ctx context.Context, q *supportdb.Queries, userID uuid.UUID, ids []uuid.UUID, purposes ...string) error {
	if len(ids) > maxAttachments {
		return errBadFiles
	}
	seen := map[uuid.UUID]bool{}
	for _, id := range ids {
		if seen[id] {
			return errBadFiles
		}
		seen[id] = true
	}
	if len(ids) == 0 {
		return nil
	}
	rows, err := q.ListAttachmentMeta(ctx, ids)
	if err != nil {
		return fmt.Errorf("load attachments: %w", err)
	}
	if len(rows) != len(ids) {
		return errBadFiles
	}
	for _, r := range rows {
		if r.UserID != userID || !slices.Contains(purposes, r.Purpose) {
			return errBadFiles
		}
	}
	used, err := q.AttachmentsInUse(ctx, ids)
	if err != nil {
		return fmt.Errorf("check attachments: %w", err)
	}
	if used > 0 {
		return errBadFiles
	}
	return nil
}

// SignedURL is a link to an attachment that works for five minutes. Possession of the link is
// the credential, as the contract describes ("short-lived signed URL"), so it never lists or
// reveals other files, and it expires before it is worth passing around.
func (s *Service) SignedURL(id uuid.UUID, at time.Time) string {
	exp := at.Add(urlLifetime).Unix()
	return s.baseURL + "/v1/files/" + id.String() + "?exp=" + strconv.FormatInt(exp, 10) + "&sig=" + s.sign(id, exp)
}

func (s *Service) sign(id uuid.UUID, exp int64) string {
	m := hmac.New(sha256.New, s.key)
	m.Write([]byte("nem attachment link v1"))
	m.Write(id[:])
	var b [8]byte
	binary.BigEndian.PutUint64(b[:], uint64(exp)) //nolint:gosec // a unix time, positive
	m.Write(b[:])
	return base64.RawURLEncoding.EncodeToString(m.Sum(nil))
}

// Serve streams an attachment for a valid signed link. It answers 404 for anything wrong with
// the link (bad signature, expired, no such file) so a probe learns nothing.
func (s *Service) Serve(w http.ResponseWriter, r *http.Request, rawID, rawExp, sig string) {
	notFound := func() { http.NotFound(w, r) }
	id, err := uuid.Parse(rawID)
	if err != nil {
		notFound()
		return
	}
	exp, err := strconv.ParseInt(rawExp, 10, 64)
	if err != nil || s.now().Unix() > exp {
		notFound()
		return
	}
	if !hmac.Equal([]byte(sig), []byte(s.sign(id, exp))) {
		notFound()
		return
	}
	row, err := s.q.GetAttachmentData(r.Context(), id)
	if err != nil {
		notFound()
		return
	}
	w.Header().Set("Content-Type", row.ContentType)
	w.Header().Set("Content-Disposition", `inline; filename="`+row.FileName+`"`)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; sandbox")
	_, _ = w.Write(row.Data)
}
