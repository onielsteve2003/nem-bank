package support

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/audit"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/pagination"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/realtime"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/support/supportdb"
)

// TopicMessage is the outbox event for a chat message from either side.
const TopicMessage = "support.message"

// Problems.
var (
	// ErrConversationNotFound is the 404 for a chat the caller does not have.
	ErrConversationNotFound = problem.NotFound("Conversation")
	errChatClosed           = problem.New(http.StatusConflict, "conversation_resolved", "This chat is closed").WithDetail("Start a new chat if you still need help.")
)

// whose messages each side reads: a customer reads the agent's and the system's; an agent reads
// the customer's.
var (
	customerReads = []string{"agent", "system"}
	agentReads    = []string{"customer"}
)

// Agent is a support staff member acting in a chat.
type Agent struct {
	ID    uuid.UUID
	Name  string // full name; the customer sees only the first
	Actor audit.Actor
}

func firstName(full string) string {
	if f := strings.Fields(full); len(f) > 0 {
		return f[0]
	}
	return "Support"
}

// StartConversation opens a chat with a first message (SUP-1) and hands it to the support agent
// with the fewest open chats. With no agent available it still opens: a system message says
// someone will join, and the console's inbox shows it unassigned.
func (s *Service) StartConversation(ctx context.Context, subject, message string, transactionID *uuid.UUID) (api.SupportConversation, error) {
	p, err := principal(ctx)
	if err != nil {
		return api.SupportConversation{}, err
	}
	subject, message = strings.TrimSpace(subject), strings.TrimSpace(message)
	if n := utf8.RuneCountInString(subject); n < 1 || n > 80 {
		return api.SupportConversation{}, problem.Validation(problem.Field("/subject", "length", "Give the chat a subject of up to 80 characters."))
	}
	if n := utf8.RuneCountInString(message); n < 1 || n > 2000 {
		return api.SupportConversation{}, problem.Validation(problem.Field("/message", "length", "Write a message of up to 2,000 characters."))
	}
	now := s.now().UTC()
	recent, err := s.q.CountStartedSince(ctx, supportdb.CountStartedSinceParams{UserID: p.UserID, Since: now.Add(-24 * time.Hour)})
	if err != nil {
		return api.SupportConversation{}, fmt.Errorf("count chats: %w", err)
	}
	if recent >= chatsPerDay {
		return api.SupportConversation{}, problem.RateLimited(now.Add(24 * time.Hour))
	}
	id, err := uuid.NewV7()
	if err != nil {
		return api.SupportConversation{}, fmt.Errorf("conversation id: %w", err)
	}
	var conv supportdb.SupportConversation
	err = s.inTx(ctx, func(tx pgx.Tx, q *supportdb.Queries) error {
		if transactionID != nil {
			t, err := q.GetTransactionAny(ctx, *transactionID)
			if errors.Is(err, pgx.ErrNoRows) || (err == nil && t.UserID != p.UserID) {
				return problem.NotFound("Transaction")
			}
			if err != nil {
				return fmt.Errorf("load transaction: %w", err)
			}
		}
		params := supportdb.InsertConversationParams{ID: id, UserID: p.UserID, Subject: subject, TransactionID: transactionID, At: now}
		agent, err := q.PickAgent(ctx)
		switch {
		case err == nil:
			name := firstName(agent.Name)
			params.AgentID, params.AgentName = &agent.ID, &name
		case !errors.Is(err, pgx.ErrNoRows):
			return fmt.Errorf("pick agent: %w", err)
		}
		if conv, err = q.InsertConversation(ctx, params); err != nil {
			return fmt.Errorf("insert conversation: %w", err)
		}
		if _, err := s.addMessage(ctx, tx, q, conv, "customer", nil, message, nil, now); err != nil {
			return err
		}
		welcome := "An agent will join shortly. You can keep typing; we will reply here and send you a notification."
		if params.AgentName != nil {
			welcome = *params.AgentName + " from support will reply here."
		}
		_, err = s.addMessage(ctx, tx, q, conv, "system", nil, welcome, nil, now.Add(time.Millisecond))
		return err
	})
	if err != nil {
		return api.SupportConversation{}, err
	}
	return s.conversationJSON(ctx, s.q, conv, customerReads)
}

