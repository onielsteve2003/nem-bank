package transfers

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/accounts"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/pagination"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/transfers/transfersdb"
)

// Payment links (TRF-12) and receive QR codes (TRF-13).

// PayURLBase is where the web pay page lives; a link's url is this plus its slug.
const PayURLBase = "https://nem-bank-fodx.vercel.app/pay/"

var (
	// ErrLinkNotFound is the 404 for a link the caller does not own (or no such slug).
	ErrLinkNotFound   = problem.NotFound("Payment link")
	errLinkClosed     = problem.New(http.StatusConflict, "invalid_state", "This link is not taking payments")
	errLinkExpired    = problem.New(http.StatusConflict, "invalid_state", "This link has expired")
	errOwnLink        = problem.New(http.StatusConflict, "own_link", "This is your own link").WithDetail("Share it with whoever is paying you.")
	errFixedNeedsAmt  = problem.New(http.StatusUnprocessableEntity, problem.CodeValidationFailed, "A fixed link needs an amount")
	errOpenNeedsAmt   = problem.New(http.StatusUnprocessableEntity, problem.CodeValidationFailed, "Enter how much to pay")
	errExpiryInPast   = problem.New(http.StatusUnprocessableEntity, problem.CodeValidationFailed, "Pick an expiry in the future")
	errNotNairaReceiv = problem.New(http.StatusUnprocessableEntity, problem.CodeValidationFailed, "Links and QR codes take naira").
				WithDetail("Choose your naira account.")
)

// slugAlphabet is 32 characters (no l or o, which read as 1 and 0), so a random byte maps
// to it without bias.
const slugAlphabet = "abcdefghijkmnpqrstuvwxyz23456789"

func newSlug() (string, error) {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("slug: %w", err)
	}
	out := make([]byte, len(b))
	for i, c := range b {
		out[i] = slugAlphabet[int(c)%len(slugAlphabet)]
	}
	return string(out), nil
}

// linkStatus is the stored status, or expired once expires_at has passed.
func (s *Service) linkStatus(l transfersdb.PaymentLink) string {
	if l.Status == "active" && l.ExpiresAt != nil && !s.now().Before(*l.ExpiresAt) {
		return "expired"
	}
	return l.Status
}

// receivingAccount checks the caller can take payments into this account: their own, in
// naira (transfers move naira only).
func (s *Service) receivingAccount(ctx context.Context, userID, accountID uuid.UUID) error {
	acc, err := s.accounts.Owned(ctx, userID, accountID)
	if err != nil {
		return err
	}
	if acc.Currency != string(money.NGN) {
		return errNotNairaReceiv
	}
	return nil
}

// NewLink is a payment link to create.
type NewLink struct {
	AccountID  uuid.UUID
	Title      string
	Note       *string
	AmountMode string
	Amount     *money.Money
	ExpiresAt  *time.Time
}

// CreateLink makes a shareable link that pays into one of the caller's naira accounts.
func (s *Service) CreateLink(ctx context.Context, n NewLink) (transfersdb.PaymentLink, error) {
	p, ok := identity.PrincipalFrom(ctx)
	if !ok {
		return transfersdb.PaymentLink{}, problem.Unauthorized()
	}
	if err := s.receivingAccount(ctx, p.UserID, n.AccountID); err != nil {
		return transfersdb.PaymentLink{}, err
	}
	in := transfersdb.InsertPaymentLinkParams{
		UserID: p.UserID, AccountID: n.AccountID, Title: strings.TrimSpace(n.Title), Note: cleanNickname(n.Note),
		AmountMode: n.AmountMode, Currency: string(money.NGN), CreatedAt: s.now(),
	}
	if n.AmountMode == "fixed" {
		if n.Amount == nil {
			return transfersdb.PaymentLink{}, errFixedNeedsAmt
		}
		if n.Amount.Currency() != money.NGN {
			return transfersdb.PaymentLink{}, errNotNairaReceiv
		}
		if !n.Amount.IsPositive() {
			return transfersdb.PaymentLink{}, problem.Validation(problem.Field("/amount", "positive", "Enter an amount above zero."))
		}
		in.AmountMinor = ptr(n.Amount.Amount())
	}
	if n.ExpiresAt != nil {
		if !n.ExpiresAt.After(s.now()) {
			return transfersdb.PaymentLink{}, errExpiryInPast
		}
		in.ExpiresAt = ptr(n.ExpiresAt.UTC())
	}
	var err error
	if in.ID, err = uuid.NewV7(); err != nil {
		return transfersdb.PaymentLink{}, fmt.Errorf("link id: %w", err)
	}
	// 32^8 slugs: a clash is rare, and a retry with a fresh slug resolves it.
	for range 3 {
		if in.Slug, err = newSlug(); err != nil {
			return transfersdb.PaymentLink{}, err
		}
		l, err := s.q.InsertPaymentLink(ctx, in)
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			continue
		}
		if err != nil {
			return l, fmt.Errorf("insert payment link: %w", err)
		}
		return l, nil
	}
	return transfersdb.PaymentLink{}, errors.New("payment link: no free slug after 3 tries")
}

