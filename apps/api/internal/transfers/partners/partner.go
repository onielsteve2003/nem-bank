package partners

import (
	"context"
	"errors"
	"time"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
)

// BankPartner carries a customer's money to another Nigerian bank. Every method may be
// retried: Send is idempotent by Payment.Reference, so a saga that crashed after sending
// can send again and get the first submission back instead of paying twice.
type BankPartner interface {
	// Name identifies the partner in callbacks (/v1/partner-webhooks/{name}) and logs.
	Name() string
	// NameEnquiry asks the receiving bank whose account a number is.
	NameEnquiry(ctx context.Context, bankCode, accountNumber string) (AccountName, error)
	// Send submits a payment. Acceptance is not settlement: the outcome arrives later by
	// callback or by Status.
	Send(ctx context.Context, p Payment) (Submission, error)
	// Status is the transaction status query (TSQ): the partner's view of a payment now.
	Status(ctx context.Context, reference string) (Result, error)
}

// Payment is money to send out.
type Payment struct {
	// Reference is Nem's transfer reference: the idempotency key at the partner.
	Reference     string
	BankCode      string
	AccountNumber string
	AccountName   string
	Amount        money.Money
	Narration     string
}

// Submission is the partner's acknowledgement of a payment.
type Submission struct {
	// PartnerReference is the partner's ID for the payment (the NIP session ID).
	PartnerReference string
}

// State is where a payment stands at the partner.
type State string

// The states a status query can report.
const (
	// Pending: accepted, no final answer yet.
	Pending State = "pending"
	// Settled: the money reached the receiving account. Final.
	Settled State = "settled"
	// Failed: the receiving bank refused it and no money left the partner. Final.
	Failed State = "failed"
	// Unknown: the partner has no payment with that reference, so it never arrived.
	Unknown State = "unknown"
)

// Final reports whether s will not change again.
func (s State) Final() bool { return s == Settled || s == Failed }

// Result is a status query's answer.
type Result struct {
	State            State
	PartnerReference string
	// FailureCode is the partner's reason for a failure (NIP response code).
	FailureCode string
	// At is when the payment reached its state.
	At time.Time
}

// NameCheck is how the sandbox wants Confirmation of Payee to answer (the simulator's
// name_check). Real partners always leave it Realistic.
type NameCheck string

// The simulator's name-check modes.
const (
	Realistic     NameCheck = "realistic"
	AlwaysMatch   NameCheck = "always_match"
	AlwaysNoMatch NameCheck = "always_no_match"
)

// ErrRejected means the partner refused the payment outright (not a later failure).
var ErrRejected = errors.New("partners: payment refused")