// addMessage inserts a message, touches the chat and writes the outbox event, in the caller's tx.
func (s *Service) addMessage(ctx context.Context, tx pgx.Tx, q *supportdb.Queries, conv supportdb.SupportConversation, sender string, senderName *string, body string, attachments []uuid.UUID, at time.Time) (supportdb.SupportMessage, error) {
	id, err := uuid.NewV7()
	if err != nil {
		return supportdb.SupportMessage{}, fmt.Errorf("message id: %w", err)
	}
	if attachments == nil {
		attachments = []uuid.UUID{}
	}
	m, err := q.InsertMessage(ctx, supportdb.InsertMessageParams{
		ID: id, ConversationID: conv.ID, Sender: sender, SenderName: senderName, Body: body, AttachmentIds: attachments, CreatedAt: at,
	})
	if err != nil {
		return supportdb.SupportMessage{}, fmt.Errorf("insert message: %w", err)
	}
	status := conv.Status
	switch sender {
	case "customer":
		status = "open"
	case "agent":
		status = "waiting_on_customer"
	}
	last := conv.LastMessageAt
	if at.After(last) {
		last = at
	}
	if status != conv.Status || last != conv.LastMessageAt {
		if _, err := q.TouchConversation(ctx, supportdb.TouchConversationParams{ID: conv.ID, At: last, Status: status}); err != nil {
			return supportdb.SupportMessage{}, fmt.Errorf("touch conversation: %w", err)
		}
	}
	return m, emit(ctx, tx, TopicMessage, "support_message", m.ID, map[string]any{
		"user_id": conv.UserID, "conversation_id": conv.ID, "message_id": m.ID, "sender": sender,
	})
}

func (s *Service) conversationJSON(ctx context.Context, q *supportdb.Queries, c supportdb.SupportConversation, reads []string) (api.SupportConversation, error) {
	// Re-read: the first message in the same transaction may have moved last_message_at.
	if fresh, err := q.GetConversationAny(ctx, c.ID); err == nil {
		c = fresh
	}
	unread, err := q.CountUnreadFor(ctx, supportdb.CountUnreadForParams{ConversationID: c.ID, Senders: reads})
	if err != nil {
		return api.SupportConversation{}, fmt.Errorf("count unread: %w", err)
	}
	return api.SupportConversation{
		Id: c.ID, Subject: c.Subject, Status: api.SupportConversationStatus(c.Status), AssignedAgent: c.AgentName,
		UnreadCount: int(unread), LastMessageAt: c.LastMessageAt.UTC(), CreatedAt: c.CreatedAt.UTC(),
	}, nil
}

func (s *Service) messageJSON(ctx context.Context, q *supportdb.Queries, m supportdb.SupportMessage) (api.SupportMessage, error) {
	atts, err := s.attachments(ctx, q, m.AttachmentIds)
	if err != nil {
		return api.SupportMessage{}, err
	}
	out := api.SupportMessage{
		Id: m.ID, ConversationId: m.ConversationID, Sender: api.SupportMessageSender(m.Sender), SenderName: m.SenderName,
		Body: m.Body, Attachments: atts, CreatedAt: m.CreatedAt.UTC(),
	}
	if m.ReadAt != nil {
		t := m.ReadAt.UTC()
		out.ReadAt = &t
	}
	return out, nil
}

// Conversations lists the customer's chats, open ones first.
func (s *Service) Conversations(ctx context.Context) ([]api.SupportConversation, error) {
	p, err := principal(ctx)
	if err != nil {
		return nil, err
	}
	rows, err := s.q.ListConversations(ctx, p.UserID)
	if err != nil {
		return nil, fmt.Errorf("list conversations: %w", err)
	}
	out := make([]api.SupportConversation, len(rows))
	for i, r := range rows {
		if out[i], err = s.conversationJSON(ctx, s.q, r, customerReads); err != nil {
			return nil, err
		}
	}
	return out, nil
}

