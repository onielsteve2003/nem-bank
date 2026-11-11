// Package privacy is the customer's data rights under the NDPA 2023 (SET-5): a copy of their data
// and the closing and erasing of their account.
//
// An export is built by a job, encrypted, and offered once through a signed link in an email that
// holds no data. A deletion needs a zero balance and nothing in flight, then erases everything that
// identifies the customer and keeps what the law requires: the ledger (entries, postings and the
// customers' transaction lines, which other people's records depend on) and the audit log, both of
// which refer to the customer by ID only.
package privacy

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/audit"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/fieldcrypt"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/mailer"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/privacy/privacydb"
)

// StepUps spends the confirmation a customer earned before deleting their account.
type StepUps interface {
	ConsumeStepUp(ctx context.Context, tx pgx.Tx, userID uuid.UUID, purpose, token string) error
}

const (
	// completionPromise is how long the customer is told a request can take (NDPA: 30 days). The
	// jobs normally finish in minutes.
	completionPromise = 30 * 24 * time.Hour
	exportsPerDay     = 2
	linkLifetime      = 24 * time.Hour
	archiveLifetime   = 7 * 24 * time.Hour
	formatVersion     = 1
)

// Config holds the service's dependencies.
type Config struct {
	Pool    *pgxpool.Pool
	Keyring *fieldcrypt.Keyring
	Mailer  mailer.Mailer
	StepUps StepUps
	// PublicURL prefixes the download link in the export email ("https://api.example.com"); empty
	// gives a path, which only works if the customer opens it on the API's own host.
	PublicURL string
	// LinkKey signs download links; at least 32 bytes.
	LinkKey []byte
	Logger  *slog.Logger
	// Now defaults to time.Now.
	Now func() time.Time
}

// Service is the privacy domain.
type Service struct {
	pool    *pgxpool.Pool
	q       *privacydb.Queries
	keyring *fieldcrypt.Keyring
	mail    mailer.Mailer
	stepUps StepUps
	baseURL string
	key     []byte
	insert  *river.Client[pgx.Tx]
	log     *slog.Logger
	now     func() time.Time
}

// NewService checks the configuration.
func NewService(cfg Config) (*Service, error) {
	if cfg.Pool == nil || cfg.Keyring == nil || cfg.Mailer == nil || cfg.Logger == nil {
		return nil, errors.New("privacy: pool, keyring, mailer and logger are required")
	}
	if len(cfg.LinkKey) < 32 {
		return nil, errors.New("privacy: link key must be at least 32 bytes")
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	// Insert-only: the process's jobs.Runner works the privacy jobs (Register).
	insert, err := river.NewClient(riverpgxv5.New(cfg.Pool), &river.Config{Logger: cfg.Logger})
	if err != nil {
		return nil, fmt.Errorf("privacy job client: %w", err)
	}
	return &Service{
		pool: cfg.Pool, q: privacydb.New(cfg.Pool), keyring: cfg.Keyring, mail: cfg.Mailer, stepUps: cfg.StepUps,
		baseURL: strings.TrimRight(cfg.PublicURL, "/"), key: cfg.LinkKey, insert: insert, log: cfg.Logger.With("component", "privacy"), now: cfg.Now,
	}, nil
}

func (s *Service) inTx(ctx context.Context, fn func(tx pgx.Tx, q *privacydb.Queries) error) error {
	return pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error { return fn(tx, s.q.WithTx(tx)) })
}

func requestJSON(r privacydb.PrivacyRequest) api.PrivacyRequest {
	return api.PrivacyRequest{
		Id: r.ID, Kind: api.PrivacyRequestKind(r.Kind), Status: api.PrivacyRequestStatus(r.Status),
		RequestedAt: r.RequestedAt.UTC(), CompletesBy: r.CompletesBy.UTC(),
	}
}

func owner(ctx context.Context) (uuid.UUID, error) {
	p, ok := identity.PrincipalFrom(ctx)
	if !ok {
		return uuid.Nil, problem.Unauthorized()
	}
	return p.UserID, nil
}

