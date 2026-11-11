package transfers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/accounts"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/accounts/accountsdb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/jobs"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/limits"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/transfers/transfersdb"
)

// StepUpPurpose is the step-up that confirms a waiting transfer (contract StepUpPurpose).
const StepUpPurpose = "transfer"

var (
	errNotWaiting   = problem.New(http.StatusConflict, "invalid_state", "This transfer does not need confirming")
	errNotCancelled = problem.New(http.StatusConflict, "invalid_state", "This transfer can no longer be cancelled")
)

// Request is a send-money request that has passed contract validation.
type Request struct {
	SourceAccountID uuid.UUID
	Destination     api.TransferDestination
	Amount          money.Money
	Narration       string
	Category        *string
	// SaveBeneficiary saves the destination as a beneficiary. This transfer still counts as
	// one to a new beneficiary.
	SaveBeneficiary bool
	// StepUpToken (purpose transfer) sends at once what the cooling-off would delay.
	StepUpToken string
	// MoneyRequestID or PaymentLinkID is what the transfer pays, if anything.
	MoneyRequestID, PaymentLinkID *uuid.UUID
}

// View is a transfer with its timeline.
type View struct {
	transfersdb.Transfer
	Timeline []transfersdb.TransferEvent
}

// plan is a transfer checked and priced, ready to commit. Everything slow (name enquiry
// at the other bank) happens while planning, outside the database transaction.
type plan struct {
	userID              uuid.UUID
	req                 Request
	sender              identity.CustomerProfile
	src                 accountsdb.GetCustomerAccountRow
	dest                target
	fee, total          money.Money
	narration, category string
	coolOff             identity.CoolOff
	// coolingOff: a first transfer above the threshold to a new beneficiary (TRF-8).
	coolingOff bool
	// land is where an internal transfer lands, read before the transaction.
	land *landing
}

// landing is what posting an internal transfer needs to know about both customers. It is
// read on the pool before the transaction opens: reading it inside would hold one
// connection while asking for another, and enough concurrent transfers would starve the
// pool.
type landing struct {
	receiver     accounts.Recipient
	receiverTier int
	sender       identity.CustomerProfile
	senderNumber string
}

// landingFor reads an internal transfer's landing; nil for the interbank rail.
func (s *Service) landingFor(ctx context.Context, t transfersdb.Transfer) (*landing, error) {
	if t.Rail != "internal" {
		return nil, nil //nolint:nilnil // no landing on the interbank rail
	}
	dst, err := s.accounts.RecipientByAccount(ctx, *t.DestinationAccountID)
	if err != nil {
		return nil, err
	}
	receiver, err := s.customers.CustomerProfile(ctx, dst.UserID)
	if err != nil {
		return nil, err
	}
	sender, err := s.customers.CustomerProfile(ctx, t.UserID)
	if err != nil {
		return nil, err
	}
	src, err := s.accounts.Owned(ctx, t.UserID, t.SourceAccountID)
	if err != nil {
		return nil, err
	}
	return &landing{receiver: dst, receiverTier: receiver.KycTier, sender: sender, senderNumber: src.AccountNumber}, nil
}

