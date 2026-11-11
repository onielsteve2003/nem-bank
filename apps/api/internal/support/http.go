package support

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/jobs"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/realtime"
)

// API adapts the service to the contract's strict server; the router embeds it. A nil *API
// answers 501.
type API struct{ svc *Service }

// NewAPI returns the dispute and support operations for the router.
func NewAPI(svc *Service) *API { return &API{svc: svc} }

// ListDisputes is GET /v1/disputes.
func (a *API) ListDisputes(ctx context.Context, req api.ListDisputesRequestObject) (api.ListDisputesResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	rows, page, err := a.svc.Disputes(ctx, req.Params.Cursor, req.Params.Limit)
	if err != nil {
		return nil, err
	}
	return api.ListDisputes200JSONResponse(api.DisputePage{Data: rows, Page: page}), nil
}

// CreateDispute is POST /v1/disputes.
func (a *API) CreateDispute(ctx context.Context, req api.CreateDisputeRequestObject) (api.CreateDisputeResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	b := req.Body
	in := CreateDisputeRequest{TransactionID: b.TransactionId, Reason: string(b.Reason), Description: b.Description}
	if b.AttachmentIds != nil {
		in.AttachmentIDs = *b.AttachmentIds
	}
	d, err := a.svc.CreateDispute(ctx, in)
	if err != nil {
		return nil, err
	}
	return api.CreateDispute201JSONResponse(d), nil
}

// GetDispute is GET /v1/disputes/{dispute_id}.
func (a *API) GetDispute(ctx context.Context, req api.GetDisputeRequestObject) (api.GetDisputeResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	d, err := a.svc.Dispute(ctx, req.DisputeId)
	if err != nil {
		return nil, err
	}
	return api.GetDispute200JSONResponse(d), nil
}

// AddDisputeEvidence is POST /v1/disputes/{dispute_id}/evidence.
func (a *API) AddDisputeEvidence(ctx context.Context, req api.AddDisputeEvidenceRequestObject) (api.AddDisputeEvidenceResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	d, err := a.svc.AddEvidence(ctx, req.DisputeId, req.Body)
	if err != nil {
		return nil, err
	}
	return api.AddDisputeEvidence201JSONResponse(d), nil
}

// WithdrawDispute is POST /v1/disputes/{dispute_id}/withdraw.
func (a *API) WithdrawDispute(ctx context.Context, req api.WithdrawDisputeRequestObject) (api.WithdrawDisputeResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	d, err := a.svc.Withdraw(ctx, req.DisputeId)
	if err != nil {
		return nil, err
	}
	return api.WithdrawDispute200JSONResponse(d), nil
}

// ListSupportConversations is GET /v1/support/conversations.
func (a *API) ListSupportConversations(ctx context.Context, _ api.ListSupportConversationsRequestObject) (api.ListSupportConversationsResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	rows, err := a.svc.Conversations(ctx)
	if err != nil {
		return nil, err
	}
	return api.ListSupportConversations200JSONResponse(api.SupportConversationList{Data: rows}), nil
}

// StartSupportConversation is POST /v1/support/conversations.
func (a *API) StartSupportConversation(ctx context.Context, req api.StartSupportConversationRequestObject) (api.StartSupportConversationResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	c, err := a.svc.StartConversation(ctx, req.Body.Subject, req.Body.Message, req.Body.TransactionId)
	if err != nil {
		return nil, err
	}
	return api.StartSupportConversation201JSONResponse(c), nil
}

// GetSupportConversation is GET /v1/support/conversations/{conversation_id}.
func (a *API) GetSupportConversation(ctx context.Context, req api.GetSupportConversationRequestObject) (api.GetSupportConversationResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	c, err := a.svc.Conversation(ctx, req.ConversationId)
	if err != nil {
		return nil, err
	}
	return api.GetSupportConversation200JSONResponse(c), nil
}

// ListSupportMessages is GET /v1/support/conversations/{conversation_id}/messages.
func (a *API) ListSupportMessages(ctx context.Context, req api.ListSupportMessagesRequestObject) (api.ListSupportMessagesResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	rows, page, err := a.svc.Messages(ctx, req.ConversationId, req.Params.Cursor, req.Params.Limit)
	if err != nil {
		return nil, err
	}
	return api.ListSupportMessages200JSONResponse(api.SupportMessagePage{Data: rows, Page: page}), nil
}

// SendSupportMessage is POST /v1/support/conversations/{conversation_id}/messages.
func (a *API) SendSupportMessage(ctx context.Context, req api.SendSupportMessageRequestObject) (api.SendSupportMessageResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	var ids []uuid.UUID
	if req.Body.AttachmentIds != nil {
		ids = *req.Body.AttachmentIds
	}
	m, err := a.svc.SendMessage(ctx, req.ConversationId, req.Body.Body, ids)
	if err != nil {
		return nil, err
	}
	return api.SendSupportMessage201JSONResponse(m), nil
}

// UploadSupportAttachment is POST /v1/support/attachments.
func (a *API) UploadSupportAttachment(ctx context.Context, req api.UploadSupportAttachmentRequestObject) (api.UploadSupportAttachmentResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	att, err := a.svc.Upload(ctx, req.Body, "support")
	if err != nil {
		return nil, err
	}
	return api.UploadSupportAttachment201JSONResponse(att), nil
}

// FilesPath is the signed attachment route: not a contract operation, because the link itself
// is the credential (an image tag cannot send a bearer token).
const FilesPath = "/v1/files/:id"

// FilesHandler serves GET /v1/files/:id?exp=&sig=. A nil *API answers 404.
func (a *API) FilesHandler(c *gin.Context) {
	if a == nil {
		c.Status(404)
		return
	}
	a.svc.Serve(c.Writer, c.Request, c.Param("id"), c.Query("exp"), c.Query("sig"))
}

// RealtimeSubscriber pushes dispute and chat changes to the customer's open app: dispute.updated
// with the dispute as it is now, support.message with the message.
func (s *Service) RealtimeSubscriber(hub *realtime.Hub) jobs.Subscriber {
	return jobs.Subscriber{
		Name:   "realtime_support",
		Topics: []string{TopicDisputeUpdated, TopicMessage},
		Handle: func(ctx context.Context, d jobs.Delivery) error {
			var e struct {
				UserID    uuid.UUID `json:"user_id"`
				DisputeID uuid.UUID `json:"dispute_id"`
				MessageID uuid.UUID `json:"message_id"`
			}
			if err := json.Unmarshal(d.Payload, &e); err != nil {
				return fmt.Errorf("%s payload: %w", d.Topic, err)
			}
			ev := realtime.Event{ID: uuid.NewSHA1(d.ID, []byte(d.Topic)), Type: d.Topic, OccurredAt: d.CreatedAt.UTC()}
			switch d.Topic {
			case TopicDisputeUpdated:
				row, err := s.q.GetDisputeAny(ctx, e.DisputeID)
				if err != nil {
					return fmt.Errorf("load dispute: %w", err)
				}
				if ev.Data, err = s.disputeJSON(ctx, s.q, row); err != nil {
					return err
				}
			case TopicMessage:
				row, err := s.q.GetMessage(ctx, e.MessageID)
				if err != nil {
					return fmt.Errorf("load message: %w", err)
				}
				if ev.Data, err = s.messageJSON(ctx, s.q, row); err != nil {
					return err
				}
			}
			return hub.Publish(e.UserID, ev)
		},
	}
}
