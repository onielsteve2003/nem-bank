package admin

import (
	"net/http"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
)

// Domain problems. Codes and status codes match the console's mock back office
// (apps/console/src/data/mock/auth.ts and approvals.ts), so the console handles both alike.
var (
	// One message for a wrong email or password, so the form cannot be used to find staff.
	ErrInvalidCredentials = problem.New(http.StatusUnauthorized, "invalid_credentials", "Email or password is wrong")
	ErrChallengeExpired   = problem.New(http.StatusUnauthorized, "otp_expired", "That sign-in expired. Start again.")
	ErrInvalidTOTP        = problem.New(http.StatusUnauthorized, "invalid_otp", "That code is wrong or already used")
	ErrTOTPExhausted      = problem.New(http.StatusTooManyRequests, problem.CodeRateLimited, "Too many wrong codes. Start again.")
	ErrSessionEnded       = problem.New(http.StatusUnauthorized, "session_revoked", "Your console session has ended. Sign in again.")

	ErrSameStaff = problem.New(http.StatusForbidden, "same_staff", "Someone else has to approve this").
			WithDetail("You made this request. A second staff member must check it (maker-checker).")
	ErrApprovalExpired = problem.New(http.StatusConflict, "approval_expired", "This request expired").
				WithDetail("Ask the maker to send it again if it is still needed.")
	ErrApprovalNotFound = problem.NotFound("Approval request")
	ErrCheckerRole      = problem.New(http.StatusForbidden, problem.CodeForbidden, "Your role cannot approve this kind of request")
	ErrUnknownAction    = problem.New(http.StatusUnprocessableEntity, "unknown_action", "This change cannot go through maker-checker yet")
	ErrBadReason        = problem.Validation(problem.Field("/reason", "too_small", "Give a reason of 5 to 500 characters."))
)
