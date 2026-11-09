package accounts

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/accounts/accountsdb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/ledgerdb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
)

// API adapts the service to the contract's strict server; the router embeds it.
type API struct {
	svc *Service
}

// NewAPI returns the accounts and transactions operations for the router.
func NewAPI(svc *Service) *API { return &API{svc: svc} }

// holdLabels are the plain-language hold descriptions the mock bank gives.
var holdLabels = map[string]string{
	"card_authorization": "Card payment waiting to settle",
	"pending_transfer":   "Transfer on its way",
	"delayed_transfer":   "New-beneficiary cooling-off",
	"fraud_review":       "Held for a security review",
	"ajo_contribution":   "Ajo contribution",
	"dispute":            "Under dispute",
}

var feeLabels = map[string]string{
	"transfer_fee":        "Transfer fee",
	"emtl":                "Electronic Money Transfer Levy",
	"fx_spread":           "FX spread",
	"fx_fee":              "FX fee",
	"card_fee":            "Card fee",
	"bill_fee":            "Bill fee",
	"early_break_penalty": "Early withdrawal penalty",
}

// Money converts to the contract's string minor units.
func Money(m money.Money) api.Money {
	return api.Money{AmountMinor: strconv.FormatInt(m.Amount(), 10), Currency: api.CurrencyCode(m.Currency())}
}

func minor(amount int64, currency string) api.Money {
	return Money(money.New(amount, money.Currency(currency)))
}

func receiving(v View) (api.ReceivingDetails, error) {
	var d api.ReceivingDetails
	var err error
	switch money.Currency(v.Currency) {
	case money.NGN:
		err = d.FromNubanDetails(api.NubanDetails{
			Scheme: api.NubanDetailsSchemeNuban, BankName: BankName, BankCode: BankCode,
			AccountNumber: v.AccountNumber, AccountName: v.AccountName, Demo: true,
		})
	case money.USD:
		err = d.FromUsAchDetails(api.UsAchDetails{
			Scheme: api.UsAch, BankName: partnerBankName, AccountNumber: v.AccountNumber,
			RoutingNumber: usRoutingNumber, AccountType: api.Checking, AccountName: v.AccountName, Demo: true,
		})
	case money.GBP:
		err = d.FromUkFpsDetails(api.UkFpsDetails{
			Scheme: api.UkFps, BankName: partnerBankName, SortCode: ukSortCode,
			AccountNumber: v.AccountNumber[2:], AccountName: v.AccountName, Demo: true,
		})
	default:
		err = d.FromIbanDetails(api.IbanDetails{
			Scheme: api.Iban, BankName: partnerBankName, Iban: germanIBAN(v.AccountNumber), Bic: euBIC,
			AccountName: v.AccountName, Demo: true,
		})
	}
	if err != nil {
		return d, fmt.Errorf("receiving details: %w", err)
	}
	return d, nil
}

func accountJSON(v View) (api.Account, error) {
	details, err := receiving(v)
	if err != nil {
		return api.Account{}, err
	}
	out := api.Account{
		Id: v.AccountID, Currency: api.CurrencyCode(v.Currency), Kind: api.AccountKind(v.Kind),
		Status: api.AccountStatus(v.Status), Nickname: v.Nickname, LedgerBalance: Money(v.Ledger),
		AvailableBalance: Money(v.Available), ReceivingDetails: details, OpenedAt: v.OpenedAt.UTC(),
	}
	if v.MaxBalance != nil {
		m := Money(*v.MaxBalance)
		out.MaxBalance = &m
	}
	return out, nil
}

// ListAccounts is GET /v1/accounts.
func (a *API) ListAccounts(ctx context.Context, _ api.ListAccountsRequestObject) (api.ListAccountsResponseObject, error) {
	views, err := a.svc.List(ctx)
	if err != nil {
		return nil, err
	}
	out := api.ListAccounts200JSONResponse{Data: make([]api.Account, 0, len(views))}
	for _, v := range views {
		acc, err := accountJSON(v)
		if err != nil {
			return nil, err
		}
		out.Data = append(out.Data, acc)
	}
	return out, nil
}

// OpenAccount is POST /v1/accounts (a foreign-currency wallet).
func (a *API) OpenAccount(ctx context.Context, req api.OpenAccountRequestObject) (api.OpenAccountResponseObject, error) {
	v, err := a.svc.OpenWallet(ctx, money.Currency(req.Body.Currency))
	if err != nil {
		return nil, err
	}
	acc, err := accountJSON(v)
	if err != nil {
		return nil, err
	}
	return api.OpenAccount201JSONResponse(acc), nil
}

