package transfers

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/accounts"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/jobs"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/transfers/transfersdb"
)

// TopicLinkPaid is the outbox event for a payment link taking a payment; developer webhooks
// (payment_link.paid) listen to it.
const TopicLinkPaid = "payment_link.paid"

// LinkJSONByID is the contract's PaymentLink for any customer's link, for webhook payloads.
func (s *Service) LinkJSONByID(ctx context.Context, id uuid.UUID) (api.PaymentLink, error) {
	l, err := s.q.GetPaymentLinkByID(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return api.PaymentLink{}, ErrLinkNotFound
	}
	if err != nil {
		return api.PaymentLink{}, fmt.Errorf("load payment link: %w", err)
	}
	return s.LinkJSON(l), nil
}

// SandboxLinkPayment is a payer in the sandbox paying one of the owner's payment links, so a
// developer can test webhooks end to end (DEV-2). The money comes from the bank's demo funding
// account, not from a customer, so it is not a real transfer: the owner's account is credited
// with a normal history line, the link counts the payment, and the same events fire as for a
// real payment. The returned Transfer is described, not stored (it has no row of its own).
func (s *Service) SandboxLinkPayment(ctx context.Context, ownerID, linkID uuid.UUID, amount *api.Money, payer string) (api.Transfer, error) {
	payer = strings.TrimSpace(payer)
	if payer == "" {
		payer = "Sandbox Payer"
	}
	if utf8.RuneCountInString(payer) > 60 {
		return api.Transfer{}, problem.Validation(problem.Field("/payer_name", "length", "Use at most 60 characters."))
	}
	now := s.now().UTC()
	var out api.Transfer
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		q := s.q.WithTx(tx)
		link, err := q.LockPaymentLinkByID(ctx, transfersdb.LockPaymentLinkByIDParams{ID: linkID, UserID: ownerID})
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrLinkNotFound
		}
		if err != nil {
			return fmt.Errorf("lock payment link: %w", err)
		}
		if s.linkStatus(link) != "active" {
			return errLinkClosed
		}
		var pay money.Money
		if link.AmountMode == "fixed" {
			pay = money.New(*link.AmountMinor, money.NGN)
		} else {
			if amount == nil {
				return errOpenNeedsAmt
			}
			if pay, err = money.ParseMinor(amount.AmountMinor, string(amount.Currency)); err != nil || pay.Currency() != money.NGN || !pay.IsPositive() {
				return problem.Validation(problem.Field("/amount", "invalid", "Give a naira amount above zero."))
			}
		}
		src, err := ledger.SystemAccount(ctx, tx, ledger.KindDemoFunding, string(money.NGN))
		if err != nil {
			return err
		}
		ref, err := newReference(now)
		if err != nil {
			return err
		}
		posted, err := ledger.Post(ctx, tx, ledger.Entry{
			Kind: "demo_funding", Reference: ref, Metadata: map[string]any{"sandbox": true, "payment_link_id": link.ID.String()},
			Legs: []ledger.Leg{ledger.Debit(src.ID, pay), ledger.Credit(link.AccountID, pay)},
		})
		if err != nil {
			return fmt.Errorf("post sandbox payment: %w", err)
		}
		line, err := accounts.Record(ctx, tx, accounts.Line{
			UserID: ownerID, AccountID: link.AccountID, Type: "transfer_in", Direction: "credit", Status: "completed",
			Amount: pay, Entry: &posted, Narration: link.Title, Reference: ref, Category: "transfers",
			Counterparty: api.Counterparty{Name: payer}, At: now,
		})
		if err != nil {
			return err
		}
		if err := q.CountLinkPayment(ctx, transfersdb.CountLinkPaymentParams{ID: link.ID, AmountMinor: pay.Amount()}); err != nil {
			return fmt.Errorf("count link payment: %w", err)
		}
		if _, err := jobs.Write(ctx, tx, jobs.Event{
			Topic: TopicLinkPaid, AggregateType: "payment_link", AggregateID: link.ID.String(),
			Payload: map[string]any{"payment_link_id": link.ID, "user_id": ownerID, "amount_minor": pay.Amount(), "currency": string(pay.Currency()), "sandbox": true},
		}); err != nil {
			return fmt.Errorf("write %s event: %w", TopicLinkPaid, err)
		}
		out = api.Transfer{
			Id: posted.EntryID, Reference: ref, Status: "completed", Rail: "internal", SourceAccountId: src.ID,
			Recipient: api.TransferParty{Name: link.Title}, Amount: accounts.Money(pay), Fee: accounts.Money(money.Zero(money.NGN)),
			TotalDebit: accounts.Money(pay), Narration: link.Title, TransactionId: &line.ID, CreatedAt: now, UpdatedAt: now,
			Timeline: []api.TimelineEvent{{Status: "completed", Label: "Paid by " + payer + " (sandbox)", At: now}},
		}
		return nil
	})
	return out, err
}