func (s *Service) prepare(ctx context.Context, userID uuid.UUID, r Request, coolOff identity.CoolOff) (plan, error) {
	sender, err := s.customers.CustomerProfile(ctx, userID)
	if err != nil {
		return plan{}, err
	}
	src, err := s.accounts.Owned(ctx, userID, r.SourceAccountID)
	if err != nil {
		return plan{}, err
	}
	if src.Currency != string(money.NGN) || r.Amount.Currency() != money.NGN {
		return plan{}, errNotNaira
	}
	if src.Status != "active" {
		return plan{}, errOutgoingBlocked
	}
	dest, err := s.resolve(ctx, userID, r.Destination)
	if err != nil {
		return plan{}, err
	}
	if dest.internal() && dest.nem.UserID == userID {
		return plan{}, errOwnAccount
	}
	fee := s.limits.Rules().TransferFee(r.Amount, dest.rail())
	total, err := r.Amount.Add(fee)
	if err != nil {
		return plan{}, err
	}
	narration := strings.TrimSpace(r.Narration)
	if narration == "" {
		narration = "Transfer to " + dest.party.Name
	}
	category := "transfers"
	if r.Category != nil {
		category = *r.Category
	}
	var land *landing
	if dest.internal() {
		receiver, err := s.customers.CustomerProfile(ctx, dest.nem.UserID)
		if err != nil {
			return plan{}, err
		}
		land = &landing{receiver: *dest.nem, receiverTier: receiver.KycTier, sender: sender, senderNumber: src.AccountNumber}
	}
	return plan{
		userID: userID, req: r, sender: sender, src: src, dest: dest, fee: fee, total: total, land: land,
		narration: narration, category: category, coolOff: coolOff,
		// Under duress it must look sent at once (SEC-5); nothing moves anyway.
		coolingOff: !sender.InDuress && s.isNew(dest.saved) && r.Amount.Amount() > s.limits.Rules().CoolingOffThresholdMinor,
	}, nil
}

// isNew reports whether a payee is still a new beneficiary: never saved, or saved within
// the cooling-off window and not yet paid.
func (s *Service) isNew(b *transfersdb.Beneficiary) bool {
	if b == nil {
		return true
	}
	return b.LastPaidAt == nil && b.CoolingOffUntil != nil && s.now().Before(*b.CoolingOffUntil)
}

// Create sends money. An internal transfer completes before it returns; an interbank one
// is held and the saga (saga.go) takes it on; a large first transfer to a new beneficiary
// waits out the cooling-off unless the request carries a step-up.
func (s *Service) Create(ctx context.Context, r Request) (View, error) {
	p, ok := identity.PrincipalFrom(ctx)
	if !ok {
		return View{}, problem.Unauthorized()
	}
	coolOff, err := s.customers.CoolOff(ctx)
	if err != nil {
		return View{}, err
	}
	pl, err := s.prepare(ctx, p.UserID, r, coolOff)
	if err != nil {
		return View{}, err
	}
	var id uuid.UUID
	if err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		id, err = s.commit(ctx, tx, pl)
		return err
	}); err != nil {
		return View{}, err
	}
	return s.view(ctx, p.UserID, id)
}