func newRequest(userID uuid.UUID, kind string, now time.Time) (privacydb.InsertRequestParams, error) {
	id, err := uuid.NewV7()
	if err != nil {
		return privacydb.InsertRequestParams{}, fmt.Errorf("request id: %w", err)
	}
	return privacydb.InsertRequestParams{ID: id, UserID: userID, Kind: kind, RequestedAt: now, CompletesBy: now.Add(completionPromise)}, nil
}

// ---------------------------------------------------------------- export

// ExportArgs is the job that builds one archive.
type ExportArgs struct {
	RequestID uuid.UUID `json:"request_id"`
}

// Kind implements river.JobArgs.
func (ExportArgs) Kind() string { return "privacy_export" }

// EraseArgs is the job that erases one customer.
type EraseArgs struct {
	RequestID uuid.UUID `json:"request_id"`
}

// Kind implements river.JobArgs.
func (EraseArgs) Kind() string { return "privacy_erase" }

type exportWorker struct {
	river.WorkerDefaults[ExportArgs]
	s *Service
}

func (w *exportWorker) Work(ctx context.Context, job *river.Job[ExportArgs]) error {
	return w.s.BuildExport(ctx, job.Args.RequestID)
}

type eraseWorker struct {
	river.WorkerDefaults[EraseArgs]
	s *Service
}

func (w *eraseWorker) Work(ctx context.Context, job *river.Job[EraseArgs]) error {
	return w.s.Erase(ctx, job.Args.RequestID)
}

// Register adds the workers to the job runner.
func (s *Service) Register(w *river.Workers) {
	river.AddWorker(w, &exportWorker{s: s})
	river.AddWorker(w, &eraseWorker{s: s})
}

// RequestExport accepts a request for a copy of the customer's data, at most twice a day: an
// archive is the most sensitive document the bank makes, and nobody needs one every minute.
func (s *Service) RequestExport(ctx context.Context) (api.PrivacyRequest, error) {
	uid, err := owner(ctx)
	if err != nil {
		return api.PrivacyRequest{}, err
	}
	now := s.now().UTC()
	var out privacydb.PrivacyRequest
	err = s.inTx(ctx, func(tx pgx.Tx, q *privacydb.Queries) error {
		recent, err := q.RecentExportRequests(ctx, privacydb.RecentExportRequestsParams{UserID: uid, Since: now.Add(-24 * time.Hour)})
		if err != nil {
			return fmt.Errorf("count exports: %w", err)
		}
		if len(recent) >= exportsPerDay {
			return problem.RateLimited(recent[0].Add(24 * time.Hour))
		}
		in, err := newRequest(uid, "export", now)
		if err != nil {
			return err
		}
		if out, err = q.InsertRequest(ctx, in); err != nil {
			return fmt.Errorf("insert request: %w", err)
		}
		if _, err := s.insert.InsertTx(ctx, tx, ExportArgs{RequestID: out.ID}, &river.InsertOpts{MaxAttempts: 5}); err != nil {
			return fmt.Errorf("queue export: %w", err)
		}
		return nil
	})
	if err != nil {
		return api.PrivacyRequest{}, err
	}
	return requestJSON(out), nil
}

func exportAAD(id uuid.UUID) []byte { return []byte("privacy.export:" + id.String()) }