// GetAccount is GET /v1/accounts/{account_id}.
func (a *API) GetAccount(ctx context.Context, req api.GetAccountRequestObject) (api.GetAccountResponseObject, error) {
	v, err := a.svc.Get(ctx, req.AccountId)
	if err != nil {
		return nil, err
	}
	acc, err := accountJSON(v)
	if err != nil {
		return nil, err
	}
	return api.GetAccount200JSONResponse(acc), nil
}

func holdJSON(h ledgerdb.AccountHold) api.Hold {
	label := holdLabels[h.Reason]
	return api.Hold{
		Id: h.ID, AccountId: h.AccountID, Amount: minor(h.AmountMinor, h.Currency), Reason: api.HoldReason(h.Reason),
		Reference: h.Reference, Description: &label, CreatedAt: h.CreatedAt.UTC(), ExpiresAt: utcPtr(h.ExpiresAt),
	}
}

// ListAccountHolds is GET /v1/accounts/{account_id}/holds.
func (a *API) ListAccountHolds(ctx context.Context, req api.ListAccountHoldsRequestObject) (api.ListAccountHoldsResponseObject, error) {
	holds, total, err := a.svc.Holds(ctx, req.AccountId)
	if err != nil {
		return nil, err
	}
	out := api.ListAccountHolds200JSONResponse{Data: make([]api.Hold, 0, len(holds)), Total: Money(total)}
	for _, h := range holds {
		out.Data = append(out.Data, holdJSON(h))
	}
	return out, nil
}

// TransactionJSON is the contract's view of a transaction line.
func TransactionJSON(t accountsdb.Transaction) (api.Transaction, error) {
	var cp api.Counterparty
	if err := json.Unmarshal(t.Counterparty, &cp); err != nil {
		return api.Transaction{}, fmt.Errorf("counterparty: %w", err)
	}
	out := api.Transaction{
		Id: t.ID, AccountId: t.AccountID, Type: api.TransactionType(t.Type), Direction: api.Direction(t.Direction),
		Status: api.TransactionStatus(t.Status), Amount: minor(t.AmountMinor, t.Currency), Narration: t.Narration,
		Reference: t.Reference, Category: api.Category(t.Category), CategorySource: api.CategorySource(t.CategorySource),
		CategoryConfidence: t.CategoryConfidence, Counterparty: cp, TransferId: t.TransferID, CardId: t.CardID,
		CreatedAt: t.CreatedAt.UTC(),
	}
	if t.FeeMinor != nil {
		f := minor(*t.FeeMinor, t.Currency)
		out.Fee = &f
	}
	if t.BalanceAfterMinor != nil {
		b := minor(*t.BalanceAfterMinor, t.Currency)
		out.BalanceAfter = &b
	}
	return out, nil
}

// ListTransactions is GET /v1/transactions.
func (a *API) ListTransactions(ctx context.Context, req api.ListTransactionsRequestObject) (api.ListTransactionsResponseObject, error) {
	p := req.Params
	f := Filter{AccountID: p.AccountId, Cursor: p.Cursor, Limit: p.Limit}
	if p.Type != nil {
		for _, t := range *p.Type {
			f.Types = append(f.Types, string(t))
		}
	}
	f.Currency = (*string)(p.Currency)
	f.Status = (*string)(p.Status)
	f.Category = (*string)(p.Category)
	if p.From != nil {
		f.From = &p.From.Time
	}
	if p.To != nil {
		f.To = &p.To.Time
	}
	if p.Q != nil {
		f.Query = *p.Q
	}
	rows, page, err := a.svc.Transactions(ctx, f)
	if err != nil {
		return nil, err
	}
	out := api.ListTransactions200JSONResponse{Data: make([]api.Transaction, 0, len(rows)), Page: page}
	for _, r := range rows {
		t, err := TransactionJSON(r)
		if err != nil {
			return nil, err
		}
		out.Data = append(out.Data, t)
	}
	return out, nil
}