func (s *Service) ownChat(ctx context.Context, userID, id uuid.UUID) (supportdb.SupportConversation, error) {
	c, err := s.q.GetConversation(ctx, supportdb.GetConversationParams{ID: id, UserID: userID})
	if errors.Is(err, pgx.ErrNoRows) {
		return supportdb.SupportConversation{}, ErrConversationNotFound
	}
	if err != nil {
		return supportdb.SupportConversation{}, fmt.Errorf("load conversation: %w", err)
	}
	return c, nil
}

// Conversation is one of the customer's chats.
func (s *Service) Conversation(ctx context.Context, id uuid.UUID) (api.SupportConversation, error) {
	p, err := principal(ctx)
	if err != nil {
		return api.SupportConversation{}, err
	}
	c, err := s.ownChat(ctx, p.UserID, id)
	if err != nil {
		return api.SupportConversation{}, err
	}
	return s.conversationJSON(ctx, s.q, c, customerReads)
}

// Messages lists a chat newest first. Listing is reading: the agent's messages on the page are
// marked read, so the unread badge clears when the customer opens the chat.
func (s *Service) Messages(ctx context.Context, id uuid.UUID, cursor *string, limit *int) ([]api.SupportMessage, api.PageInfo, error) {
	p, err := principal(ctx)
	if err != nil {
		return nil, api.PageInfo{}, err
	}
	c, err := s.ownChat(ctx, p.UserID, id)
	if err != nil {
		return nil, api.PageInfo{}, err
	}
	return s.messages(ctx, c, cursor, limit, customerReads)
}

func (s *Service) messages(ctx context.Context, c supportdb.SupportConversation, cursor *string, limit *int, reads []string) ([]api.SupportMessage, api.PageInfo, error) {
	after, err := pagination.Decode(cursor)
	if err != nil {
		return nil, api.PageInfo{}, err
	}
	afterTime, afterID := time.Date(9999, 12, 31, 0, 0, 0, 0, time.UTC), uuid.UUID{0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff}
	if !after.IsZero() {
		afterTime, afterID = after.Time, after.ID
	}
	n := pagination.Limit(limit)
	rows, err := s.q.ListMessages(ctx, supportdb.ListMessagesParams{ConversationID: c.ID, AfterTime: afterTime, AfterID: afterID, PageSize: int32(n + 1)}) //nolint:gosec // n is at most 100
	if err != nil {
		return nil, api.PageInfo{}, fmt.Errorf("list messages: %w", err)
	}
	rows, page := pagination.Page(rows, n, func(r supportdb.SupportMessage) pagination.Cursor {
		return pagination.Cursor{Time: r.CreatedAt, ID: r.ID}
	})
	now := s.now().UTC()
	if err := s.q.MarkMessagesRead(ctx, supportdb.MarkMessagesReadParams{ConversationID: c.ID, Senders: reads, Now: &now}); err != nil {
		return nil, api.PageInfo{}, fmt.Errorf("mark read: %w", err)
	}
	out := make([]api.SupportMessage, len(rows))
	for i, r := range rows {
		if slicesContains(reads, r.Sender) && r.ReadAt == nil {
			r.ReadAt = &now
		}
		if out[i], err = s.messageJSON(ctx, s.q, r); err != nil {
			return nil, api.PageInfo{}, err
		}
	}
	return out, page, nil
}