// commit writes a planned transfer in the caller's transaction and takes it as far as it
// can go now: completed, processing, delayed, or (under duress) a look-alike.
func (s *Service) commit(ctx context.Context, tx pgx.Tx, pl plan) (uuid.UUID, error) {
	q := s.q.WithTx(tx)
	delay := pl.coolingOff
	if delay && pl.req.StepUpToken != "" && s.stepUps != nil {
		err := s.stepUps.ConsumeStepUp(ctx, tx, pl.userID, StepUpPurpose, pl.req.StepUpToken)
		switch {
		case err == nil:
			delay = false
		case !errors.Is(err, identity.ErrStepUpRequired):
			return uuid.Nil, err
		}
	}
	ids, err := newIDs(2)
	if err != nil {
		return uuid.Nil, err
	}
	id, lineID := ids[0], ids[1]
	reference, err := newReference(s.now())
	if err != nil {
		return uuid.Nil, err
	}
	day, err := s.limits.Consume(ctx, tx, pl.userID, pl.sender.KycTier, pl.coolOff, pl.req.Amount)
	if err != nil {
		return uuid.Nil, err
	}
	dest := pl.dest
	party := api.Counterparty{
		Name: dest.party.Name, Nemtag: dest.party.Nemtag, BankName: &dest.party.BankName,
		AccountNumberMasked: &dest.party.AccountNumberMasked,
	}
	if _, err := accounts.Record(ctx, tx, accounts.Line{
		ID: lineID, UserID: pl.userID, AccountID: pl.src.AccountID, Type: "transfer_out", Direction: "debit",
		Status: "pending", Amount: pl.req.Amount, Fee: &pl.fee, FeeCode: "transfer_fee", Narration: pl.narration,
		Reference: reference, Category: pl.category, Counterparty: party, TransferID: &id,
	}); err != nil {
		return uuid.Nil, err
	}
	if pl.req.SaveBeneficiary && dest.saved == nil {
		b, saved, err := s.saveBeneficiary(ctx, q, pl.userID, dest, false, nil)
		if err != nil {
			return uuid.Nil, err
		}
		if saved {
			dest.saved = &b
		}
	}
	recipientJSON, err := json.Marshal(dest.party)
	if err != nil {
		return uuid.Nil, fmt.Errorf("recipient: %w", err)
	}

	in := transfersdb.InsertTransferParams{
		ID: id, UserID: pl.userID, Reference: reference, Rail: dest.rail(), SourceAccountID: pl.src.AccountID,
		Recipient: recipientJSON, Currency: string(money.NGN), AmountMinor: pl.req.Amount.Amount(), FeeMinor: pl.fee.Amount(),
		Narration: pl.narration, Category: &pl.category, TransactionID: lineID, DuressBlocked: pl.sender.InDuress,
		LimitDay: &day, MoneyRequestID: pl.req.MoneyRequestID, PaymentLinkID: pl.req.PaymentLinkID,
	}
	if dest.saved != nil {
		in.BeneficiaryID = &dest.saved.ID
	}
	if dest.internal() {
		in.DestinationAccountID = &dest.nem.AccountID
	} else {
		deadline := s.now().Add(s.sagaTimeout)
		partner := s.partner.Name()
		in.Partner, in.SagaDeadline = &partner, &deadline
		in.BankCode, in.AccountNumber = &dest.bank.Code, &dest.account.AccountNumber
	}
	// The money (and fee) is set aside while it waits: for the partner, or the cooling-off.
	if !pl.sender.InDuress && (!dest.internal() || delay) {
		reason := "pending_transfer"
		if delay {
			reason = "delayed_transfer"
		}
		hold, err := ledger.PlaceHold(ctx, tx, ledger.Hold{Account: pl.src.AccountID, Amount: pl.total, Reference: id.String(), Reason: reason})
		if errors.Is(err, ledger.ErrInsufficientFunds) {
			return uuid.Nil, insufficient(pl.total)
		}
		if err != nil {
			return uuid.Nil, fmt.Errorf("hold transfer: %w", err)
		}
		in.HoldID = &hold.ID
	}
	if delay {
		at := s.now().Add(s.limits.Rules().CoolingOffDelay)
		in.ReleaseAt = &at
	}
	t, err := q.InsertTransfer(ctx, in)
	if err != nil {
		return uuid.Nil, fmt.Errorf("insert transfer: %w", err)
	}
	if err := event(ctx, q, id, Created, "Transfer created", nil); err != nil {
		return uuid.Nil, err
	}
	// Risk scoring arrives with the fraud model (M29); every check before this point
	// (ownership, currency, account state, recipient, limits) is what "checked" means today.
	if t, err = s.move(ctx, q, t, RiskChecked, "Security checks done", nil, nil); err != nil {
		return uuid.Nil, err
	}

	switch {
	case pl.sender.InDuress:
		// SEC-5: it must look sent, so the decoy balance is what it may spend, and no money
		// moves. The customer's real PIN marks it stopped (StopDuressTransfers).
		bal, err := ledger.GetBalances(ctx, tx, pl.src.AccountID)
		if err != nil {
			return uuid.Nil, err
		}
		if accounts.Decoy(bal.Available).Amount() < pl.total.Amount() {
			return uuid.Nil, insufficient(pl.total)
		}
		_, err = s.move(ctx, q, t, Processing, "Sent to "+dest.party.BankName, nil, nil)
		return id, err
	case delay:
		minutes := int(s.limits.Rules().CoolingOffDelay / time.Minute)
		detail := "Confirm with your PIN or OTP to send it now, or cancel it before then."
		if _, err := s.move(ctx, q, t, Delayed, fmt.Sprintf("New beneficiary: sends in %d minutes", minutes), &detail, nil); err != nil {
			return uuid.Nil, err
		}
		if _, err := s.insert.InsertTx(ctx, tx, ReleaseArgs{TransferID: id}, &river.InsertOpts{ScheduledAt: *in.ReleaseAt}); err != nil {
			return uuid.Nil, fmt.Errorf("queue transfer release: %w", err)
		}
		return id, nil
	default:
		return id, s.proceed(ctx, tx, t, pl.land)
	}
}

