package assistant

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
)

// API adapts the service to the contract's strict server; the router embeds it. A nil *API
// answers 501. ConfirmAssistantAction is not here: confirming runs a real money endpoint with
// the customer's PIN and device signature, and arrives with the integration milestone.
type API struct{ svc *Service }

// NewAPI returns the assistant operations for the router.
func NewAPI(svc *Service) *API { return &API{svc: svc} }

// StartAssistantConversation is POST /v1/assistant/conversations.
func (a *API) StartAssistantConversation(ctx context.Context, _ api.StartAssistantConversationRequestObject) (api.StartAssistantConversationResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	c, err := a.svc.Start(ctx)
	if err != nil {
		return nil, err
	}
	return api.StartAssistantConversation201JSONResponse{Id: c.ID, CreatedAt: c.CreatedAt, Ai: api.AiMeta{
		Feature: api.AiMetaFeatureAssistant, ModelVersion: "gateway-v1", FallbackUsed: false,
		Explanation: "Nem Assistant answers with a free language model that only sees redacted text and totals. It can draft actions, never send money.",
	}}, nil
}

// ListAssistantMessages is GET /v1/assistant/conversations/{id}/messages.
func (a *API) ListAssistantMessages(ctx context.Context, req api.ListAssistantMessagesRequestObject) (api.ListAssistantMessagesResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	var cursor *string
	if req.Params.Cursor != nil {
		c := string(*req.Params.Cursor)
		cursor = &c
	}
	var limit *int
	if req.Params.Limit != nil {
		l := int(*req.Params.Limit)
		limit = &l
	}
	msgs, page, err := a.svc.Messages(ctx, req.ConversationId, cursor, limit)
	if err != nil {
		return nil, err
	}
	return api.ListAssistantMessages200JSONResponse{Data: msgs, Page: page}, nil
}

// SendAssistantMessage is POST /v1/assistant/conversations/{id}/messages. With
// `Accept: text/event-stream` the answer streams as server-sent events; otherwise it is one
// JSON message. Either way every refusal (caps, unavailable) is decided before the first
// byte, so it is an ordinary problem response.
func (a *API) SendAssistantMessage(ctx context.Context, req api.SendAssistantMessageRequestObject) (api.SendAssistantMessageResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	if req.Body == nil {
		return nil, problem.New(http.StatusBadRequest, problem.CodeValidationFailed, "A question is required")
	}
	lang := "en"
	if req.Body.Language != nil {
		lang = string(*req.Body.Language)
	}
	turn, err := a.svc.Begin(ctx, req.ConversationId, req.Body.Text, lang)
	if err != nil {
		return nil, err
	}
	if gc, ok := ctx.(*gin.Context); ok && strings.Contains(gc.GetHeader("Accept"), "text/event-stream") {
		return stream{ctx: ctx, turn: turn}, nil
	}
	msg, err := turn.Run(ctx, nil)
	if err != nil {
		return nil, err
	}
	return api.SendAssistantMessage201JSONResponse(msg), nil
}

// DiscardAssistantAction is POST /v1/assistant/actions/{id}/discard.
func (a *API) DiscardAssistantAction(ctx context.Context, req api.DiscardAssistantActionRequestObject) (api.DiscardAssistantActionResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	act, err := a.svc.Discard(ctx, req.ActionId)
	if err != nil {
		return nil, err
	}
	return api.DiscardAssistantAction200JSONResponse(act), nil
}

// stream answers as server-sent events:
//
//	event: tool     {"name": "spending_by_category"}   a tool started
//	event: delta    {"text": "You spent "}             words, already filtered
//	event: message  <AssistantMessage>                 the final answer
//	event: error    {"code": "...", "title": "..."}    the model failed mid-way
//
// The deltas are a live preview: they are filtered word by word, but only the `message`
// event is authoritative, and a client should replace the preview with it.
type stream struct {
	ctx  context.Context
	turn *Turn
}

func (s stream) VisitSendAssistantMessageResponse(w http.ResponseWriter) error {
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-store")
	h.Set("X-Accel-Buffering", "no") // proxies must not hold the stream back
	w.WriteHeader(http.StatusOK)
	flush := func() {
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
	}
	send := func(event string, v any) error {
		raw, err := json.Marshal(v)
		if err != nil {
			return err
		}
		if _, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, raw); err != nil {
			return err
		}
		flush()
		return nil
	}
	flush()
	msg, err := s.turn.Run(s.ctx, func(e Event) {
		switch {
		case e.Tool != "":
			_ = send("tool", map[string]string{"name": e.Tool})
		case e.Delta != "":
			_ = send("delta", map[string]string{"text": e.Delta})
		}
	})
	if err != nil {
		code, title := problem.CodeInternal, "Something went wrong."
		var pe *problem.Error
		if errors.As(err, &pe) {
			code, title = pe.Code, pe.Title
		}
		return send("error", map[string]string{"code": code, "title": title})
	}
	return send("message", msg)
}
