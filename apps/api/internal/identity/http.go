package identity

import (
	"context"
	"time"

	"github.com/google/uuid"
	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity/identitydb"
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

func userJSON(u identitydb.User) api.User {
	out := api.User{
		Id: u.ID, FirstName: u.FirstName, LastName: u.LastName, PreferredName: u.PreferredName,
		Email: openapi_types.Email(u.Email), Phone: u.Phone,
		DateOfBirth: openapi_types.Date{Time: u.DateOfBirth},
		Nemtag:      u.Nemtag, KycTier: api.KycTier(u.KycTier), KycStatus: api.KycStatus(u.KycStatus),
		IsDemo: u.IsDemo, CreatedAt: u.CreatedAt.UTC(), HasPin: u.PinHash != nil,
	}
	if u.NemtagChangedAt != nil {
		// A tag can change once every 30 days (the contract's nemtag_changeable_at).
		t := u.NemtagChangedAt.Add(30 * 24 * time.Hour).UTC()
		out.NemtagChangeableAt = &t
	}
	return out
}

func deviceJSON(d identitydb.Device, current uuid.UUID, now time.Time) api.Device {
	out := api.Device{
		Id: d.ID, Name: d.Name, Platform: api.Platform(d.Platform), Current: d.ID == current,
		Trusted:        d.CoolOffUntil == nil || !now.Before(*d.CoolOffUntil),
		HardwareBacked: d.HardwareBacked, KeyFingerprint: KeyFingerprint(d.PublicKey),
		BoundAt: d.BoundAt.UTC(), LastSeenAt: d.LastSeenAt.UTC(),
	}
	if d.CoolOffUntil != nil {
		t := d.CoolOffUntil.UTC()
		out.CoolOffUntil = &t
	}
	return out
}

func (a *API) sessionJSON(r AuthResult) api.AuthSession {
	return api.AuthSession{
		AccessToken: r.AccessToken, AccessTokenExpiresAt: r.AccessTokenExpiresAt.UTC(),
		RefreshToken: r.RefreshToken, RefreshTokenExpiresAt: r.RefreshTokenExpiresAt.UTC(),
		TokenType: api.Bearer, User: userJSON(r.User),
		Device: deviceJSON(r.Device, r.Device.ID, a.svc.now()),
	}
}

func registration(d api.DeviceRegistration) DeviceRegistration {
	return DeviceRegistration{
		Name: d.Name, Platform: string(d.Platform), PublicKey: d.PublicKey,
		AppVersion: d.AppVersion, HardwareBacked: d.HardwareBacked != nil && *d.HardwareBacked,
	}
}

// CompleteSignup is POST /v1/auth/signup/complete.
func (a *API) CompleteSignup(ctx context.Context, req api.CompleteSignupRequestObject) (api.CompleteSignupResponseObject, error) {
	b := req.Body
	r, err := a.svc.CompleteSignup(ctx, b.SignupId, b.VerificationToken, deref(b.Password), deref(b.Pin), registration(b.Device))
	if err != nil {
		return nil, err
	}
	return api.CompleteSignup201JSONResponse(a.sessionJSON(r)), nil
}

// Login is POST /v1/auth/login.
func (a *API) Login(ctx context.Context, req api.LoginRequestObject) (api.LoginResponseObject, error) {
	b := req.Body
	in := LoginInput{Identifier: b.Identifier, Password: deref(b.Password), DeviceID: b.DeviceId}
	if b.Device != nil {
		reg := registration(*b.Device)
		in.Device = &reg
	}
	r, err := a.svc.Login(ctx, in)
	if err != nil {
		return nil, err
	}
	return api.Login200JSONResponse(a.sessionJSON(r)), nil
}

// RefreshSession is POST /v1/auth/refresh.
func (a *API) RefreshSession(ctx context.Context, req api.RefreshSessionRequestObject) (api.RefreshSessionResponseObject, error) {
	r, err := a.svc.Refresh(ctx, req.Body.RefreshToken)
	if err != nil {
		return nil, err
	}
	return api.RefreshSession200JSONResponse(a.sessionJSON(r)), nil
}

// Logout is POST /v1/auth/logout.
func (a *API) Logout(ctx context.Context, req api.LogoutRequestObject) (api.LogoutResponseObject, error) {
	all := req.Body != nil && req.Body.AllDevices != nil && *req.Body.AllDevices
	if err := a.svc.Logout(ctx, all); err != nil {
		return nil, err
	}
	return api.Logout204Response{}, nil
}

// GetMe is GET /v1/users/me.
func (a *API) GetMe(ctx context.Context, _ api.GetMeRequestObject) (api.GetMeResponseObject, error) {
	u, err := a.svc.Me(ctx)
	if err != nil {
		return nil, err
	}
	return api.GetMe200JSONResponse(userJSON(u)), nil
}

// ListDevices is GET /v1/devices.
func (a *API) ListDevices(ctx context.Context, _ api.ListDevicesRequestObject) (api.ListDevicesResponseObject, error) {
	ds, p, err := a.svc.Devices(ctx)
	if err != nil {
		return nil, err
	}
	now := a.svc.now()
	out := make([]api.Device, len(ds))
	for i, d := range ds {
		out[i] = deviceJSON(d, p.DeviceID, now)
	}
	return api.ListDevices200JSONResponse{Data: out}, nil
}

// RevokeDevice is DELETE /v1/devices/{device_id}.
func (a *API) RevokeDevice(ctx context.Context, req api.RevokeDeviceRequestObject) (api.RevokeDeviceResponseObject, error) {
	if err := a.svc.RevokeDevice(ctx, req.DeviceId); err != nil {
		return nil, err
	}
	return api.RevokeDevice204Response{}, nil
}

// ListSessions is GET /v1/security/sessions.
func (a *API) ListSessions(ctx context.Context, _ api.ListSessionsRequestObject) (api.ListSessionsResponseObject, error) {
	rows, p, err := a.svc.Sessions(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]api.Session, len(rows))
	for i, r := range rows {
		out[i] = api.Session{
			Id: r.ID, DeviceId: r.DeviceID, DeviceName: r.DeviceName, Current: r.ID == p.SessionID,
			CreatedAt: r.CreatedAt.UTC(), LastActiveAt: r.LastActiveAt.UTC(),
		}
	}
	return api.ListSessions200JSONResponse{Data: out}, nil
}