// BuildExport makes the archive, stores it encrypted and emails the link. It is safe to run
// again: a finished request is left alone, and a half-done one is simply redone.
func (s *Service) BuildExport(ctx context.Context, id uuid.UUID) error {
	req, err := s.q.GetRequest(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && (req.Kind != "export" || req.Status == "completed")) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("load request: %w", err)
	}
	if err := s.q.SetRequestStatus(ctx, privacydb.SetRequestStatusParams{ID: id, NewStatus: "processing"}); err != nil {
		return fmt.Errorf("mark processing: %w", err)
	}
	archive, err := s.archive(ctx, req.UserID)
	if err != nil {
		return err
	}
	ct, err := s.keyring.Encrypt(archive, exportAAD(id))
	if err != nil {
		return fmt.Errorf("encrypt archive: %w", err)
	}
	now := s.now().UTC()
	who, err := s.q.GetOwnerEmail(ctx, req.UserID)
	if errors.Is(err, pgx.ErrNoRows) {
		return s.q.SetRequestStatus(ctx, privacydb.SetRequestStatusParams{ID: id, NewStatus: "rejected", DoneAt: &now, Reason: ptr("The account no longer exists.")})
	}
	if err != nil {
		return fmt.Errorf("load owner: %w", err)
	}
	if err := s.q.StoreExport(ctx, privacydb.StoreExportParams{RequestID: id, UserID: req.UserID, Ciphertext: ct, ExpiresAt: now.Add(archiveLifetime)}); err != nil {
		return fmt.Errorf("store archive: %w", err)
	}
	// The email carries a link and no data. A failure is returned so the job retries; the
	// request stays "processing" until the customer has actually been told.
	if err := s.mail.Send(ctx, mailer.Message{
		To: who.Email, Subject: "Your Nem Bank data export is ready",
		Text: fmt.Sprintf("Hi %s,\n\nA copy of your data is ready. Download it within 24 hours; the link works once:\n\n%s\n\n"+
			"If you did not ask for this, change your password and tell support.\n\nThis is a demo bank. No real money moves.", who.FirstName, s.link(id, req.UserID, now.Add(linkLifetime))),
	}); err != nil {
		return fmt.Errorf("email export link: %w", err)
	}
	return s.q.SetRequestStatus(ctx, privacydb.SetRequestStatusParams{ID: id, NewStatus: "completed", DoneAt: &now})
}

func ptr[T any](v T) *T { return &v }

// archive is the customer's data as one JSON document. Sections come from explicit column lists,
// so a hash, key, token or encrypted value can never leak in by a new column appearing.
func (s *Service) archive(ctx context.Context, uid uuid.UUID) ([]byte, error) {
	type section struct {
		name string
		load func() ([]byte, error)
	}
	q := s.q
	sections := []section{
		{"profile", func() ([]byte, error) { return q.ExportProfile(ctx, uid) }},
		{"accounts", func() ([]byte, error) { return q.ExportAccounts(ctx, uid) }},
		{"transactions", func() ([]byte, error) { return q.ExportTransactions(ctx, uid) }},
		{"transfers", func() ([]byte, error) { return q.ExportTransfers(ctx, uid) }},
		{"beneficiaries", func() ([]byte, error) { return q.ExportBeneficiaries(ctx, uid) }},
		{"scheduled_transfers", func() ([]byte, error) { return q.ExportScheduled(ctx, uid) }},
		{"payment_links", func() ([]byte, error) { return q.ExportPaymentLinks(ctx, uid) }},
		{"cards", func() ([]byte, error) { return q.ExportCards(ctx, uid) }},
		{"savings", func() ([]byte, error) { return q.ExportSavings(ctx, uid) }},
		{"loans", func() ([]byte, error) { return q.ExportCredit(ctx, uid) }},
		{"ajo", func() ([]byte, error) { return q.ExportAjo(ctx, uid) }},
		{"devices", func() ([]byte, error) { return q.ExportDevices(ctx, uid) }},
		{"verification", func() ([]byte, error) { return q.ExportKyc(ctx, uid) }},
		{"notifications", func() ([]byte, error) { return q.ExportNotifications(ctx, uid) }},
		{"support", func() ([]byte, error) { return q.ExportSupport(ctx, uid) }},
		{"assistant", func() ([]byte, error) { return q.ExportAssistant(ctx, uid) }},
		{"developer", func() ([]byte, error) { return q.ExportDeveloper(ctx, uid) }},
		{"activity_log", func() ([]byte, error) { return q.ExportActivityLog(ctx, uid.String()) }},
	}
	var buf bytes.Buffer
	buf.WriteString("{\n")
	meta, err := json.Marshal(map[string]any{
		"format_version": formatVersion, "generated_at": s.now().UTC(), "subject_id": uid,
		"note": "Your data from Nem Bank (a demo bank; all money is simulated). Hashes, keys and tokens are never included.",
	})
	if err != nil {
		return nil, fmt.Errorf("encode export metadata: %w", err)
	}
	buf.WriteString(`"export": ` + string(meta))
	for _, sec := range sections {
		raw, err := sec.load()
		if err != nil {
			return nil, fmt.Errorf("export %s: %w", sec.name, err)
		}
		buf.WriteString(",\n" + strconv.Quote(sec.name) + ": ")
		buf.Write(raw)
	}
	buf.WriteString("\n}\n")
	// Round-trip through the decoder: the archive must be valid JSON before it is sealed.
	var check map[string]json.RawMessage
	if err := json.Unmarshal(buf.Bytes(), &check); err != nil {
		return nil, fmt.Errorf("assemble export: %w", err)
	}
	return buf.Bytes(), nil
}