// proceed moves the money of a transfer that may go now: instantly on the internal rail,
// into the saga on the interbank one. It works from the stored transfer alone, so a
// release or a step-up minutes later takes the same path as an immediate send.
func (s *Service) proceed(ctx context.Context, tx pgx.Tx, t transfersdb.Transfer, land *landing) error {
	q := s.q.WithTx(tx)
	if t.Rail == "interbank" {
		party, err := recipientOf(t)
		if err != nil {
			return err
		}
		if Status(t.Status) != RiskChecked {
			// It waited: the partner gets its full time from now.
			deadline := s.now().Add(s.sagaTimeout)
			if err := q.SetSagaDeadline(ctx, transfersdb.SetSagaDeadlineParams{ID: t.ID, SagaDeadline: &deadline}); err != nil {
				return fmt.Errorf("set saga deadline: %w", err)
			}
			t.SagaDeadline = &deadline
		}
		if t, err = s.move(ctx, q, t, Processing, "Sent to "+party.BankName, nil, nil); err != nil {
			return err
		}
		if err := s.startSaga(ctx, tx, t); err != nil {
			return err
		}
	} else if err := s.completeInternal(ctx, tx, t, land); err != nil {
		return err
	}
	if t.BeneficiaryID != nil {
		if err := q.MarkBeneficiaryPaid(ctx, transfersdb.MarkBeneficiaryPaidParams{ID: *t.BeneficiaryID, At: ptr(s.now())}); err != nil {
			return fmt.Errorf("mark beneficiary paid: %w", err)
		}
	}
	return nil
}

func ptr[T any](v T) *T { return &v }

// completeInternal posts a Nem-to-Nem transfer: the sender's line settles, the receiver
// gets theirs less any EMTL, and both see it at once.
func (s *Service) completeInternal(ctx context.Context, tx pgx.Tx, t transfersdb.Transfer, land *landing) error {
	q := s.q.WithTx(tx)
	dst, sender := land.receiver, land.sender
	amount := money.New(t.AmountMinor, money.NGN)
	levy := s.limits.Rules().EMTL(amount)
	legs, err := internalLegs(ctx, tx, t.SourceAccountID, dst.AccountID, amount, levy)
	if err != nil {
		return err
	}
	entry := ledger.Entry{
		Kind: "transfer_internal", Reference: t.Reference, IdempotencyKey: "transfer:" + t.ID.String(),
		Metadata: map[string]any{"transfer_id": t.ID.String()}, Legs: legs,
	}
	if t.HoldID != nil { // it waited: the held money pays for it
		entry.Capture = []uuid.UUID{*t.HoldID}
	}
	posted, err := ledger.Post(ctx, tx, entry)
	if errors.Is(err, ledger.ErrInsufficientFunds) {
		return insufficient(amount)
	}
	if err != nil {
		return fmt.Errorf("post transfer: %w", err)
	}
	// The receiver's KYC balance cap, checked on the balance the posting produced (the
	// account row was locked by it), so concurrent credits cannot slip past it together.
	if capMinor := s.limits.Rules().Tier(land.receiverTier).MaxBalanceMinor; capMinor > 0 && balanceAfter(posted, dst.AccountID) > capMinor {
		return errMaxBalance
	}
	if _, err := accounts.Settle(ctx, tx, t.TransactionID, "completed", &posted, t.SourceAccountID); err != nil {
		return err
	}
	senderNumber := accounts.MaskNumber(land.senderNumber)
	bankName := accounts.BankName
	if _, err := accounts.Record(ctx, tx, accounts.Line{
		UserID: dst.UserID, AccountID: dst.AccountID, Type: "transfer_in", Direction: "credit", Status: "completed",
		Amount: amount, Fee: &levy, FeeCode: "emtl", Entry: &posted, Narration: t.Narration, Reference: t.Reference, Category: "transfers",
		Counterparty: api.Counterparty{Name: sender.Name, Nemtag: sender.Nemtag, BankName: &bankName, AccountNumberMasked: &senderNumber},
	}); err != nil {
		return err
	}
	if _, err := s.move(ctx, q, t, Completed, "Sent instantly", nil, &posted.EntryID); err != nil {
		return err
	}
	_, err = jobs.Write(ctx, tx, jobs.Event{
		Topic: "transfer.completed", AggregateType: "transfer", AggregateID: t.ID.String(),
		Payload: map[string]any{
			"transfer_id": t.ID, "user_id": t.UserID, "recipient_user_id": dst.UserID, "rail": "internal", "source_account_id": t.SourceAccountID,
			"amount_minor": t.AmountMinor, "currency": t.Currency,
		},
	})
	return err
}

