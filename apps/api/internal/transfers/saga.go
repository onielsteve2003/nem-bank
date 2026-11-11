package transfers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/accounts"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/jobs"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/transfers/partners"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/transfers/transfersdb"
)

// The interbank saga (TRF-7). Create has already held the money and moved the transfer to
// processing in the same transaction that queued the first two jobs below, so a crash at
// any point leaves work River will pick up again:
//
//	send   → the partner accepts the payment (idempotent by reference), then checks start
//	check  → a status query; settled or failed ends the saga, pending waits and asks again
//	deadline check → if the partner still has no answer, the hold is released (auto-reversal)
//
// A partner callback (POST /v1/partner-webhooks/{partner}) can end it sooner. Every way in
// takes the transfer's row lock and acts only on a processing transfer, so a callback and
// a check arriving together settle once.

// Saga defaults. The timeout must outlast the sandbox's longest delay (600 s).
const (
	DefaultSagaTimeout = 15 * time.Minute
	DefaultPollAfter   = 20 * time.Second
	maxPollInterval    = 2 * time.Minute
	// partnerCallTimeout bounds a send while the transfer's row is locked.
	partnerCallTimeout = 15 * time.Second
)

// SendArgs is the saga's first step: hand the payment to the partner.
type SendArgs struct {
	TransferID uuid.UUID `json:"transfer_id" river:"unique"`
}

// Kind implements river.JobArgs.
func (SendArgs) Kind() string { return "transfer_send" }

// InsertOpts implements river.JobArgsWithInsertOpts.
func (SendArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{UniqueOpts: river.UniqueOpts{ByArgs: true}}
}

// CheckArgs is a status query. Attempt 0 is the deadline check, queued with the transfer;
// 1, 2, ... are the polls after the send, each waiting longer.
type CheckArgs struct {
	TransferID uuid.UUID `json:"transfer_id" river:"unique"`
	Attempt    int       `json:"attempt" river:"unique"`
}

// Kind implements river.JobArgs.
func (CheckArgs) Kind() string { return "transfer_check" }

// InsertOpts implements river.JobArgsWithInsertOpts.
func (CheckArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{UniqueOpts: river.UniqueOpts{ByArgs: true}}
}

type sendWorker struct {
	river.WorkerDefaults[SendArgs]
	s *Service
}

func (w *sendWorker) Work(ctx context.Context, job *river.Job[SendArgs]) error {
	return w.s.SendExternal(ctx, job.Args.TransferID)
}

type checkWorker struct {
	river.WorkerDefaults[CheckArgs]
	s *Service
}

func (w *checkWorker) Work(ctx context.Context, job *river.Job[CheckArgs]) error {
	return w.s.CheckExternal(ctx, job.Args.TransferID, job.Args.Attempt)
}

// Register adds the saga's workers to the process's River workers (jobs.Options.Workers).
func (s *Service) Register(w *river.Workers) {
	river.AddWorker(w, &sendWorker{s: s})
	river.AddWorker(w, &checkWorker{s: s})
	river.AddWorker(w, &releaseWorker{s: s})
	river.AddWorker(w, &runWorker{s: s})
	river.AddWorker(w, &reconcileWorker{s: s})
}

// startSaga queues the send and the deadline check in Create's transaction.
func (s *Service) startSaga(ctx context.Context, tx pgx.Tx, t transfersdb.Transfer) error {
	if _, err := s.insert.InsertTx(ctx, tx, SendArgs{TransferID: t.ID}, nil); err != nil {
		return fmt.Errorf("queue transfer send: %w", err)
	}
	if _, err := s.insert.InsertTx(ctx, tx, CheckArgs{TransferID: t.ID}, &river.InsertOpts{ScheduledAt: *t.SagaDeadline}); err != nil {
		return fmt.Errorf("queue transfer deadline: %w", err)
	}
	return nil
}