// RevokeSession is DELETE /v1/security/sessions/{session_id}.
func (a *API) RevokeSession(ctx context.Context, req api.RevokeSessionRequestObject) (api.RevokeSessionResponseObject, error) {
	if err := a.svc.RevokeSession(ctx, req.SessionId); err != nil {
		return nil, err
	}
	return api.RevokeSession204Response{}, nil
}

// deref reads an optional generated field; writeOnly secrets are generated as pointers
// even when required (the validator has already refused a missing one).
func deref[T any](p *T) T {
	var zero T
	if p == nil {
		return zero
	}
	return *p
}

// SetPin is PUT /v1/users/me/pin.
func (a *API) SetPin(ctx context.Context, req api.SetPinRequestObject) (api.SetPinResponseObject, error) {
	if err := a.svc.SetPin(ctx, deref(req.Body.Pin)); err != nil {
		return nil, err
	}
	return api.SetPin204Response{}, nil
}

// VerifyPin is POST /v1/users/me/pin/verify.
func (a *API) VerifyPin(ctx context.Context, req api.VerifyPinRequestObject) (api.VerifyPinResponseObject, error) {
	r, err := a.svc.VerifyPin(ctx, deref(req.Body.Pin))
	if err != nil {
		return nil, err
	}
	out := api.VerifyPin200JSONResponse{Valid: r.Valid, AttemptsRemaining: r.AttemptsLeft}
	if r.LockedUntil != nil {
		t := r.LockedUntil.UTC()
		out.LockedUntil = &t
	}
	return out, nil
}

// ResetPin is POST /v1/users/me/pin/reset.
func (a *API) ResetPin(ctx context.Context, req api.ResetPinRequestObject) (api.ResetPinResponseObject, error) {
	if err := a.svc.ResetPin(ctx, req.Params.XStepUpToken, deref(req.Body.Pin)); err != nil {
		return nil, err
	}
	return api.ResetPin204Response{}, nil
}

// SetDuressPin is PUT /v1/security/duress-pin.
func (a *API) SetDuressPin(ctx context.Context, req api.SetDuressPinRequestObject) (api.SetDuressPinResponseObject, error) {
	if err := a.svc.SetDuressPin(ctx, req.Params.XStepUpToken, deref(req.Body.Pin)); err != nil {
		return nil, err
	}
	return api.SetDuressPin204Response{}, nil
}

// RemoveDuressPin is DELETE /v1/security/duress-pin.
func (a *API) RemoveDuressPin(ctx context.Context, req api.RemoveDuressPinRequestObject) (api.RemoveDuressPinResponseObject, error) {
	if err := a.svc.RemoveDuressPin(ctx, req.Params.XStepUpToken); err != nil {
		return nil, err
	}
	return api.RemoveDuressPin204Response{}, nil
}

// StartStepUp is POST /v1/auth/step-up.
func (a *API) StartStepUp(ctx context.Context, req api.StartStepUpRequestObject) (api.StartStepUpResponseObject, error) {
	st, err := a.svc.StartStepUp(ctx, string(req.Body.Purpose))
	if err != nil {
		return nil, err
	}
	methods := make([]api.StepUpMethod, len(st.Methods))
	for i, m := range st.Methods {
		methods[i] = api.StepUpMethod(m)
	}
	otp := challengeJSON(st.Challenge)
	return api.StartStepUp201JSONResponse{
		StepUpId: st.ID, Purpose: api.StepUpPurpose(st.Purpose), Methods: methods,
		Otp: &otp, ExpiresAt: st.ExpiresAt.UTC(),
	}, nil
}

// VerifyStepUp is POST /v1/auth/step-up/{step_up_id}/verify.
func (a *API) VerifyStepUp(ctx context.Context, req api.VerifyStepUpRequestObject) (api.VerifyStepUpResponseObject, error) {
	b := req.Body
	tok, err := a.svc.VerifyStepUp(ctx, req.StepUpId, StepUpProof{
		OTPCode: b.OtpCode, Pin: b.Pin, Signature: b.Signature, SecurityAnswer: b.SecurityAnswer,
	})
	if err != nil {
		return nil, err
	}
	return api.VerifyStepUp200JSONResponse{
		StepUpToken: tok.Token, Purpose: api.StepUpPurpose(tok.Purpose), ExpiresAt: tok.ExpiresAt.UTC(),
	}, nil
}