// GetLink returns one of the caller's links.
func (s *Service) GetLink(ctx context.Context, id uuid.UUID) (transfersdb.PaymentLink, error) {
	p, ok := identity.PrincipalFrom(ctx)
	if !ok {
		return transfersdb.PaymentLink{}, problem.Unauthorized()
	}
	l, err := s.q.GetPaymentLink(ctx, transfersdb.GetPaymentLinkParams{ID: id, UserID: p.UserID})
	if errors.Is(err, pgx.ErrNoRows) {
		return l, ErrLinkNotFound
	}
	if err != nil {
		return l, fmt.Errorf("load payment link: %w", err)
	}
	return l, nil
}

// ListLinks pages the caller's links, newest first.
func (s *Service) ListLinks(ctx context.Context, cursor *string, limit *int) ([]transfersdb.PaymentLink, api.PageInfo, error) {
	p, ok := identity.PrincipalFrom(ctx)
	if !ok {
		return nil, api.PageInfo{}, problem.Unauthorized()
	}
	after, err := pagination.Decode(cursor)
	if err != nil {
		return nil, api.PageInfo{}, err
	}
	n := pagination.Limit(limit)
	rows, err := s.q.ListPaymentLinks(ctx, transfersdb.ListPaymentLinksParams{UserID: p.UserID, AfterID: after.ID, AfterAt: after.Time, Lim: int32(n + 1)}) //nolint:gosec // n ≤ pagination.MaxLimit
	if err != nil {
		return nil, api.PageInfo{}, fmt.Errorf("list payment links: %w", err)
	}
	rows, page := pagination.Page(rows, n, func(l transfersdb.PaymentLink) pagination.Cursor {
		return pagination.Cursor{Time: l.CreatedAt, ID: l.ID}
	})
	return rows, page, nil
}

// UpdateLink retitles, re-notes (an empty note clears it), deactivates or reactivates a link.
func (s *Service) UpdateLink(ctx context.Context, id uuid.UUID, title, note, status *string) (transfersdb.PaymentLink, error) {
	l, err := s.GetLink(ctx, id)
	if err != nil {
		return l, err
	}
	if s.linkStatus(l) == "expired" {
		return l, errLinkExpired
	}
	in := transfersdb.UpdatePaymentLinkParams{ID: id, UserID: l.UserID, Status: status, SetNote: note != nil, Note: cleanNickname(note)}
	if title != nil {
		t := strings.TrimSpace(*title)
		if t == "" {
			return l, problem.Validation(problem.Field("/title", "required", "Give the link a title."))
		}
		in.Title = &t
	}
	out, err := s.q.UpdatePaymentLink(ctx, in)
	if err != nil {
		return out, fmt.Errorf("update payment link: %w", err)
	}
	return out, nil
}

// PublicLink is what the public pay page shows: the payee's display name, nothing more.
type PublicLink struct {
	transfersdb.PaymentLink
	PayeeName, Status string
}

// GetPublicLink opens a pay page by slug, signed in or not.
func (s *Service) GetPublicLink(ctx context.Context, slug string) (PublicLink, error) {
	l, err := s.q.GetPaymentLinkBySlug(ctx, slug)
	if errors.Is(err, pgx.ErrNoRows) {
		return PublicLink{}, ErrLinkNotFound
	}
	if err != nil {
		return PublicLink{}, fmt.Errorf("load payment link: %w", err)
	}
	owner, err := s.customers.CustomerProfile(ctx, l.UserID)
	if err != nil {
		return PublicLink{}, err
	}
	return PublicLink{PaymentLink: l, PayeeName: owner.Name, Status: s.linkStatus(l)}, nil
}