func slicesContains(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

// SendMessage posts the customer's message. A resolved chat is closed: the customer starts a new
// one (409), so an old thread is never reopened by accident.
func (s *Service) SendMessage(ctx context.Context, id uuid.UUID, body string, attachmentIDs []uuid.UUID) (api.SupportMessage, error) {
	p, err := principal(ctx)
	if err != nil {
		return api.SupportMessage{}, err
	}
	body = strings.TrimSpace(body)
	if n := utf8.RuneCountInString(body); n < 1 || n > 2000 {
		return api.SupportMessage{}, problem.Validation(problem.Field("/body", "length", "Write a message of up to 2,000 characters."))
	}
	now := s.now().UTC()
	var m supportdb.SupportMessage
	err = s.inTx(ctx, func(tx pgx.Tx, q *supportdb.Queries) error {
		c, err := q.LockConversation(ctx, id)
		if errors.Is(err, pgx.ErrNoRows) || (err == nil && c.UserID != p.UserID) {
			return ErrConversationNotFound
		}
		if err != nil {
			return fmt.Errorf("lock conversation: %w", err)
		}
		if c.Status == "resolved" {
			return errChatClosed
		}
		if err := s.claim(ctx, q, p.UserID, attachmentIDs, "support"); err != nil {
			return err
		}
		m, err = s.addMessage(ctx, tx, q, c, "customer", nil, body, attachmentIDs, now)
		return err
	})
	if err != nil {
		return api.SupportMessage{}, err
	}
	return s.messageJSON(ctx, s.q, m)
}

// ---------------------------------------------------------------- agents

// AgentItem is one row of an agent's inbox.
type AgentItem struct {
	Conversation   supportdb.SupportConversation
	Customer       Customer
	WaitingMinutes int
}

// AgentInbox lists chats for agents, longest-waiting first. status and mine are optional filters
// (mine is an agent's ID: only chats assigned to them).
func (s *Service) AgentInbox(ctx context.Context, status string, mine *uuid.UUID, cursor *string, limit *int) ([]AgentItem, api.PageInfo, error) {
	after, err := pagination.Decode(cursor)
	if err != nil {
		return nil, api.PageInfo{}, err
	}
	n := pagination.Limit(limit)
	filter := uuid.Nil // the zero UUID means "any agent" in the query
	if mine != nil {
		filter = *mine
	}
	rows, err := s.q.ListAgentConversations(ctx, supportdb.ListAgentConversationsParams{Status: status, AgentID: filter, AfterTime: after.Time, AfterID: after.ID, PageSize: int32(n + 1)}) //nolint:gosec // n is at most 100
	if err != nil {
		return nil, api.PageInfo{}, fmt.Errorf("list agent conversations: %w", err)
	}
	rows, page := pagination.Page(rows, n, func(r supportdb.SupportConversation) pagination.Cursor {
		return pagination.Cursor{Time: r.LastMessageAt, ID: r.ID}
	})
	now := s.now()
	out := make([]AgentItem, len(rows))
	for i, r := range rows {
		cu, err := s.customer(ctx, s.q, r.UserID)
		if err != nil {
			return nil, api.PageInfo{}, err
		}
		out[i] = AgentItem{Conversation: r, Customer: cu, WaitingMinutes: int(now.Sub(r.LastMessageAt).Minutes())}
	}
	return out, page, nil
}

// ConversationJSON is the contract's SupportConversation for an agent's view (unread = the
// customer's messages the agent has not opened).
func (s *Service) ConversationJSON(ctx context.Context, c supportdb.SupportConversation) (api.SupportConversation, error) {
	return s.conversationJSON(ctx, s.q, c, agentReads)
}

// AgentMessages lists a chat for an agent and marks the customer's messages read.
func (s *Service) AgentMessages(ctx context.Context, id uuid.UUID, cursor *string, limit *int) ([]api.SupportMessage, api.PageInfo, error) {
	c, err := s.q.GetConversationAny(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, api.PageInfo{}, ErrConversationNotFound
	}
	if err != nil {
		return nil, api.PageInfo{}, fmt.Errorf("load conversation: %w", err)
	}
	return s.messages(ctx, c, cursor, limit, agentReads)
}

// Assign gives a chat to an agent (or moves it). The customer sees the agent's first name.
func (s *Service) Assign(ctx context.Context, id uuid.UUID, agent Agent) (supportdb.SupportConversation, error) {
	var out supportdb.SupportConversation
	err := s.inTx(ctx, func(tx pgx.Tx, q *supportdb.Queries) error {
		c, err := q.LockConversation(ctx, id)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrConversationNotFound
		}
		if err != nil {
			return fmt.Errorf("lock conversation: %w", err)
		}
		if c.Status == "resolved" {
			return errChatClosed
		}
		name := firstName(agent.Name)
		if out, err = q.SetConversationAgent(ctx, supportdb.SetConversationAgentParams{ID: id, AgentID: &agent.ID, AgentName: &name}); err != nil {
			return fmt.Errorf("assign: %w", err)
		}
		_, err = audit.Append(ctx, tx, audit.Input{Actor: agent.Actor, Action: "support.assign", ResourceType: "support_conversation", ResourceID: id.String()}, s.now())
		return err
	})
	return out, err
}

