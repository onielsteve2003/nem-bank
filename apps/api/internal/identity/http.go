package identity

import (
	"context"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
)

// API adapts the service to the contract's strict server. The router embeds it, so each
// method here replaces the Unimplemented 501 for its operation. Request bodies have
// already passed contract validation.
type API struct {
	svc *Service
}

// NewAPI returns the identity operations for the router.
func NewAPI(svc *Service) *API { return &API{svc: svc} }

func challengeJSON(c Challenge) api.OtpChallenge {
	return api.OtpChallenge{
		ChallengeId:       c.ID,
		Channel:           api.OtpChallengeChannelEmail,
		DestinationMasked: MaskEmail(c.Destination),
		ExpiresAt:         c.ExpiresAt.UTC(),
		ResendAvailableAt: c.ResendAt.UTC(),
		AttemptsRemaining: c.AttemptsLeft,
	}
}

// StartSignup is POST /v1/auth/signup.
func (a *API) StartSignup(ctx context.Context, req api.StartSignupRequestObject) (api.StartSignupResponseObject, error) {
	b := req.Body
	started, err := a.svc.StartSignup(ctx, SignupDetails{
		FirstName: b.FirstName, LastName: b.LastName, Email: string(b.Email), Phone: b.Phone,
		DateOfBirth: b.DateOfBirth.Time, TermsVersion: b.Consent.TermsVersion,
		PrivacyVersion: b.Consent.PrivacyVersion, ConsentAcceptedAt: b.Consent.AcceptedAt,
	})
	if err != nil {
		return nil, err
	}
	return api.StartSignup201JSONResponse{SignupId: started.SignupID, Otp: challengeJSON(started.Challenge)}, nil
}

// VerifyOtp is POST /v1/auth/otp/verify.
func (a *API) VerifyOtp(ctx context.Context, req api.VerifyOtpRequestObject) (api.VerifyOtpResponseObject, error) {
	v, err := a.svc.VerifyCode(ctx, req.Body.ChallengeId, req.Body.Code)
	if err != nil {
		return nil, err
	}
	return api.VerifyOtp200JSONResponse{VerificationToken: v.Token, ExpiresAt: v.ExpiresAt.UTC()}, nil
}

// ResendOtp is POST /v1/auth/otp/resend.
func (a *API) ResendOtp(ctx context.Context, req api.ResendOtpRequestObject) (api.ResendOtpResponseObject, error) {
	c, err := a.svc.ResendCode(ctx, req.Body.ChallengeId)
	if err != nil {
		return nil, err
	}
	return api.ResendOtp200JSONResponse(challengeJSON(c)), nil
}