// GetTransaction is GET /v1/transactions/{transaction_id}.
func (a *API) GetTransaction(ctx context.Context, req api.GetTransactionRequestObject) (api.GetTransactionResponseObject, error) {
	d, err := a.svc.Transaction(ctx, req.TransactionId)
	if err != nil {
		return nil, err
	}
	t, err := TransactionJSON(d.Transaction)
	if err != nil {
		return nil, err
	}
	fees := []api.FeeLine{}
	if t.Fee != nil && d.FeeCode != nil {
		fees = append(fees, api.FeeLine{Code: api.FeeLineCode(*d.FeeCode), Label: feeLabels[*d.FeeCode], Amount: *t.Fee})
	}
	entry := d.ID // a line whose money has not moved yet has no entry; the mock uses its own ID
	if d.EntryID != nil {
		entry = *d.EntryID
	}
	return api.GetTransaction200JSONResponse{
		Id: t.Id, AccountId: t.AccountId, Type: t.Type, Direction: t.Direction, Status: t.Status, Amount: t.Amount,
		Fee: t.Fee, BalanceAfter: t.BalanceAfter, Narration: t.Narration, Reference: t.Reference, Category: t.Category,
		CategorySource: t.CategorySource, CategoryConfidence: t.CategoryConfidence, Counterparty: t.Counterparty,
		TransferId: t.TransferId, CardId: t.CardId, CreatedAt: t.CreatedAt,
		Timeline:       d.Timeline,
		Fees:           fees,
		JournalEntryId: entry,
		CanDispute:     d.CanDispute,
		CanRepeat:      d.CanRepeat,
	}, nil
}

// statusLabel is the single timeline step of a line with no richer history.
func statusLabel(status string) string {
	return strings.ToUpper(status[:1]) + status[1:]
}

func utcPtr(t *time.Time) *time.Time {
	if t == nil {
		return nil
	}
	u := t.UTC()
	return &u
}

// ListStatements is GET /v1/statements.
func (a *API) ListStatements(ctx context.Context, req api.ListStatementsRequestObject) (api.ListStatementsResponseObject, error) {
	rows, page, err := a.svc.Statements(ctx, req.Params.Cursor, req.Params.Limit)
	if err != nil {
		return nil, err
	}
	out := api.ListStatements200JSONResponse{Data: make([]api.Statement, 0, len(rows)), Page: page}
	for _, st := range rows {
		out.Data = append(out.Data, a.svc.StatementJSON(st))
	}
	return out, nil
}

// RequestStatement is POST /v1/statements: generation runs in the background.
func (a *API) RequestStatement(ctx context.Context, req api.RequestStatementRequestObject) (api.RequestStatementResponseObject, error) {
	b := req.Body
	st, err := a.svc.RequestStatement(ctx, b.AccountId, b.From.Time, b.To.Time)
	if err != nil {
		return nil, err
	}
	return api.RequestStatement202JSONResponse(a.svc.StatementJSON(st)), nil
}

// GetStatement is GET /v1/statements/{statement_id}.
func (a *API) GetStatement(ctx context.Context, req api.GetStatementRequestObject) (api.GetStatementResponseObject, error) {
	st, err := a.svc.Statement(ctx, req.StatementId)
	if err != nil {
		return nil, err
	}
	return api.GetStatement200JSONResponse(a.svc.StatementJSON(st)), nil
}

// DownloadStatement is GET /v1/statements/{statement_id}/download: the PDF as issued.
func (a *API) DownloadStatement(ctx context.Context, req api.DownloadStatementRequestObject) (api.DownloadStatementResponseObject, error) {
	pdf, err := a.svc.StatementPDF(ctx, req.StatementId)
	if err != nil {
		return nil, err
	}
	return api.DownloadStatement200ApplicationpdfResponse{Body: bytes.NewReader(pdf), ContentLength: int64(len(pdf))}, nil
}

// VerifyStatement is GET /v1/public/statements/{verification_code} (no sign-in).
func (a *API) VerifyStatement(ctx context.Context, req api.VerifyStatementRequestObject) (api.VerifyStatementResponseObject, error) {
	v, err := a.svc.VerifyStatement(ctx, req.VerificationCode)
	if err != nil {
		return nil, err
	}
	return api.VerifyStatement200JSONResponse{
		Valid: true, AccountNameMasked: v.NameMasked, AccountNumberMasked: v.NumberMasked,
		Currency: api.CurrencyCode(v.Currency), PeriodFrom: api.Date{Time: v.From}, PeriodTo: api.Date{Time: v.To},
		Sha256: v.SHA256, IssuedAt: v.IssuedAt.UTC(), Demo: true,
	}, nil
}