// SendExternal hands a processing transfer to the partner. The row stays locked during the
// call, so the deadline check cannot give the money back while it is being sent.
func (s *Service) SendExternal(ctx context.Context, id uuid.UUID) error {
	var conclude *partners.Result
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		q := s.q.WithTx(tx)
		t, err := q.LockTransfer(ctx, id)
		if err != nil {
			return fmt.Errorf("lock transfer: %w", err)
		}
		if Status(t.Status) != Processing || t.DuressBlocked || t.PartnerReference != nil {
			return nil // already answered, never meant to leave, or already sent
		}
		if !s.now().Before(*t.SagaDeadline) {
			return nil // too late to send: the deadline check gives the money back
		}
		party, err := recipientOf(t)
		if err != nil {
			return err
		}
		callCtx, cancel := context.WithTimeout(ctx, partnerCallTimeout)
		defer cancel()
		sub, err := s.partner.Send(callCtx, partners.Payment{
			Reference: t.Reference, BankCode: *t.BankCode, AccountNumber: *t.AccountNumber, AccountName: party.Name,
			Amount: money.New(t.AmountMinor, money.Currency(t.Currency)), Narration: t.Narration,
		})
		if errors.Is(err, partners.ErrRejected) || errors.Is(err, partners.ErrAccountNotFound) {
			conclude = &partners.Result{State: partners.Failed, FailureCode: "rejected"}
			return nil
		}
		if err != nil {
			return fmt.Errorf("send transfer %s: %w", t.ID, err) // River retries with backoff
		}
		if err := q.SetPartnerReference(ctx, transfersdb.SetPartnerReferenceParams{ID: t.ID, PartnerReference: &sub.PartnerReference}); err != nil {
			return fmt.Errorf("save partner reference: %w", err)
		}
		return s.queueCheck(ctx, tx, t, 1)
	})
	if err != nil || conclude == nil {
		return err
	}
	_, err = s.Conclude(ctx, id, *conclude)
	return err
}

// queueCheck schedules poll attempt n, backing off from PollAfter, never past the deadline.
func (s *Service) queueCheck(ctx context.Context, tx pgx.Tx, t transfersdb.Transfer, n int) error {
	wait := s.pollAfter << min(n-1, 8)
	at := s.now().Add(min(wait, maxPollInterval))
	if at.After(*t.SagaDeadline) {
		return nil // the deadline check is already queued for then
	}
	if _, err := s.insert.InsertTx(ctx, tx, CheckArgs{TransferID: t.ID, Attempt: n}, &river.InsertOpts{ScheduledAt: at}); err != nil {
		return fmt.Errorf("queue transfer check: %w", err)
	}
	return nil
}

// CheckExternal asks the partner where a transfer stands and acts on the answer. Attempt 0
// is the deadline: no final answer by then means the money goes back. The status query runs
// under the row lock, so a send finishing at the same moment is seen before any reversal.
func (s *Service) CheckExternal(ctx context.Context, id uuid.UUID, attempt int) error {
	return pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		t, err := s.q.WithTx(tx).LockTransfer(ctx, id)
		if err != nil {
			return fmt.Errorf("lock transfer: %w", err)
		}
		if Status(t.Status) != Processing || t.DuressBlocked {
			return nil
		}
		callCtx, cancel := context.WithTimeout(ctx, partnerCallTimeout)
		defer cancel()
		r, err := s.partner.Status(callCtx, t.Reference)
		if err != nil {
			return fmt.Errorf("status of transfer %s: %w", t.ID, err) // River retries
		}
		if r.State.Final() {
			_, err := s.concludeTx(ctx, tx, t, r)
			return err
		}
		if attempt == 0 || !s.now().Before(*t.SagaDeadline) {
			// Unknown means it never reached the partner; pending past the deadline is a
			// partner that went quiet. Either way the customer gets their money back now,
			// and a settlement that still turns up later is flagged (concludeTx).
			_, err := s.concludeTx(ctx, tx, t, partners.Result{State: partners.Failed, FailureCode: "timeout"})
			return err
		}
		if t.PartnerReference == nil {
			return nil // the send job has not run yet; it queues the checks itself
		}
		return s.queueCheck(ctx, tx, t, attempt+1)
	})
}

// Outcomes of Conclude, also stored with each partner callback.
const (
	outcomeSettled        = "settled"
	outcomeReversed       = "reversed"
	outcomeAlreadyFinal   = "already_final"
	outcomeLateSettlement = "late_settlement"
	outcomeIgnored        = "ignored"
)

// Conclude ends a processing transfer with the partner's final answer.
func (s *Service) Conclude(ctx context.Context, id uuid.UUID, r partners.Result) (string, error) {
	var outcome string
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		t, err := s.q.WithTx(tx).LockTransfer(ctx, id)
		if err != nil {
			return fmt.Errorf("lock transfer: %w", err)
		}
		outcome, err = s.concludeTx(ctx, tx, t, r)
		return err
	})
	return outcome, err
}

