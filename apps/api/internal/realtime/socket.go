package realtime

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
)

// TicketTTL is how long a ticket can be redeemed (the contract promises 30 seconds).
const TicketTTL = 30 * time.Second

// Path is where the app connects with its ticket.
const Path = "/v1/realtime"

// Config holds the service's dependencies.
type Config struct {
	Hub    *Hub
	Logger *slog.Logger
	// PublicURL is the WebSocket URL handed out with tickets (for example
	// wss://api.example.com/v1/realtime). Empty derives it from the request.
	PublicURL string
	// AllowedOrigins are the browser origins that may connect (the CORS list). Native apps
	// send no Origin and are always accepted; the ticket, not the origin, is the credential.
	AllowedOrigins []string
	Now            func() time.Time
}

// Service issues tickets and serves the socket.
type Service struct {
	hub     *Hub
	log     *slog.Logger
	url     string
	origins []string
	now     func() time.Time

	mu      sync.Mutex
	tickets map[string]ticket
}

type ticket struct {
	user    uuid.UUID
	expires time.Time
}

// New returns the service.
func New(cfg Config) (*Service, error) {
	if cfg.Hub == nil || cfg.Logger == nil {
		return nil, errors.New("realtime: hub and logger are required")
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	return &Service{
		hub: cfg.Hub, log: cfg.Logger, url: cfg.PublicURL, origins: patterns(cfg.AllowedOrigins),
		now: cfg.Now, tickets: map[string]ticket{},
	}, nil
}

// patterns turns CORS origins ("https://app.example.com") into the host patterns the
// WebSocket origin check wants.
func patterns(origins []string) []string {
	out := make([]string, 0, len(origins))
	for _, o := range origins {
		if _, host, ok := strings.Cut(o, "://"); ok {
			o = host
		}
		out = append(out, o)
	}
	return out
}

// Issue mints a single-use ticket for user.
func (s *Service) Issue(user uuid.UUID) (string, time.Time, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", time.Time{}, err
	}
	id := base64.RawURLEncoding.EncodeToString(raw)
	now := s.now()
	exp := now.Add(TicketTTL)
	s.mu.Lock()
	defer s.mu.Unlock()
	for k, t := range s.tickets { // unredeemed tickets expire in place
		if !t.expires.After(now) {
			delete(s.tickets, k)
		}
	}
	s.tickets[id] = ticket{user: user, expires: exp}
	return id, exp, nil
}

// Redeem spends a ticket: a second use, or a use after the TTL, finds nothing.
func (s *Service) Redeem(id string) (uuid.UUID, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	t, ok := s.tickets[id]
	delete(s.tickets, id)
	if !ok || !t.expires.After(s.now()) {
		return uuid.Nil, false
	}
	return t.user, true
}

// API adapts the ticket operation to the contract's strict server.
type API struct{ svc *Service }

// NewAPI returns the realtime operations for the router.
func NewAPI(svc *Service) *API { return &API{svc: svc} }

// CreateRealtimeTicket is POST /v1/realtime/tickets.
func (a *API) CreateRealtimeTicket(ctx context.Context, _ api.CreateRealtimeTicketRequestObject) (api.CreateRealtimeTicketResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	p, ok := identity.PrincipalFrom(ctx)
	if !ok {
		return nil, problem.Unauthorized()
	}
	id, exp, err := a.svc.Issue(p.UserID)
	if err != nil {
		return nil, err
	}
	url := a.svc.url
	if gc, ok := ctx.(*gin.Context); ok && url == "" {
		url = socketURL(gc.Request)
	}
	return api.CreateRealtimeTicket201JSONResponse{Ticket: id, Url: url, ExpiresAt: exp.UTC()}, nil
}

// socketURL is this server's WebSocket address as the caller reached it.
func socketURL(r *http.Request) string {
	scheme := "ws"
	if r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https" {
		scheme = "wss"
	}
	return scheme + "://" + r.Host + Path
}

// Handler is GET /v1/realtime?ticket=...: not a contract operation (a WebSocket upgrade),
// so the router mounts it directly.
func (s *Service) Handler(c *gin.Context) {
	user, ok := s.Redeem(c.Query("ticket"))
	if !ok {
		problem.Render(c, problem.Unauthorized())
		return
	}
	ws, err := websocket.Accept(c.Writer, c.Request, &websocket.AcceptOptions{OriginPatterns: s.origins})
	if err != nil {
		return // Accept has already answered the request
	}
	ws.SetReadLimit(4096)
	s.serve(c.Request.Context(), ws, user)
}

// serve runs one connection until either side ends it.
func (s *Service) serve(parent context.Context, ws *websocket.Conn, user uuid.UUID) {
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	c := &conn{user: user, out: make(chan []byte, sendBuffer), drop: func() {
		_ = ws.Close(websocket.StatusPolicyViolation, "too slow")
		cancel()
	}}
	s.hub.add(c)
	defer func() {
		s.hub.mu.Lock()
		s.hub.remove(c)
		s.hub.mu.Unlock()
		_ = ws.CloseNow()
	}()

	go s.write(ctx, ws, c, cancel)

	for {
		_, msg, err := ws.Read(ctx)
		if err != nil {
			return
		}
		s.onMessage(c, msg)
	}
}

// write sends queued messages and a ping every 30 seconds, which also notices a phone that
// went out of range without closing.
func (s *Service) write(ctx context.Context, ws *websocket.Conn, c *conn, cancel context.CancelFunc) {
	defer cancel()
	tick := time.NewTicker(30 * time.Second)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case body := <-c.out:
			wctx, done := context.WithTimeout(ctx, 10*time.Second)
			err := ws.Write(wctx, websocket.MessageText, body)
			done()
			if err != nil {
				return
			}
		case <-tick.C:
			pctx, done := context.WithTimeout(ctx, 10*time.Second)
			err := ws.Ping(pctx)
			done()
			if err != nil {
				return
			}
		}
	}
}

// clientMessage is a contract RealtimeClientMessage.
type clientMessage struct {
	Type        string    `json:"type"`
	LastEventID uuid.UUID `json:"last_event_id"`
}

// onMessage handles what the app sends. support.typing arrives with the support chat
// (M28+); until then it is ignored like any message this version does not know.
func (s *Service) onMessage(c *conn, raw []byte) {
	var m clientMessage
	if err := json.Unmarshal(raw, &m); err != nil {
		return
	}
	switch m.Type {
	case "ping":
		s.queue(c, []byte(`{"type":"pong"}`))
	case "resume":
		for _, body := range s.hub.Missed(c.user, m.LastEventID) {
			s.queue(c, body)
		}
	}
}

func (s *Service) queue(c *conn, body []byte) {
	s.hub.mu.Lock()
	defer s.hub.mu.Unlock()
	s.hub.send(c, body)
}
