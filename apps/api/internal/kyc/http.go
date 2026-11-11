package kyc

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/jobs"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/realtime"
)

// API adapts the service to the contract's strict server; the router embeds it. A nil *API
// answers 501. (The optional ID prefill is PrefillAPI.)
type API struct{ svc *Service }

// NewAPI returns the KYC operations for the router.
func NewAPI(svc *Service) *API { return &API{svc: svc} }

// deref reads a write-only string the contract makes optional; empty fails the format check.
func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// GetKycOverview is GET /v1/kyc.
func (a *API) GetKycOverview(ctx context.Context, _ api.GetKycOverviewRequestObject) (api.GetKycOverviewResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	o, err := a.svc.Overview(ctx)
	if err != nil {
		return nil, err
	}
	return api.GetKycOverview200JSONResponse(o), nil
}

// VerifyIdentityNumber is POST /v1/kyc/identity.
func (a *API) VerifyIdentityNumber(ctx context.Context, req api.VerifyIdentityNumberRequestObject) (api.VerifyIdentityNumberResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	var dob *time.Time
	if req.Body.DateOfBirth != nil {
		t := req.Body.DateOfBirth.Time
		dob = &t
	}
	v, err := a.svc.VerifyIdentity(ctx, Kind(req.Body.Type), deref(req.Body.Number), dob)
	if err != nil {
		return nil, err
	}
	return api.VerifyIdentityNumber200JSONResponse(v), nil
}

// UploadKycDocument is POST /v1/kyc/documents.
func (a *API) UploadKycDocument(ctx context.Context, req api.UploadKycDocumentRequestObject) (api.UploadKycDocumentResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	d, err := a.svc.Upload(ctx, req.Body)
	if err != nil {
		return nil, err
	}
	return api.UploadKycDocument201JSONResponse(d), nil
}

// SubmitKyc is POST /v1/kyc/submissions.
func (a *API) SubmitKyc(ctx context.Context, req api.SubmitKycRequestObject) (api.SubmitKycResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	b := req.Body
	in := SubmitRequest{IDType: string(b.IdType), IDNumber: deref(b.IdNumber), DocumentIDs: b.DocumentIds, Address: b.Address}
	if b.IdExpiryDate != nil {
		t := b.IdExpiryDate.Time
		in.IDExpiry = &t
	}
	sub, err := a.svc.Submit(ctx, in)
	if err != nil {
		return nil, err
	}
	return api.SubmitKyc201JSONResponse(sub), nil
}

// GetKycSubmission is GET /v1/kyc/submissions/{submission_id}.
func (a *API) GetKycSubmission(ctx context.Context, req api.GetKycSubmissionRequestObject) (api.GetKycSubmissionResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	sub, err := a.svc.Submission(ctx, req.SubmissionId)
	if err != nil {
		return nil, err
	}
	return api.GetKycSubmission200JSONResponse(sub), nil
}

// RealtimeSubscriber tells the customer's open app their tier or review status changed
// (kyc.updated), so the verification screen moves without a refresh.
func (s *Service) RealtimeSubscriber(hub *realtime.Hub) jobs.Subscriber {
	return jobs.Subscriber{
		Name:   "realtime_kyc",
		Topics: []string{TopicUpdated},
		Handle: func(_ context.Context, d jobs.Delivery) error {
			var e struct {
				UserID     uuid.UUID        `json:"user_id"`
				Tier       int              `json:"tier"`
				Status     string           `json:"status"`
				Submission *json.RawMessage `json:"submission"`
			}
			if err := json.Unmarshal(d.Payload, &e); err != nil {
				return fmt.Errorf("kyc event payload: %w", err)
			}
			return hub.Publish(e.UserID, realtime.Event{
				ID: uuid.NewSHA1(d.ID, []byte(TopicUpdated)), Type: TopicUpdated, OccurredAt: d.CreatedAt.UTC(),
				Data: map[string]any{"tier": e.Tier, "status": e.Status, "submission": e.Submission},
			})
		},
	}
}