// PayLink pays a link from the signed-in payer's account: a normal transfer into the
// link's account, committed with the link's takings counted.
func (s *Service) PayLink(ctx context.Context, slug string, sourceAccountID uuid.UUID, amount *money.Money, note string) (View, error) {
	p, ok := identity.PrincipalFrom(ctx)
	if !ok {
		return View{}, problem.Unauthorized()
	}
	link, err := s.GetPublicLink(ctx, slug)
	if err != nil {
		return View{}, err
	}
	if link.Status != "active" {
		return View{}, errLinkClosed
	}
	if link.UserID == p.UserID {
		return View{}, errOwnLink
	}
	pay := amount
	if link.AmountMode == "fixed" {
		pay = ptr(money.New(*link.AmountMinor, money.NGN))
	}
	if pay == nil {
		return View{}, errOpenNeedsAmt
	}
	to, err := s.accounts.RecipientByAccount(ctx, link.AccountID)
	if err != nil {
		return View{}, err
	}
	dest, err := (target{nem: &to}).destination()
	if err != nil {
		return View{}, err
	}
	coolOff, err := s.customers.CoolOff(ctx)
	if err != nil {
		return View{}, err
	}
	narration := strings.TrimSpace(note)
	if narration == "" {
		narration = link.Title
	}
	pl, err := s.prepare(ctx, p.UserID, Request{
		SourceAccountID: sourceAccountID, Destination: dest, Amount: *pay, Narration: narration, PaymentLinkID: &link.ID,
	}, coolOff)
	if err != nil {
		return View{}, err
	}
	var tid uuid.UUID
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		q := s.q.WithTx(tx)
		l, err := q.LockPaymentLinkBySlug(ctx, slug)
		if err != nil {
			return fmt.Errorf("lock payment link: %w", err)
		}
		if s.linkStatus(l) != "active" {
			return errLinkClosed
		}
		if tid, err = s.commit(ctx, tx, pl); err != nil {
			return err
		}
		return q.CountLinkPayment(ctx, transfersdb.CountLinkPaymentParams{ID: l.ID, AmountMinor: pay.Amount()})
	})
	if err != nil {
		return View{}, err
	}
	return s.view(ctx, p.UserID, tid)
}

// LinkJSON is the contract's PaymentLink.
func (s *Service) LinkJSON(l transfersdb.PaymentLink) api.PaymentLink {
	out := api.PaymentLink{
		Id: l.ID, Slug: l.Slug, Url: PayURLBase + l.Slug, AccountId: l.AccountID, Title: l.Title, Note: l.Note,
		AmountMode: api.PaymentLinkAmountMode(l.AmountMode), Status: api.PaymentLinkStatus(s.linkStatus(l)),
		PaymentsCount: int(l.PaymentsCount), TotalReceived: accounts.Money(money.New(l.TotalReceivedMinor, money.NGN)),
		ExpiresAt: utc(l.ExpiresAt), CreatedAt: l.CreatedAt.UTC(),
	}
	if l.AmountMinor != nil {
		m := accounts.Money(money.New(*l.AmountMinor, money.NGN))
		out.Amount = &m
	}
	return out
}

// PublicLinkJSON is the contract's PublicPaymentLink.
func PublicLinkJSON(l PublicLink) api.PublicPaymentLink {
	out := api.PublicPaymentLink{
		Slug: l.Slug, Title: l.Title, Note: l.Note, PayeeName: l.PayeeName, AmountMode: api.PaymentLinkAmountMode(l.AmountMode),
		Currency: api.CurrencyCode(l.Currency), Status: api.PublicPaymentLinkStatus(l.Status), Demo: true,
	}
	if l.AmountMinor != nil {
		m := accounts.Money(money.New(*l.AmountMinor, money.NGN))
		out.Amount = &m
	}
	return out
}

// QR payloads are "nem1.<base64url claims>.<base64url HMAC-SHA256>": the server signs
// them, so a code someone edits (another account number, a different amount) fails.
const (
	qrPrefix = "nem1"
	// QRKeyID names the signing key, so keys can rotate.
	QRKeyID = "qr1"
	// QRFixedTTL is how long a fixed-amount code is honoured; open codes do not expire.
	QRFixedTTL = 15 * time.Minute
)

type qrClaims struct {
	Account string `json:"acct"`
	Amount  string `json:"amt,omitempty"`
	Expires int64  `json:"exp,omitempty"`
	KeyID   string `json:"kid"`
}

// QR is a receive code.
type QR struct {
	Payload   string
	AccountID uuid.UUID
	Amount    *money.Money
	ExpiresAt *time.Time
}