// ---------------------------------------------------------------- download link

// DownloadPath is the one-time download route for a finished export.
const DownloadPath = "/v1/privacy/exports/:id/download"

func (s *Service) sign(id, user uuid.UUID, exp int64) string {
	m := hmac.New(sha256.New, s.key)
	m.Write([]byte("nem privacy export link v1"))
	m.Write(id[:])
	m.Write(user[:])
	var b [8]byte
	binary.BigEndian.PutUint64(b[:], uint64(exp)) //nolint:gosec // a unix time, positive
	m.Write(b[:])
	return base64.RawURLEncoding.EncodeToString(m.Sum(nil))
}

func (s *Service) link(id, user uuid.UUID, until time.Time) string {
	exp := until.Unix()
	return s.baseURL + "/v1/privacy/exports/" + id.String() + "/download?u=" + user.String() + "&exp=" + strconv.FormatInt(exp, 10) + "&sig=" + s.sign(id, user, exp)
}

// Serve hands over an archive for a valid link, once. Anything wrong with the link, or a second
// visit, is a plain 404: a probe learns nothing, and a leaked link is useless after first use.
func (s *Service) Serve(w http.ResponseWriter, r *http.Request, rawID, rawUser, rawExp, sig string) {
	notFound := func() { http.NotFound(w, r) }
	id, err1 := uuid.Parse(rawID)
	user, err2 := uuid.Parse(rawUser)
	exp, err3 := strconv.ParseInt(rawExp, 10, 64)
	if err1 != nil || err2 != nil || err3 != nil || s.now().Unix() > exp || !hmac.Equal([]byte(sig), []byte(s.sign(id, user, exp))) {
		notFound()
		return
	}
	row, err := s.q.TakeExport(r.Context(), privacydb.TakeExportParams{RequestID: id, Now: s.now().UTC()})
	if err != nil || row.UserID != user {
		notFound()
		return
	}
	archive, err := s.keyring.Decrypt(row.Ciphertext, exportAAD(id))
	if err != nil {
		s.log.Error("decrypt export", "error", err.Error(), "request_id", id.String())
		http.Error(w, "export unavailable", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Content-Disposition", `attachment; filename="nem-bank-data-export.json"`)
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	_, _ = w.Write(archive)
}

// Prune removes archives nobody downloaded in time.
func (s *Service) Prune(ctx context.Context) error {
	return s.q.PruneExports(ctx, s.now().UTC())
}

// ---------------------------------------------------------------- deletion

// blockers says, in plain words, what stops the account closing; empty means nothing does.
func blockers(b privacydb.DeletionBlockersRow) []string {
	var out []string
	add := func(n int32, msg string) {
		if n > 0 {
			out = append(out, msg)
		}
	}
	add(b.AccountsWithMoney, "Move all money out of your accounts and wallets first.")
	add(b.ActiveHolds, "Wait for pending card payments and transfers to finish.")
	add(b.TransfersInFlight, "A transfer is still in progress.")
	add(b.OtherBalances, "Withdraw your savings goals and locked savings first.")
	add(b.LockedSavings, "Break or wait out your locked savings first.")
	add(b.OpenLoans, "Repay your loan first.")
	add(b.AjoGroups, "Leave or finish your ajo groups first.")
	add(b.OpenDisputes, "Wait for your open dispute to be settled.")
	add(b.Dependants, "Remove your family dependants first.")
	return out
}

// RequestDeletion accepts a request to close and erase the account. The customer needs a zero
// balance and a step-up. A second request while one is open or done answers with the same one.
func (s *Service) RequestDeletion(ctx context.Context, stepUpToken string) (api.PrivacyRequest, error) {
	uid, err := owner(ctx)
	if err != nil {
		return api.PrivacyRequest{}, err
	}
	now := s.now().UTC()
	var out privacydb.PrivacyRequest
	err = s.inTx(ctx, func(tx pgx.Tx, q *privacydb.Queries) error {
		// The customer row is locked, so two requests at once are one request.
		if _, err := tx.Exec(ctx, `SELECT 1 FROM users WHERE id = $1 FOR UPDATE`, uid); err != nil {
			return fmt.Errorf("lock customer: %w", err)
		}
		b, err := q.DeletionBlockers(ctx, uid)
		if err != nil {
			return fmt.Errorf("check eligibility: %w", err)
		}
		if why := blockers(b); len(why) > 0 {
			return problem.Conflict("Your account cannot be deleted yet. " + strings.Join(why, " "))
		}
		if s.stepUps == nil {
			return identity.ErrStepUpRequired
		}
		if err := s.stepUps.ConsumeStepUp(ctx, tx, uid, "account_deletion", stepUpToken); err != nil {
			return err
		}
		in, err := newRequest(uid, "deletion", now)
		if err != nil {
			return err
		}
		if out, err = q.InsertRequest(ctx, in); err != nil {
			return fmt.Errorf("insert request: %w", err)
		}
		if _, err := s.insert.InsertTx(ctx, tx, EraseArgs{RequestID: out.ID}, &river.InsertOpts{MaxAttempts: 5}); err != nil {
			return fmt.Errorf("queue erasure: %w", err)
		}
		return nil
	})
	if err != nil {
		return api.PrivacyRequest{}, err
	}
	return requestJSON(out), nil
}

// Erase closes the account and erases what identifies the customer, in one transaction. It checks
// eligibility again (money may have arrived since the request) and, if the account can no longer
// close, rejects the request with the reason instead of half-erasing.
func (s *Service) Erase(ctx context.Context, id uuid.UUID) error {
	req, err := s.q.GetRequest(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && (req.Kind != "deletion" || req.Status == "completed" || req.Status == "rejected")) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("load request: %w", err)
	}
	now := s.now().UTC()
	uid := req.UserID
	return s.inTx(ctx, func(tx pgx.Tx, q *privacydb.Queries) error {
		if _, err := tx.Exec(ctx, `SELECT 1 FROM users WHERE id = $1 FOR UPDATE`, uid); err != nil {
			return fmt.Errorf("lock customer: %w", err)
		}
		b, err := q.DeletionBlockers(ctx, uid)
		if err != nil {
			return fmt.Errorf("check eligibility: %w", err)
		}
		if why := blockers(b); len(why) > 0 {
			return q.SetRequestStatus(ctx, privacydb.SetRequestStatusParams{ID: id, NewStatus: "rejected", DoneAt: &now, Reason: ptr(strings.Join(why, " "))})
		}
		// Peers' records first, while the customer's accounts can still be found by their owner.
		steps := []struct {
			name string
			run  func() error
		}{
			{"peer transfers", func() error { return q.ErasePeersTransfers(ctx, uid) }},
			{"peer transactions", func() error { return q.ErasePeersTransactions(ctx, uid) }},
			{"sessions", func() error { return q.EndSessions(ctx, uid) }},
			{"refresh tokens", func() error { return q.DeleteRefreshTokens(ctx, uid) }},
			{"devices", func() error { return q.EraseDevices(ctx, uid) }},
			{"push tokens", func() error { return q.DeletePushTokens(ctx, uid) }},
			{"kyc identifiers", func() error { return q.DeleteKycIdentifiers(ctx, uid) }},
			{"kyc checks", func() error { return q.DeleteKycChecks(ctx, uid) }},
			{"kyc blobs", func() error { return q.DeleteKycBlobs(ctx, uid) }},
			{"kyc documents", func() error { return q.DeleteKycDocuments(ctx, uid) }},
			{"kyc submissions", func() error { return q.EraseKycSubmissions(ctx, uid) }},
			{"notifications", func() error { return q.DeleteNotifications(ctx, uid) }},
			{"notification preferences", func() error { return q.DeleteNotificationPreferences(ctx, uid) }},
			{"assistant messages", func() error { return q.DeleteAssistantMessages(ctx, uid) }},
			{"prepared actions", func() error { return q.DeletePreparedActions(ctx, uid) }},
			{"assistant conversations", func() error { return q.DeleteAssistantConversations(ctx, uid) }},
			{"support messages", func() error { return q.EraseSupportMessages(ctx, uid) }},
			{"support conversations", func() error { return q.EraseSupportConversations(ctx, uid) }},
			{"disputes", func() error { return q.EraseDisputes(ctx, uid) }},
			{"attachments", func() error { return q.DeleteAttachments(ctx, uid) }},
			{"beneficiaries", func() error { return q.DeleteBeneficiaries(ctx, uid) }},
			{"scheduled transfers", func() error { return q.DeleteScheduledTransfers(ctx, uid) }},
			{"payment links", func() error { return q.ClosePaymentLinks(ctx, uid) }},
			{"savings goals", func() error { return q.CloseSavingsGoals(ctx, uid) }},
			{"category corrections", func() error { return q.DeleteCategoryCorrections(ctx, uid) }},
			{"statements", func() error { return q.DeleteStatements(ctx, uid) }},
			{"fx alerts", func() error { return q.DeleteFxAlerts(ctx, uid) }},
			{"self limits", func() error { return q.DeleteSelfLimits(ctx, uid) }},
			{"staff notes", func() error { return q.DeleteStaffNotes(ctx, uid) }},
			{"cards", func() error { return q.TerminateCards(ctx, uid) }},
			{"api keys", func() error { return q.RevokeAPIKeys(ctx, uid) }},
			{"webhook endpoints", func() error { return q.DeleteWebhooks(ctx, uid) }},
			{"webhook deliveries", func() error { return q.ClearWebhookDeliveries(ctx, uid) }},
			{"exports", func() error { return q.DeleteOwnExports(ctx, uid) }},
			{"accounts", func() error { return q.CloseAccounts(ctx, uid) }},
			{"ledger labels", func() error { return q.RenameLedgerAccounts(ctx, &uid) }},
			{"profile", func() error { return q.EraseUser(ctx, privacydb.EraseUserParams{ID: uid, Now: now}) }},
		}
		for _, st := range steps {
			if err := st.run(); err != nil {
				return fmt.Errorf("erase %s: %w", st.name, err)
			}
		}
		// The log names the customer by ID only; it is part of what the law makes us keep.
		if _, err := audit.Append(ctx, tx, audit.Input{
			Actor: audit.Customer(uid), Action: "privacy.erase", ResourceType: "customer", ResourceID: uid.String(),
			Metadata: map[string]any{"request_id": id.String()},
		}, now); err != nil {
			return fmt.Errorf("audit erasure: %w", err)
		}
		return q.SetRequestStatus(ctx, privacydb.SetRequestStatusParams{ID: id, NewStatus: "completed", DoneAt: &now})
	})
}
