package demo

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/accounts"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/accounts/accountsdb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/audit"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/kyc"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/kyc/kycdb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/limits"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
)

var (
	errNotDemo    = problem.Forbidden().WithDetail("Demo controls are only for demo users.")
	errMaxBalance = problem.New(http.StatusUnprocessableEntity, "max_balance_exceeded", "This would take you over your balance limit").
			WithDetail("Upgrade your KYC tier to hold more.")
)

// demoReviewer signs the sandbox reviewer's decisions in the audit log and on the submission.
var demoReviewer = uuid.MustParse("00000000-0000-7000-8000-000000000d3e")

// Rules supplies the tier balance caps; *limits.Service implements it.
type Rules interface{ Rules() limits.Rules }

// Reviewer rules on a Tier 3 submission; *kyc.Service implements it.
type Reviewer interface {
	Decide(ctx context.Context, d kyc.Decision) (kycdb.KycSubmission, error)
}

// caller returns the signed-in demo customer, or the 403 every other customer gets.
func (s *Service) caller(ctx context.Context) (identity.Principal, int16, error) {
	p, ok := identity.PrincipalFrom(ctx)
	if !ok {
		return identity.Principal{}, 0, problem.Unauthorized()
	}
	var demo bool
	var tier int16
	if err := s.pool.QueryRow(ctx, `SELECT is_demo, kyc_tier FROM users WHERE id = $1`, p.UserID).Scan(&demo, &tier); err != nil {
		return identity.Principal{}, 0, fmt.Errorf("load caller: %w", err)
	}
	if !demo {
		return identity.Principal{}, 0, errNotDemo
	}
	return p, tier, nil
}

// Fund adds demo money to one of the caller's accounts from the bank's demo funding account
// (DEMO-1). The tier's balance cap still applies to naira, so the demo cannot show a Tier 1
// customer holding more than the rules allow.
func (s *Service) Fund(ctx context.Context, account uuid.UUID, amount money.Money) (accountsdb.Transaction, error) {
	p, tier, err := s.caller(ctx)
	if err != nil {
		return accountsdb.Transaction{}, err
	}
	if !amount.IsPositive() {
		return accountsdb.Transaction{}, problem.Validation(problem.Field("/amount", "positive", "Enter an amount above zero."))
	}
	acc, err := accountsdb.New(s.pool).GetCustomerAccountByID(ctx, account)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && acc.UserID != p.UserID) {
		return accountsdb.Transaction{}, problem.NotFound("Account")
	}
	if err != nil {
		return accountsdb.Transaction{}, fmt.Errorf("load account: %w", err)
	}
	if amount.Currency() != money.Currency(acc.Currency) {
		return accountsdb.Transaction{}, problem.Validation(problem.Field("/amount/currency", "currency_mismatch", "This amount must be in "+acc.Currency+"."))
	}
	var balanceCap int64
	if acc.Currency == string(money.NGN) {
		balanceCap = s.rules.Rules().Tier(int(tier)).MaxBalanceMinor
	}
	var out accountsdb.Transaction
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		src, err := ledger.SystemAccount(ctx, tx, ledger.KindDemoFunding, acc.Currency)
		if err != nil {
			return err
		}
		ref := "DEMO-" + strings.ToUpper(strings.ReplaceAll(uuid.NewString(), "-", "")[:12])
		posted, err := ledger.Post(ctx, tx, ledger.Entry{
			Kind: "demo_funding", Reference: ref,
			Legs: []ledger.Leg{ledger.Debit(src.ID, amount), ledger.Credit(acc.AccountID, amount)},
		})
		if err != nil {
			return fmt.Errorf("post demo funding: %w", err)
		}
		if after := accounts.BalanceAfter(posted, acc.AccountID); balanceCap > 0 && after != nil && *after > balanceCap {
			return errMaxBalance
		}
		out, err = accounts.Record(ctx, tx, accounts.Line{
			UserID: p.UserID, AccountID: acc.AccountID, Type: "deposit", Direction: "credit", Status: "completed",
			Amount: amount, Entry: &posted, Narration: "Demo money added", Reference: ref, Category: "other",
			Counterparty: api.Counterparty{Name: "Demo Controls"},
		})
		return err
	})
	return out, err
}

