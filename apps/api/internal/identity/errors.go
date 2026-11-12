package identity

import (
	"net/http"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
)

// Domain problems. Codes and status codes match the app's mock bank
// (apps/mobile/src/data/mock/domains/auth.ts), so the app handles both sources the same.
var (
	ErrEmailTaken = problem.New(http.StatusConflict, "email_taken", "An account already uses this email").
			WithFields(problem.Field("/email", "taken", "An account already uses this email. Log in instead."))
	ErrPhoneTaken = problem.New(http.StatusConflict, "phone_taken", "An account already uses this phone number").
			WithFields(problem.Field("/phone", "taken", "An account already uses this phone number. Log in instead."))
	ErrUnderage = problem.Validation(problem.Field("/date_of_birth", "under_18", "You must be 18 or older to open an account."))

	ErrChallengeNotFound = problem.New(http.StatusNotFound, problem.CodeNotFound, "This code has expired. Ask for a new one.")
	ErrOTPExpired        = problem.New(http.StatusGone, "otp_expired", "This code has expired. Ask for a new one.")
	ErrOTPInvalid        = problem.New(http.StatusUnprocessableEntity, "invalid_otp", "That code is not right")
	ErrOTPExhausted      = problem.New(http.StatusTooManyRequests, problem.CodeRateLimited, "Too many wrong codes. Ask for a new one.")
	ErrTooManyCodes      = problem.New(http.StatusTooManyRequests, problem.CodeRateLimited, "Too many codes sent to this email. Try again later.")
	ErrResendTooSoon     = problem.New(http.StatusTooManyRequests, problem.CodeRateLimited, "Wait a moment before asking for another code.")
	ErrEmailUnavailable  = problem.New(http.StatusServiceUnavailable, "email_unavailable", "We could not send the code. Try again shortly.")

	ErrNotVerified  = problem.New(http.StatusForbidden, "invalid_otp", "Verify your email first")
	ErrWeakPassword = problem.New(http.StatusUnprocessableEntity, "weak_password", "Pick a stronger password")
	// ErrAccountFrozen answers a frozen customer (staff froze the account, ADM-3). It is only
	// shown after the password was right, so it tells a stranger nothing.
	ErrAccountFrozen = problem.New(http.StatusForbidden, "account_frozen", "This account is frozen").
				WithDetail("Contact support to find out why and how to restore access.")
	// ErrOutgoingBlocked answers a payment while the customer's panic mode is on (SEC-4). The code
	// is the mock bank's, so the app shows the same message.
	ErrOutgoingBlocked = problem.New(http.StatusForbidden, "outgoing_blocked", "Outgoing payments are paused").
				WithDetail("Panic mode is on. Release it in the Security Center to send money again.")
	errSignupExpired = problem.New(http.StatusGone, "otp_expired", "This sign-up has expired. Start again.")
)
