package partners

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
)

// PaystackConfig configures the optional Paystack adapter.
type PaystackConfig struct {
	// SecretKey must be a test key (sk_test_…): the demo never moves real money.
	SecretKey string
	// BaseURL defaults to https://api.paystack.co.
	BaseURL string
	// HTTP defaults to a client with a 15-second timeout.
	HTTP *http.Client
}

// Paystack is a real partner adapter against Paystack's test mode: real name enquiry and
// transfer APIs, play money. It learns outcomes by status query only (Paystack's own
// webhooks use a different signature scheme), which the saga supports for any partner.
type Paystack struct {
	key  string
	base string
	http *http.Client
}

var _ BankPartner = (*Paystack)(nil)

// ErrLiveKey refuses a live Paystack key: this build is a demo on simulated money.
var ErrLiveKey = errors.New("partners: only a Paystack test key (sk_test_…) is accepted")

// NewPaystack returns the adapter, refusing anything but a test key.
func NewPaystack(cfg PaystackConfig) (*Paystack, error) {
	if !strings.HasPrefix(cfg.SecretKey, "sk_test_") {
		return nil, ErrLiveKey
	}
	if cfg.BaseURL == "" {
		cfg.BaseURL = "https://api.paystack.co"
	}
	if cfg.HTTP == nil {
		cfg.HTTP = &http.Client{Timeout: 15 * time.Second}
	}
	return &Paystack{key: cfg.SecretKey, base: strings.TrimRight(cfg.BaseURL, "/"), http: cfg.HTTP}, nil
}

// Name identifies the partner.
func (*Paystack) Name() string { return "paystack_test" }

// envelope is every Paystack response.
type envelope[T any] struct {
	Status  bool   `json:"status"`
	Message string `json:"message"`
	Data    T      `json:"data"`
}

// errNotFound is Paystack's 404, a normal answer for an unknown account or reference.
var errNotFound = errors.New("paystack: not found")

func call[T any](ctx context.Context, p *Paystack, method, path string, in any) (T, error) {
	var zero T
	var body io.Reader
	if in != nil {
		b, err := json.Marshal(in)
		if err != nil {
			return zero, fmt.Errorf("paystack %s: %w", path, err)
		}
		body = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, p.base+path, body)
	if err != nil {
		return zero, fmt.Errorf("paystack %s: %w", path, err)
	}
	req.Header.Set("Authorization", "Bearer "+p.key)
	if in != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := p.http.Do(req) //nolint:gosec // fixed Paystack host from config; path parts are escaped
	if err != nil {
		return zero, fmt.Errorf("paystack %s: %w", path, err)
	}
	defer func() { _ = resp.Body.Close() }()
	var env envelope[T]
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&env); err != nil {
		return zero, fmt.Errorf("paystack %s: status %d, unreadable body: %w", path, resp.StatusCode, err)
	}
	switch {
	case resp.StatusCode == http.StatusNotFound:
		return zero, errNotFound
	case resp.StatusCode == http.StatusBadRequest || resp.StatusCode == http.StatusUnprocessableEntity:
		return zero, fmt.Errorf("%w: %s", ErrRejected, env.Message)
	case resp.StatusCode/100 != 2 || !env.Status:
		return zero, fmt.Errorf("paystack %s: status %d: %s", path, resp.StatusCode, env.Message)
	}
	return env.Data, nil
}

// NameEnquiry is GET /bank/resolve.
func (p *Paystack) NameEnquiry(ctx context.Context, bankCode, accountNumber string) (AccountName, error) {
	q := url.Values{"account_number": {accountNumber}, "bank_code": {bankCode}}
	d, err := call[struct {
		AccountNumber string `json:"account_number"`
		AccountName   string `json:"account_name"`
	}](ctx, p, http.MethodGet, "/bank/resolve?"+q.Encode(), nil)
	if errors.Is(err, errNotFound) || errors.Is(err, ErrRejected) {
		// Paystack answers an unresolvable account with 422 "Could not resolve account name".
		return AccountName{}, fmt.Errorf("%w: %w", ErrAccountNotFound, err)
	}
	if err != nil {
		return AccountName{}, err
	}
	return AccountName{BankCode: bankCode, AccountNumber: d.AccountNumber, Name: d.AccountName, NameCheck: Realistic}, nil
}

// paystackReference is Nem's reference in the form Paystack requires (lowercase).
func paystackReference(ref string) string { return strings.ToLower(ref) }

// Send creates a transfer recipient, then the transfer. Paystack dedupes transfers by
// reference, so a resend returns the first transfer.
func (p *Paystack) Send(ctx context.Context, pay Payment) (Submission, error) {
	if pay.Amount.Currency() != money.NGN {
		return Submission{}, fmt.Errorf("%w: naira only", ErrRejected)
	}
	rcp, err := call[struct {
		RecipientCode string `json:"recipient_code"`
	}](ctx, p, http.MethodPost, "/transferrecipient", map[string]any{
		"type": "nuban", "name": pay.AccountName, "account_number": pay.AccountNumber, "bank_code": pay.BankCode, "currency": "NGN",
	})
	if err != nil {
		return Submission{}, err
	}
	tr, err := call[struct {
		TransferCode string `json:"transfer_code"`
	}](ctx, p, http.MethodPost, "/transfer", map[string]any{
		"source": "balance", "amount": pay.Amount.Amount(), "recipient": rcp.RecipientCode,
		"reference": paystackReference(pay.Reference), "reason": pay.Narration,
	})
	if err != nil {
		return Submission{}, err
	}
	return Submission{PartnerReference: tr.TransferCode}, nil
}

// Status is GET /transfer/verify/{reference}.
func (p *Paystack) Status(ctx context.Context, reference string) (Result, error) {
	d, err := call[struct {
		Status       string    `json:"status"`
		TransferCode string    `json:"transfer_code"`
		UpdatedAt    time.Time `json:"updatedAt"`
		Reason       string    `json:"reason"`
	}](ctx, p, http.MethodGet, "/transfer/verify/"+url.PathEscape(paystackReference(reference)), nil)
	if errors.Is(err, errNotFound) {
		return Result{State: Unknown}, nil
	}
	if err != nil {
		return Result{}, err
	}
	r := Result{State: Pending, PartnerReference: d.TransferCode, At: d.UpdatedAt}
	switch d.Status {
	case "success":
		r.State = Settled
	case "failed", "reversed", "rejected", "abandoned", "blocked":
		r.State, r.FailureCode = Failed, "paystack_"+d.Status
	}
	return r, nil
}