func (s *Service) qrSign(body string) string {
	m := hmac.New(sha256.New, s.qrKey)
	m.Write([]byte(body))
	return base64.RawURLEncoding.EncodeToString(m.Sum(nil))
}

// MyQR is the caller's receive code for a naira account, optionally for a fixed amount.
func (s *Service) MyQR(ctx context.Context, accountID uuid.UUID, amount *money.Money) (QR, error) {
	p, ok := identity.PrincipalFrom(ctx)
	if !ok {
		return QR{}, problem.Unauthorized()
	}
	acc, err := s.accounts.Owned(ctx, p.UserID, accountID)
	if err != nil {
		return QR{}, err
	}
	if acc.Currency != string(money.NGN) {
		return QR{}, errNotNairaReceiv
	}
	c := qrClaims{Account: acc.AccountNumber, KeyID: QRKeyID}
	out := QR{AccountID: accountID}
	if amount != nil {
		if !amount.IsPositive() {
			return QR{}, problem.Validation(problem.Field("/amount_minor", "positive", "Enter an amount above zero."))
		}
		exp := s.now().Add(QRFixedTTL).Truncate(time.Second).UTC()
		c.Amount, c.Expires = strconv.FormatInt(amount.Amount(), 10), exp.Unix()
		out.Amount, out.ExpiresAt = amount, &exp
	}
	claims, err := json.Marshal(c)
	if err != nil {
		return QR{}, fmt.Errorf("qr claims: %w", err)
	}
	body := qrPrefix + "." + base64.RawURLEncoding.EncodeToString(claims)
	out.Payload = body + "." + s.qrSign(body)
	return out, nil
}

// Decoded is a scanned code: valid with its payee and amount, or the reason it is not.
type Decoded struct {
	Valid   bool
	Reason  string
	Payee   *api.ResolvedPayee
	Amount  *money.Money
	Account string
}

// DecodeQR checks a scanned code's signature and expiry, then resolves the payee.
func (s *Service) DecodeQR(ctx context.Context, payload string) (Decoded, error) {
	p, ok := identity.PrincipalFrom(ctx)
	if !ok {
		return Decoded{}, problem.Unauthorized()
	}
	parts := strings.Split(strings.TrimSpace(payload), ".")
	if len(parts) != 3 || parts[0] != qrPrefix {
		return Decoded{Reason: "not_nem_qr"}, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	var c qrClaims
	if err != nil || json.Unmarshal(raw, &c) != nil || c.Account == "" {
		return Decoded{Reason: "not_nem_qr"}, nil
	}
	if c.KeyID != QRKeyID || !hmac.Equal([]byte(s.qrSign(parts[0]+"."+parts[1])), []byte(parts[2])) {
		return Decoded{Reason: "bad_signature"}, nil
	}
	if c.Expires != 0 && !s.now().Before(time.Unix(c.Expires, 0)) {
		return Decoded{Reason: "expired"}, nil
	}
	r, err := s.accounts.ResolveNuban(ctx, c.Account)
	if errors.Is(err, accounts.ErrNoSuchNuban) {
		return Decoded{Reason: "unknown_account"}, nil
	}
	if err != nil {
		return Decoded{}, err
	}
	userID := r.UserID
	payee := api.ResolvedPayee{
		Kind: api.ResolvedPayeeKindNem, Name: r.Name, Nemtag: r.Nemtag, UserId: &userID,
		BankCode: accounts.BankCode, BankName: accounts.BankName, AccountNumber: r.AccountNumber,
	}
	b, err := s.q.FindBeneficiary(ctx, transfersdb.FindBeneficiaryParams{UserID: p.UserID, BankCode: accounts.BankCode, AccountNumber: r.AccountNumber})
	switch {
	case err == nil:
		payee.IsSavedBeneficiary, payee.BeneficiaryId = true, &b.ID
	case !errors.Is(err, pgx.ErrNoRows):
		return Decoded{}, fmt.Errorf("find beneficiary: %w", err)
	}
	out := Decoded{Valid: true, Payee: &payee, Account: r.AccountNumber}
	if c.Amount != "" {
		m, err := money.ParseMinor(c.Amount, string(money.NGN))
		if err != nil {
			return Decoded{Reason: "not_nem_qr"}, nil //nolint:nilerr // a signed but unreadable amount is not a usable code
		}
		out.Amount = &m
	}
	return out, nil
}