// concludeTx is Conclude inside the caller's transaction, with t locked.
func (s *Service) concludeTx(ctx context.Context, tx pgx.Tx, t transfersdb.Transfer, r partners.Result) (string, error) {
	if Status(t.Status) != Processing || t.DuressBlocked {
		if r.State == partners.Settled && Status(t.Status) == Reversed {
			// The partner paid after we gave up and refunded: money left twice. Never
			// "fix" it here; reconciliation (T25.8) and finance recover it.
			s.log.ErrorContext(ctx, "partner settled a transfer the saga already reversed",
				slog.String("transfer_id", t.ID.String()), slog.String("partner", deref(t.Partner)))
			_, err := jobs.Write(ctx, tx, jobs.Event{
				Topic: "transfer.late_settlement", AggregateType: "transfer", AggregateID: t.ID.String(),
				Payload: map[string]any{"transfer_id": t.ID, "partner": deref(t.Partner), "amount_minor": t.AmountMinor, "currency": t.Currency},
			})
			return outcomeLateSettlement, err
		}
		return outcomeAlreadyFinal, nil
	}
	switch r.State {
	case partners.Settled:
		return outcomeSettled, s.settle(ctx, tx, t, r)
	case partners.Failed:
		return outcomeReversed, s.reverse(ctx, tx, t, r.FailureCode)
	default:
		return outcomeIgnored, nil
	}
}

// settle moves the held money to the partner's settlement account: the hold is captured
// by the same entry, so available never dips twice.
func (s *Service) settle(ctx context.Context, tx pgx.Tx, t transfersdb.Transfer, r partners.Result) error {
	q := s.q.WithTx(tx)
	party, err := recipientOf(t)
	if err != nil {
		return err
	}
	clearing, err := ledger.SystemAccount(ctx, tx, ledger.KindPartnerSettlement, t.Currency)
	if err != nil {
		return err
	}
	c := money.Currency(t.Currency)
	amount, fee := money.New(t.AmountMinor, c), money.New(t.FeeMinor, c)
	total, err := amount.Add(fee)
	if err != nil {
		return err
	}
	// The partner gets the amount; the fee is the bank's.
	legs := []ledger.Leg{ledger.Debit(t.SourceAccountID, total), ledger.Credit(clearing.ID, amount)}
	if fee.IsPositive() {
		income, err := ledger.SystemAccount(ctx, tx, ledger.KindFeeIncome, t.Currency)
		if err != nil {
			return err
		}
		legs = append(legs, ledger.Credit(income.ID, fee))
	}
	posted, err := ledger.Post(ctx, tx, ledger.Entry{
		Kind: "transfer_external", Reference: t.Reference, IdempotencyKey: "transfer:" + t.ID.String(),
		Metadata: map[string]any{"transfer_id": t.ID.String(), "partner": deref(t.Partner), "partner_reference": r.PartnerReference},
		Legs:     legs,
		Capture:  []uuid.UUID{*t.HoldID},
	})
	if err != nil {
		return fmt.Errorf("post settlement: %w", err)
	}
	if _, err := accounts.Settle(ctx, tx, t.TransactionID, "completed", &posted, t.SourceAccountID); err != nil {
		return err
	}
	if _, err := s.move(ctx, q, t, Completed, "Received by "+party.BankName, nil, &posted.EntryID); err != nil {
		return err
	}
	_, err = jobs.Write(ctx, tx, jobs.Event{
		Topic: "transfer.completed", AggregateType: "transfer", AggregateID: t.ID.String(),
		Payload: map[string]any{
			"transfer_id": t.ID, "user_id": t.UserID, "rail": "interbank", "amount_minor": t.AmountMinor, "currency": t.Currency,
		},
	})
	return err
}

// reverse gives the money back. Nothing was debited (only held), so the reversal is the
// hold released; the timeline shows both steps, as the mock bank does.
func (s *Service) reverse(ctx context.Context, tx pgx.Tx, t transfersdb.Transfer, code string) error {
	q := s.q.WithTx(tx)
	if err := ledger.ReleaseHold(ctx, tx, *t.HoldID); err != nil {
		return fmt.Errorf("release transfer hold: %w", err)
	}
	if err := s.releaseLimit(ctx, tx, t); err != nil {
		return err
	}
	reason := failureReason(code)
	t, err := s.move(ctx, q, t, Failed, "Transfer failed", &reason, nil)
	if err != nil {
		return err
	}
	if _, err := s.move(ctx, q, t, Reversed, "Money returned to your account", nil, nil); err != nil {
		return err
	}
	rev, err := json.Marshal(api.Reversal{Reason: reason, ReversedAt: s.now().UTC(), TransactionId: t.TransactionID})
	if err != nil {
		return fmt.Errorf("reversal: %w", err)
	}
	if err := q.SetTransferReversal(ctx, transfersdb.SetTransferReversalParams{ID: t.ID, Reversal: rev}); err != nil {
		return fmt.Errorf("save reversal: %w", err)
	}
	if _, err := accounts.Settle(ctx, tx, t.TransactionID, "failed", nil, t.SourceAccountID); err != nil {
		return err
	}
	_, err = jobs.Write(ctx, tx, jobs.Event{
		Topic: "transfer.failed", AggregateType: "transfer", AggregateID: t.ID.String(),
		Payload: map[string]any{
			"transfer_id": t.ID, "user_id": t.UserID, "rail": "interbank", "failure_code": code, "reversed": true,
			"amount_minor": t.AmountMinor, "currency": t.Currency,
		},
	})
	return err
}

