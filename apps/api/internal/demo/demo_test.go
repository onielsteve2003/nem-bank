package demo

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/accounts"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/mailer"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/testdb"
)

var quiet = slog.New(slog.NewTextHandler(io.Discard, nil))

type noMail struct{}

func (noMail) Send(context.Context, mailer.Message) error { return nil }

func newService(t *testing.T) (*Service, *pgxpool.Pool) {
	t.Helper()
	pool := testdb.New(t)
	id, err := identity.NewService(identity.Config{
		Pool: pool, Mailer: noMail{}, Logger: quiet,
		OTPKey: []byte("0123456789abcdef0123456789abcdef"), SigningKey: []byte("fedcba9876543210fedcba9876543210"),
		Hasher:            identity.NewHasher(identity.Argon2Params{MemoryKiB: 64, Time: 1, Threads: 1}, 4),
		OnCustomerCreated: accounts.OpenCurrentAccount,
	})
	if err != nil {
		t.Fatal(err)
	}
	svc, err := NewService(Config{Pool: pool, Identity: id, Rules: fixedRules{}, KYC: &reviewer{}})
	if err != nil {
		t.Fatal(err)
	}
	return svc, pool
}

func device(t *testing.T) identity.DeviceRegistration {
	t.Helper()
	pub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return identity.DeviceRegistration{Name: "Test phone", Platform: "ios", PublicKey: base64.RawURLEncoding.EncodeToString(pub)}
}