// resolve finds where the money goes, and the customer's beneficiary for it if saved.
func (s *Service) resolve(ctx context.Context, userID uuid.UUID, d api.TransferDestination) (target, error) {
	kind, err := d.Discriminator()
	if err != nil {
		return target{}, fmt.Errorf("destination: %w", err)
	}
	if kind == "beneficiary" {
		bd, err := d.AsBeneficiaryDestination()
		if err != nil {
			return target{}, fmt.Errorf("destination: %w", err)
		}
		b, err := s.q.GetBeneficiary(ctx, transfersdb.GetBeneficiaryParams{ID: bd.BeneficiaryId, UserID: userID})
		if errors.Is(err, pgx.ErrNoRows) {
			return target{}, ErrBeneficiaryNotFound
		}
		if err != nil {
			return target{}, fmt.Errorf("load beneficiary: %w", err)
		}
		dest, err := beneficiaryDestination(b)
		if err != nil {
			return target{}, err
		}
		t, err := s.resolveAccount(ctx, dest)
		if err != nil {
			return target{}, err
		}
		t.saved = &b
		return t, nil
	}
	t, err := s.resolveAccount(ctx, d)
	if err != nil {
		return target{}, err
	}
	b, err := s.q.FindBeneficiary(ctx, transfersdb.FindBeneficiaryParams{UserID: userID, BankCode: t.party.BankCode, AccountNumber: t.accountNumber()})
	switch {
	case err == nil:
		t.saved = &b
	case !errors.Is(err, pgx.ErrNoRows):
		return target{}, fmt.Errorf("find beneficiary: %w", err)
	}
	return t, nil
}

// accountNumber is the target's full account number.
func (d target) accountNumber() string {
	if d.internal() {
		return d.nem.AccountNumber
	}
	return d.account.AccountNumber
}

// destination is the target as a Nem or bank destination, which a schedule stores.
func (d target) destination() (api.TransferDestination, error) {
	var out api.TransferDestination
	var err error
	if d.internal() {
		err = out.FromNemDestination(api.NemDestination{Kind: "nem", AccountNumber: d.nem.AccountNumber})
	} else {
		err = out.FromBankDestination(api.BankDestination{Kind: "bank", BankCode: d.bank.Code, AccountNumber: d.account.AccountNumber, AccountName: d.party.Name})
	}
	if err != nil {
		return out, fmt.Errorf("destination: %w", err)
	}
	return out, nil
}

// ReleaseArgs releases a delayed transfer when its cooling-off ends.
type ReleaseArgs struct {
	TransferID uuid.UUID `json:"transfer_id" river:"unique"`
}

// Kind implements river.JobArgs.
func (ReleaseArgs) Kind() string { return "transfer_release" }

// InsertOpts implements river.JobArgsWithInsertOpts.
func (ReleaseArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{UniqueOpts: river.UniqueOpts{ByArgs: true}}
}