// failureReason is what the customer reads on the timeline and in the notification.
func failureReason(code string) string {
	switch code {
	case "timeout":
		return "The recipient bank did not answer in time, so the transfer was stopped."
	case "rejected":
		return "The recipient bank refused this payment."
	case "57":
		return "The recipient bank does not allow this payment on that account."
	case "91":
		return "The recipient bank is not available right now. Try again later."
	default:
		return "The recipient bank could not take this payment."
	}
}

func recipientOf(t transfersdb.Transfer) (api.TransferParty, error) {
	var p api.TransferParty
	if err := json.Unmarshal(t.Recipient, &p); err != nil {
		return p, fmt.Errorf("recipient: %w", err)
	}
	return p, nil
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// errBadPartnerSignature is the one 401 for every bad callback, so an unsigned caller
// cannot tell which partners exist.
var errBadPartnerSignature = problem.New(http.StatusUnauthorized, "invalid_signature", "The callback signature is not valid.")

// VerifyPartnerCallback checks a callback's Partner-Signature against that partner's
// secret, before the body is trusted (the request validator calls it on the raw bytes).
func (s *Service) VerifyPartnerCallback(_ context.Context, partner, signature string, body []byte) error {
	secret, ok := s.secrets[partner]
	if !ok || partners.Verify(secret, signature, body, s.now()) != nil {
		return errBadPartnerSignature
	}
	return nil
}

// errDuplicateEvent rolls back the second handling of a callback.
var errDuplicateEvent = errors.New("transfers: partner event already handled")

// HandlePartnerCallback applies a verified callback once. The event is recorded in the
// same transaction as its effect, so a crash can never mark it handled without the money
// having moved, and a repeat finds the record and changes nothing.
func (s *Service) HandlePartnerCallback(ctx context.Context, partner, eventID string, cb api.PartnerCallback) (string, error) {
	var outcome string
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		q := s.q.WithTx(tx)
		outcome = outcomeIgnored
		var r *partners.Result
		switch cb.EventType {
		case api.PartnerCallbackEventTypeTransferSettled:
			r = &partners.Result{State: partners.Settled, At: cb.OccurredAt}
		case api.PartnerCallbackEventTypeTransferFailed:
			r = &partners.Result{State: partners.Failed, FailureCode: deref(cb.FailureCode), At: cb.OccurredAt}
		}
		if r != nil {
			if err := s.applyCallback(ctx, tx, partner, cb, *r, &outcome); err != nil {
				return err
			}
		}
		_, err := q.InsertPartnerWebhookEvent(ctx, transfersdb.InsertPartnerWebhookEventParams{
			Partner: partner, EventID: eventID, EventType: string(cb.EventType), Reference: cb.Reference, Outcome: outcome,
		})
		if errors.Is(err, pgx.ErrNoRows) {
			return errDuplicateEvent
		}
		if err != nil {
			return fmt.Errorf("record partner event: %w", err)
		}
		return nil
	})
	if errors.Is(err, errDuplicateEvent) {
		return outcomeAlreadyFinal, nil
	}
	return outcome, err
}

// applyCallback finds the callback's transfer and concludes it. A callback for a transfer
// on another partner, or for a different amount, moves nothing: the status checks, which
// ask the partner directly, still settle the transfer correctly.
func (s *Service) applyCallback(ctx context.Context, tx pgx.Tx, partner string, cb api.PartnerCallback, r partners.Result, outcome *string) error {
	q := s.q.WithTx(tx)
	t, err := q.GetTransferByReference(ctx, cb.Reference)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("load transfer by reference: %w", err)
	}
	if deref(t.Partner) != partner {
		s.log.WarnContext(ctx, "partner callback for a transfer on another rail", slog.String("partner", partner), slog.String("transfer_id", t.ID.String()))
		return nil
	}
	if cb.Amount != nil && (cb.Amount.AmountMinor != fmt.Sprint(t.AmountMinor) || string(cb.Amount.Currency) != t.Currency) {
		s.log.ErrorContext(ctx, "partner callback amount does not match the transfer", slog.String("transfer_id", t.ID.String()))
		return nil
	}
	if t, err = q.LockTransfer(ctx, t.ID); err != nil {
		return fmt.Errorf("lock transfer: %w", err)
	}
	*outcome, err = s.concludeTx(ctx, tx, t, r)
	return err
}