// Reply posts an agent's message. An unassigned chat is assigned to whoever answers first, and
// the chat now waits on the customer.
func (s *Service) Reply(ctx context.Context, id uuid.UUID, agent Agent, body string) (api.SupportMessage, error) {
	body = strings.TrimSpace(body)
	if n := utf8.RuneCountInString(body); n < 1 || n > 2000 {
		return api.SupportMessage{}, problem.Validation(problem.Field("/body", "length", "Write a message of up to 2,000 characters."))
	}
	now := s.now().UTC()
	name := firstName(agent.Name)
	var m supportdb.SupportMessage
	err := s.inTx(ctx, func(tx pgx.Tx, q *supportdb.Queries) error {
		c, err := q.LockConversation(ctx, id)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrConversationNotFound
		}
		if err != nil {
			return fmt.Errorf("lock conversation: %w", err)
		}
		if c.Status == "resolved" {
			return errChatClosed
		}
		if c.AgentID == nil {
			if c, err = q.SetConversationAgent(ctx, supportdb.SetConversationAgentParams{ID: id, AgentID: &agent.ID, AgentName: &name}); err != nil {
				return fmt.Errorf("assign: %w", err)
			}
		}
		m, err = s.addMessage(ctx, tx, q, c, "agent", &name, body, nil, now)
		return err
	})
	if err != nil {
		return api.SupportMessage{}, err
	}
	return s.messageJSON(ctx, s.q, m)
}

// Resolve closes a chat with a note in it, so the customer sees how it ended.
func (s *Service) Resolve(ctx context.Context, id uuid.UUID, agent Agent) (supportdb.SupportConversation, error) {
	now := s.now().UTC()
	var out supportdb.SupportConversation
	err := s.inTx(ctx, func(tx pgx.Tx, q *supportdb.Queries) error {
		c, err := q.LockConversation(ctx, id)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrConversationNotFound
		}
		if err != nil {
			return fmt.Errorf("lock conversation: %w", err)
		}
		if c.Status == "resolved" {
			return errChatClosed
		}
		if _, err := s.addMessage(ctx, tx, q, c, "system", nil, firstName(agent.Name)+" marked this chat as resolved. Start a new chat if you need more help.", nil, now); err != nil {
			return err
		}
		if out, err = q.SetConversationStatus(ctx, supportdb.SetConversationStatusParams{ID: id, Status: "resolved"}); err != nil {
			return fmt.Errorf("resolve: %w", err)
		}
		_, err = audit.Append(ctx, tx, audit.Input{Actor: agent.Actor, Action: "support.resolve", ResourceType: "support_conversation", ResourceID: id.String()}, now)
		return err
	})
	return out, err
}

// Typing tells the customer's open app that the agent is (or stopped) typing. It is transient:
// nothing is stored, and a customer with no open connection simply does not see it.
func (s *Service) Typing(ctx context.Context, id uuid.UUID, typing bool) error {
	c, err := s.q.GetConversationAny(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrConversationNotFound
	}
	if err != nil {
		return fmt.Errorf("load conversation: %w", err)
	}
	if s.hub == nil {
		return nil
	}
	evID, err := uuid.NewV7()
	if err != nil {
		return fmt.Errorf("typing id: %w", err)
	}
	return s.hub.Publish(c.UserID, realtime.Event{
		ID: evID, Type: "support.typing", OccurredAt: s.now().UTC(),
		Data: map[string]any{"conversation_id": id, "sender": "agent", "typing": typing},
	})
}