// SetKycTier puts the caller on a tier so the upgrade flows can be walked again. Going down
// clears what sits above the new tier: Tier 3 submissions and documents below Tier 3, and
// the BVN/NIN checks below Tier 2. Going up just sets the tier.
func (s *Service) SetKycTier(ctx context.Context, tier int16) error {
	p, _, err := s.caller(ctx)
	if err != nil {
		return err
	}
	if tier < 1 || tier > 3 {
		return problem.Validation(problem.Field("/tier", "invalid", "Choose tier 1, 2 or 3."))
	}
	status := "not_started"
	if tier == 3 {
		status = "approved"
	}
	return pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `UPDATE users SET kyc_tier = $2, kyc_status = $3, demo_kyc_review = NULL WHERE id = $1`, p.UserID, tier, status); err != nil {
			return fmt.Errorf("set demo kyc tier: %w", err)
		}
		var wipe []string
		if tier < 3 {
			wipe = append(wipe,
				`DELETE FROM kyc_submissions WHERE user_id = $1`,
				`DELETE FROM kyc_document_blobs WHERE document_id IN (SELECT id FROM kyc_documents WHERE user_id = $1)`,
				`DELETE FROM kyc_documents WHERE user_id = $1`)
		}
		if tier < 2 {
			wipe = append(wipe,
				`DELETE FROM kyc_identity_checks WHERE user_id = $1`,
				`DELETE FROM kyc_identifiers WHERE user_id = $1`)
		}
		for _, q := range wipe {
			if _, err := tx.Exec(ctx, q, p.UserID); err != nil {
				return fmt.Errorf("wipe demo kyc: %w", err)
			}
		}
		_, err := audit.Append(ctx, tx, audit.Input{
			Actor: audit.Customer(p.UserID), Action: "demo.kyc_tier", ResourceType: "user", ResourceID: p.UserID.String(),
			Metadata: map[string]any{"tier": tier},
		}, s.now())
		return err
	})
}

// FailNextTransfer arms the one-shot: the caller's next bank transfer fails at the partner
// and is reversed (TRF-7).
func (s *Service) FailNextTransfer(ctx context.Context) error {
	p, _, err := s.caller(ctx)
	if err != nil {
		return err
	}
	_, err = s.pool.Exec(ctx, `UPDATE users SET demo_fail_next = true WHERE id = $1`, p.UserID)
	return err
}

// ConsumeFailNext is the sandbox bank's question before it draws a payment's fate: did the
// demo arm a failure for the customer behind this transfer reference? Answering yes spends it.
func (s *Service) ConsumeFailNext(ctx context.Context, reference string) bool {
	var armed bool
	err := s.pool.QueryRow(ctx, `
		UPDATE users u SET demo_fail_next = false
		FROM transfers t
		WHERE t.reference = $1 AND t.user_id = u.id AND u.is_demo AND u.demo_fail_next
		RETURNING true`, reference).Scan(&armed)
	return err == nil && armed
}

// SetKycReview chooses how the sandbox reviewer rules on the caller's next Tier 3 submission.
func (s *Service) SetKycReview(ctx context.Context, outcome string) error {
	p, _, err := s.caller(ctx)
	if err != nil {
		return err
	}
	switch outcome {
	case "approve", "reject", "resubmit":
	default:
		return problem.Validation(problem.Field("/outcome", "invalid", "Choose approve, reject or resubmit."))
	}
	_, err = s.pool.Exec(ctx, `UPDATE users SET demo_kyc_review = $2 WHERE id = $1`, p.UserID, outcome)
	return err
}

// AutoReview runs after a Tier 3 submission is stored: a demo customer who chose an outcome
// gets it at once, as the sandbox reviewer, and the choice is used up. Anyone else waits for
// staff as normal.
func (s *Service) AutoReview(ctx context.Context, userID, submissionID uuid.UUID) error {
	var outcome *string
	// The CTE reads the flag before the update clears it; RETURNING alone would show NULL.
	err := s.pool.QueryRow(ctx, `
		WITH chosen AS (SELECT demo_kyc_review FROM users WHERE id = $1 AND is_demo FOR UPDATE),
		     cleared AS (UPDATE users SET demo_kyc_review = NULL WHERE id = $1 AND demo_kyc_review IS NOT NULL RETURNING id)
		SELECT demo_kyc_review FROM chosen`, userID).Scan(&outcome)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && outcome == nil) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read demo review choice: %w", err)
	}
	d := kyc.Decision{
		SubmissionID: submissionID, Outcome: *outcome,
		Reviewer: audit.System(), ReviewerID: demoReviewer,
	}
	switch *outcome {
	case "reject":
		d.Reason = "The ID photo is too blurry to read (demo outcome)."
	case "resubmit":
		d.Reason = "Please send a clearer photo of your ID (demo outcome)."
		d.ResubmitDocuments = []string{"id_front"}
	}
	if _, err := s.kyc.Decide(ctx, d); err != nil {
		return fmt.Errorf("sandbox review: %w", err)
	}
	return nil
}
