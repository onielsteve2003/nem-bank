package httpserver

import (
	"bytes"
	"crypto/ed25519"
	"crypto/hmac"
	"crypto/sha1" //nolint:gosec // RFC 6238 TOTP is HMAC-SHA1
	"encoding/base32"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/admin"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/fieldcrypt"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/testdb"
)

// authenticatorCode is what an authenticator app shows for an otpauth:// URI, written
// independently of the admin package so the test checks the contract, not the code.
func authenticatorCode(t *testing.T, uri string, at time.Time) string {
	t.Helper()
	u, err := url.Parse(uri)
	if err != nil {
		t.Fatal(err)
	}
	secret, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(u.Query().Get("secret"))
	if err != nil {
		t.Fatal(err)
	}
	var msg [8]byte
	binary.BigEndian.PutUint64(msg[:], uint64(at.Unix()/30)) //nolint:gosec // test clock after 1970
	mac := hmac.New(sha1.New, secret)
	mac.Write(msg[:])
	sum := mac.Sum(nil)
	off := sum[len(sum)-1] & 0x0f
	return fmt.Sprintf("%06d", (binary.BigEndian.Uint32(sum[off:off+4])&0x7fffffff)%1_000_000)
}

func TestStaffRealmIsSeparateAndRolesComeFromTheContract(t *testing.T) {
	t.Parallel()
	quiet := slog.New(slog.NewTextHandler(io.Discard, nil))
	pool := testdb.New(t)
	hasher := identity.NewHasher(identity.Argon2Params{MemoryKiB: 64, Time: 1, Threads: 1}, 2)
	keyring, err := fieldcrypt.New(map[uint16][]byte{1: []byte("0123456789abcdef0123456789abcdef")}, []byte("fedcba9876543210fedcba9876543210"))
	if err != nil {
		t.Fatal(err)
	}
	mail := &lastMail{}
	idSvc, err := identity.NewService(identity.Config{
		Pool: pool, Mailer: mail, Logger: quiet, OTPKey: []byte("0123456789abcdef0123456789abcdef"),
		SigningKey: []byte("fedcba9876543210fedcba9876543210"), Hasher: hasher,
	})
	if err != nil {
		t.Fatal(err)
	}
	adminSvc, err := admin.NewService(admin.Config{
		Pool: pool, Logger: quiet, SigningKey: []byte("staff-signing-seed-0123456789abc"), Keyring: keyring, Hasher: hasher,
	})
	if err != nil {
		t.Fatal(err)
	}
	h, err := NewRouter(Options{
		Version: "e2e", Logger: quiet, Identity: identity.NewAPI(idSvc), Authenticator: idSvc,
		Admin: admin.NewAPI(adminSvc), StaffAuthenticator: adminSvc,
	})
	if err != nil {
		t.Fatal(err)
	}

	// Staff sign in: password, then the code from the enrolment QR they just scanned.
	signIn := func(name, email string, role admin.Role) api.StaffSession {
		if _, err := adminSvc.CreateStaff(t.Context(), admin.StaffInput{Name: name, Email: email, Password: "Lagoon-Harmattan-Kettle-42", Roles: []admin.Role{role}}); err != nil { // gitleaks:allow (test fixture)
			t.Fatal(err)
		}
		ch := call[api.StaffLoginChallenge](t, h, http.MethodPost, "/v1/admin/auth/login", "",
			map[string]string{"email": email, "password": "Lagoon-Harmattan-Kettle-42"}, http.StatusOK) // gitleaks:allow (test fixture)
		if ch.TotpEnrolment == nil {
			t.Fatal("first login has no enrolment URI")
		}
		return call[api.StaffSession](t, h, http.MethodPost, "/v1/admin/auth/totp", "",
			map[string]string{"challenge_id": ch.ChallengeId.String(), "code": authenticatorCode(t, ch.TotpEnrolment.OtpauthUri, time.Now())}, http.StatusOK)
	}
	support := signIn("Chidi Eze", "chidi@nem.bank", admin.RoleSupport)
	compliance := signIn("Aisha Bello", "aisha@nem.bank", admin.RoleCompliance)
	if !compliance.Staff.TotpEnrolled || compliance.Staff.Roles[0] != api.StaffRole("compliance") {
		t.Fatalf("staff = %+v", compliance.Staff)
	}

	// x-roles: the approvals queue is compliance, finance and admin only.
	call[api.Problem](t, h, http.MethodGet, "/v1/admin/approvals", support.AccessToken, nil, http.StatusForbidden)
	page := call[api.ApprovalRequestPage](t, h, http.MethodGet, "/v1/admin/approvals", compliance.AccessToken, nil, http.StatusOK)
	if len(page.Data) != 0 {
		t.Fatalf("queue = %+v", page)
	}
	// Any signed-in staff member can see who they are.
	call[api.Staff](t, h, http.MethodGet, "/v1/admin/me", support.AccessToken, nil, http.StatusOK)

	// A customer token never opens the console, and a console token never opens the app.
	key := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{9}, ed25519.SeedSize))
	pub := base64.RawURLEncoding.EncodeToString(key.Public().(ed25519.PublicKey)) //nolint:forcetypeassert // always ed25519
	started := call[api.SignupStarted](t, h, http.MethodPost, "/v1/auth/signup", "", map[string]any{
		"first_name": "Tolu", "last_name": "Adeyemi", "email": "tolu@example.com", "phone": "+2348031234567",
		"date_of_birth": "1996-04-12",
		"consent":       map[string]string{"terms_version": "2026-10", "privacy_version": "2026-10", "accepted_at": "2026-11-01T10:00:00Z"},
	}, http.StatusCreated)
	verified := call[api.OtpVerified](t, h, http.MethodPost, "/v1/auth/otp/verify", "",
		map[string]string{"challenge_id": started.Otp.ChallengeId.String(), "code": mail.code()}, http.StatusOK)
	customer := call[api.AuthSession](t, h, http.MethodPost, "/v1/auth/signup/complete", "", map[string]any{
		"signup_id": started.SignupId, "verification_token": verified.VerificationToken, "password": "Kitchen-Mango-River-7",
		"device": map[string]any{"name": "Tolu's iPhone", "platform": "ios", "public_key": pub},
	}, http.StatusCreated)
	call[api.Problem](t, h, http.MethodGet, "/v1/admin/me", customer.AccessToken, nil, http.StatusUnauthorized)
	call[api.Problem](t, h, http.MethodGet, "/v1/users/me", compliance.AccessToken, nil, http.StatusUnauthorized)

	// Approving an unknown request is a 404, and logout ends the console session.
	call[api.Problem](t, h, http.MethodGet, "/v1/admin/approvals/"+uuid.Must(uuid.NewV7()).String(), compliance.AccessToken, nil, http.StatusNotFound)
	call[struct{}](t, h, http.MethodPost, "/v1/admin/auth/logout", compliance.AccessToken, nil, http.StatusNoContent)
	call[api.Problem](t, h, http.MethodGet, "/v1/admin/me", compliance.AccessToken, nil, http.StatusUnauthorized)
}