func TestStartBuildsAWholePersona(t *testing.T) {
	svc, pool := newService(t)
	ctx := t.Context()

	for name, p := range personas {
		res, err := svc.Start(ctx, name, device(t))
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if res.AccessToken == "" || res.RefreshToken == "" {
			t.Fatalf("%s: no tokens", name)
		}
		if res.User.FirstName != p.first || !res.User.IsDemo || int(res.User.KycTier) != int(p.tier) {
			t.Fatalf("%s: user = %+v", name, res.User)
		}

		var lines, months int
		var oldest, newest time.Time
		var credits, debits, balance int64
		if err := pool.QueryRow(ctx, `
			SELECT count(*), count(DISTINCT date_trunc('month', created_at)), min(created_at), max(created_at),
			       coalesce(sum(amount_minor) FILTER (WHERE direction = 'credit'), 0),
			       coalesce(sum(amount_minor) FILTER (WHERE direction = 'debit'), 0)
			FROM transactions WHERE user_id = $1 AND currency = 'NGN'`, res.User.ID).Scan(&lines, &months, &oldest, &newest, &credits, &debits); err != nil {
			t.Fatal(err)
		}
		if lines < 40 || months < 6 {
			t.Fatalf("%s: %d lines over %d months, want a real history", name, lines, months)
		}
		if time.Since(oldest) < 150*24*time.Hour {
			t.Fatalf("%s: history starts %s, want about six months back", name, oldest)
		}

		var acct [16]byte
		if err := pool.QueryRow(ctx, `SELECT account_id FROM customer_accounts WHERE user_id = $1 AND currency = 'NGN'`, res.User.ID).Scan(&acct); err != nil {
			t.Fatal(err)
		}
		b, err := ledger.GetBalances(ctx, pool, acct)
		if err != nil {
			t.Fatal(err)
		}
		balance = b.Ledger.Amount()
		if balance <= 0 || balance != credits-debits {
			t.Fatalf("%s: ledger balance %d, history says %d", name, balance, credits-debits)
		}
		if p.cap > 0 && balance > p.cap {
			t.Fatalf("%s: balance %d is above the tier cap %d", name, balance, p.cap)
		}
		var salaries int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM transactions WHERE user_id = $1 AND currency = 'NGN' AND category = 'salary_income'`, res.User.ID).Scan(&salaries); err != nil {
			t.Fatal(err)
		}
		if salaries < 6 {
			t.Fatalf("%s: only %d salary credits, the cap is eating the story", name, salaries)
		}
	}
}

func TestStartRefusesAnUnknownPersonaAndASecondUserKeepsItsOwnData(t *testing.T) {
	svc, pool := newService(t)
	ctx := t.Context()
	if _, err := svc.Start(ctx, "nobody", device(t)); !errors.Is(err, ErrUnknownPersona) {
		t.Fatalf("err = %v, want unknown persona", err)
	}
	a, err := svc.Start(ctx, "tolu", device(t))
	if err != nil {
		t.Fatal(err)
	}
	b, err := svc.Start(ctx, "tolu", device(t))
	if err != nil {
		t.Fatal(err)
	}
	if a.User.ID == b.User.ID || a.User.Email == b.User.Email || *a.User.Nemtag == *b.User.Nemtag {
		t.Fatal("two taps must make two separate customers")
	}
	if !strings.HasSuffix(a.User.Email, ".invalid") {
		t.Fatalf("demo email %q can receive mail", a.User.Email)
	}
	var n int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM users WHERE is_demo`).Scan(&n); err != nil || n != 2 {
		t.Fatalf("demo users = %d (%v), want 2", n, err)
	}
	// One phone has one key: tapping the demo again takes the key over from the last demo
	// customer and ends that customer's session.
	d := device(t)
	first, err := svc.Start(ctx, "tolu", d)
	if err != nil {
		t.Fatal(err)
	}
	second, err := svc.Start(ctx, "tolu", d)
	if err != nil {
		t.Fatalf("second tap on the same phone: %v", err)
	}
	var live int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM sessions WHERE user_id = $1 AND revoked_at IS NULL`, first.User.ID).Scan(&live); err != nil || live != 0 {
		t.Fatalf("earlier demo still has %d live sessions (%v)", live, err)
	}
	if second.Device.ID == first.Device.ID {
		t.Fatal("the new customer needs its own device row")
	}

	// A real customer's key is never taken over.
	stranger := device(t)
	pub, _ := base64.RawURLEncoding.DecodeString(stranger.PublicKey)
	var realID string
	if err := pool.QueryRow(ctx, `
		WITH u AS (INSERT INTO users (id, first_name, last_name, email, phone, date_of_birth, password_hash, terms_version, privacy_version, consent_accepted_at)
		           VALUES (gen_random_uuid(), 'Real', 'Person', 'real@example.com', '+2348031234567', '1990-01-01', 'x', 't', 'p', now()) RETURNING id)
		INSERT INTO devices (id, user_id, name, platform, public_key) SELECT gen_random_uuid(), id, 'Phone', 'ios', $1 FROM u RETURNING user_id::text`, pub).Scan(&realID); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Start(ctx, "tolu", stranger); !errors.Is(err, identity.ErrDeviceKeyInUse) {
		t.Fatalf("err = %v, want device key in use", err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM users WHERE is_demo`).Scan(&n); err != nil || n != 4 {
		t.Fatalf("demo users = %d (%v), want 4: the refused tap must leave nothing behind", n, err)
	}
}

func TestPersonasWithDollarIncomeGetAFundedUSDWallet(t *testing.T) {
	svc, pool := newService(t)
	ctx := t.Context()
	for name, p := range personas {
		res, err := svc.Start(ctx, name, device(t))
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		var wallets int
		var usd int64
		if err := pool.QueryRow(ctx, `
			SELECT count(*), coalesce(sum(l.balance_minor), 0)
			FROM customer_accounts a JOIN ledger_accounts l ON l.id = a.account_id
			WHERE a.user_id = $1 AND a.currency = 'USD'`, res.User.ID).Scan(&wallets, &usd); err != nil {
			t.Fatal(err)
		}
		if len(p.usd) == 0 {
			if wallets != 0 {
				t.Fatalf("%s: has a USD wallet but no dollar income", name)
			}
			continue
		}
		var want int64
		for _, pay := range p.usd {
			want += pay.cents
		}
		if wallets != 1 || usd != want {
			t.Fatalf("%s: %d USD wallets holding %d, want 1 holding %d", name, wallets, usd, want)
		}
		if p.tier < 2 {
			t.Fatalf("%s: a Tier 1 persona must not hold a wallet", name)
		}
	}
}