type releaseWorker struct {
	river.WorkerDefaults[ReleaseArgs]
	s *Service
}

func (w *releaseWorker) Work(ctx context.Context, job *river.Job[ReleaseArgs]) error {
	return w.s.Release(ctx, job.Args.TransferID)
}

// Release sends a delayed transfer whose cooling-off is over. One the customer already
// confirmed or cancelled is left alone. If it can no longer go (the receiver hit their
// balance cap meanwhile), it is cancelled and the money given back.
func (s *Service) Release(ctx context.Context, id uuid.UUID) error {
	pre, err := s.q.GetTransferByID(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && Status(pre.Status) != Delayed) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("load transfer: %w", err)
	}
	land, err := s.landingFor(ctx, pre)
	if err != nil {
		return err
	}
	return pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		q := s.q.WithTx(tx)
		t, err := q.LockTransfer(ctx, id)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("lock transfer: %w", err)
		}
		if Status(t.Status) != Delayed {
			return nil
		}
		if t.ReleaseAt != nil && s.now().Before(*t.ReleaseAt) {
			return river.JobSnooze(t.ReleaseAt.Sub(s.now()))
		}
		if err := event(ctx, q, id, "released", "Cooling-off ended", nil); err != nil {
			return err
		}
		sp, err := tx.Begin(ctx)
		if err != nil {
			return fmt.Errorf("savepoint: %w", err)
		}
		err = s.proceed(ctx, sp, t, land)
		var p *problem.Error
		if err != nil && errors.As(err, &p) {
			if rerr := sp.Rollback(ctx); rerr != nil {
				return fmt.Errorf("rollback to savepoint: %w", rerr)
			}
			detail := p.Title
			return s.cancel(ctx, tx, t, "Could not be sent", &detail)
		}
		if err != nil {
			return err
		}
		return sp.Commit(ctx)
	})
}

// StepUp sends a transfer waiting for the customer (pending step-up or cooling-off) once
// they confirm it is them.
func (s *Service) StepUp(ctx context.Context, id uuid.UUID, token string) (View, error) {
	p, ok := identity.PrincipalFrom(ctx)
	if !ok {
		return View{}, problem.Unauthorized()
	}
	pre, err := s.q.GetTransfer(ctx, transfersdb.GetTransferParams{ID: id, UserID: p.UserID})
	if errors.Is(err, pgx.ErrNoRows) {
		return View{}, ErrTransferNotFound
	}
	if err != nil {
		return View{}, fmt.Errorf("load transfer: %w", err)
	}
	land, err := s.landingFor(ctx, pre)
	if err != nil {
		return View{}, err
	}
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		q := s.q.WithTx(tx)
		t, err := s.lockOwn(ctx, q, p.UserID, id)
		if err != nil {
			return err
		}
		if st := Status(t.Status); st != PendingStepUp && st != Delayed {
			return errNotWaiting
		}
		if s.stepUps == nil {
			return identity.ErrStepUpRequired
		}
		if err := s.stepUps.ConsumeStepUp(ctx, tx, p.UserID, StepUpPurpose, token); err != nil {
			return err
		}
		if err := event(ctx, q, id, "stepped_up", "Confirmed by you", nil); err != nil {
			return err
		}
		return s.proceed(ctx, tx, t, land)
	})
	if err != nil {
		return View{}, err
	}
	return s.view(ctx, p.UserID, id)
}

// Cancel stops a transfer that has not gone yet and gives its money and limit back.
func (s *Service) Cancel(ctx context.Context, id uuid.UUID) (View, error) {
	p, ok := identity.PrincipalFrom(ctx)
	if !ok {
		return View{}, problem.Unauthorized()
	}
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		t, err := s.lockOwn(ctx, s.q.WithTx(tx), p.UserID, id)
		if err != nil {
			return err
		}
		switch Status(t.Status) {
		case Cancelled:
			return nil
		case PendingStepUp, Delayed, HeldForReview:
			return s.cancel(ctx, tx, t, "Cancelled by you", nil)
		default:
			return errNotCancelled
		}
	})
	if err != nil {
		return View{}, err
	}
	return s.view(ctx, p.UserID, id)
}

func (s *Service) lockOwn(ctx context.Context, q *transfersdb.Queries, userID, id uuid.UUID) (transfersdb.Transfer, error) {
	t, err := q.LockTransfer(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && t.UserID != userID) {
		return t, ErrTransferNotFound
	}
	if err != nil {
		return t, fmt.Errorf("lock transfer: %w", err)
	}
	return t, nil
}

// cancel ends a waiting transfer: hold released, limit given back, line failed.
func (s *Service) cancel(ctx context.Context, tx pgx.Tx, t transfersdb.Transfer, label string, detail *string) error {
	if t.HoldID != nil {
		if err := ledger.ReleaseHold(ctx, tx, *t.HoldID); err != nil {
			return fmt.Errorf("release transfer hold: %w", err)
		}
	}
	if err := s.releaseLimit(ctx, tx, t); err != nil {
		return err
	}
	if _, err := s.move(ctx, s.q.WithTx(tx), t, Cancelled, label, detail, nil); err != nil {
		return err
	}
	_, err := accounts.Settle(ctx, tx, t.TransactionID, "failed", nil, t.SourceAccountID)
	return err
}

// QuoteTTL is how long a quote is shown as valid; the transfer re-prices when sent.
const QuoteTTL = 5 * time.Minute

// Quote is a transfer priced before the customer confirms (TRF-4, TRF-8).
type Quote struct {
	ID          uuid.UUID
	Amount, Fee money.Money
	// Fees lists what makes up Fee, by contract FeeLine code.
	Fees   []FeeLine
	Total  money.Money
	Limits limits.Status
	// CoolingOff is the wait (or step-up) the transfer would meet, if any.
	CoolingOff *api.CoolingOff
	Rail       string
	Expires    time.Time
}

// FeeLine is one charge on a quote.
type FeeLine struct {
	Code, Label string
	Amount      money.Money
}

// Quote prices a transfer with the rules Create applies: the fee, the customer's standing
// against today's limits and any cooling-off. Nothing is reserved.
func (s *Service) Quote(ctx context.Context, r Request) (Quote, error) {
	p, ok := identity.PrincipalFrom(ctx)
	if !ok {
		return Quote{}, problem.Unauthorized()
	}
	coolOff, err := s.customers.CoolOff(ctx)
	if err != nil {
		return Quote{}, err
	}
	pl, err := s.prepare(ctx, p.UserID, r, coolOff)
	if err != nil {
		return Quote{}, err
	}
	st, err := s.limits.StatusFor(ctx, s.pool, p.UserID, pl.sender.KycTier, coolOff)
	if err != nil {
		return Quote{}, err
	}
	id, err := uuid.NewV7()
	if err != nil {
		return Quote{}, fmt.Errorf("quote id: %w", err)
	}
	q := Quote{
		ID: id, Amount: r.Amount, Fee: pl.fee, Fees: []FeeLine{}, Total: pl.total, Limits: st,
		Rail: pl.dest.rail(), Expires: s.now().Add(QuoteTTL),
	}
	if pl.fee.IsPositive() {
		q.Fees = append(q.Fees, FeeLine{Code: "transfer_fee", Label: "Transfer fee", Amount: pl.fee})
	}
	switch {
	case pl.coolingOff:
		q.CoolingOff = &api.CoolingOff{
			Reason: api.CoolingOffReason("new_beneficiary"), DelayMinutes: int(s.limits.Rules().CoolingOffDelay / time.Minute), StepUpSkipsDelay: true,
		}
	case coolOff.Active:
		// AUTH-8: transfers from a new device are capped lower and stepped up; no delay.
		q.CoolingOff = &api.CoolingOff{Reason: api.CoolingOffReason(coolOff.Reason), StepUpSkipsDelay: true}
	}
	return q, nil
}
