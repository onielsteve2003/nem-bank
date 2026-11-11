// Package realtime pushes events to signed-in apps over a WebSocket (TRF-7, NOT-1). The
// outbox dispatcher feeds it (a subscriber turns domain events into RealtimeEvent messages
// and Publishes them to the people they concern), and the hub fans each one out to that
// person's open connections.
//
// State is in memory: Render's free tier runs one instance, and a restart only drops the
// connections, which the app reopens. The hub keeps each person's last 24 hours of events
// so a reconnecting app can ask for what it missed (RealtimeClientMessage "resume"); an
// event missed across a restart is still in the app's next REST refresh.
package realtime

import (
	"encoding/json"
	"sync"
	"time"

	"github.com/google/uuid"
)

// Event is a contract RealtimeEvent. ID is the outbox event ID (or one derived from it), so
// a client can drop a duplicate delivery.
type Event struct {
	ID         uuid.UUID `json:"id"`
	Type       string    `json:"type"`
	OccurredAt time.Time `json:"occurred_at"`
	Data       any       `json:"data"`
}

const (
	// Retention is how long a person's events stay available to "resume".
	Retention = 24 * time.Hour
	// maxHistory bounds one person's replay buffer.
	maxHistory = 200
	// sendBuffer is how many messages may queue for one connection before it is dropped as
	// too slow to keep up.
	sendBuffer = 64
)

type stored struct {
	id   uuid.UUID
	at   time.Time
	body []byte
}

// conn is one open WebSocket as the hub sees it.
type conn struct {
	user uuid.UUID
	out  chan []byte
	// drop closes the socket; the hub calls it for a connection that cannot keep up.
	drop func()
}

// Hub fans events out to people's connections.
type Hub struct {
	now func() time.Time

	mu      sync.Mutex
	conns   map[uuid.UUID]map[*conn]struct{}
	history map[uuid.UUID][]stored
}

// NewHub returns an empty hub. now defaults to time.Now.
func NewHub(now func() time.Time) *Hub {
	if now == nil {
		now = time.Now
	}
	return &Hub{now: now, conns: map[uuid.UUID]map[*conn]struct{}{}, history: map[uuid.UUID][]stored{}}
}

// Publish sends ev to every open connection of user and keeps it for resume. The outbox
// delivers at least once, so an ID the person already has is ignored.
func (h *Hub) Publish(user uuid.UUID, ev Event) error {
	body, err := json.Marshal(ev)
	if err != nil {
		return err
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	hist := h.prune(user)
	for _, s := range hist {
		if s.id == ev.ID {
			return nil
		}
	}
	h.history[user] = append(hist, stored{id: ev.ID, at: ev.OccurredAt, body: body})
	for c := range h.conns[user] {
		h.send(c, body)
	}
	return nil
}

// send queues body on c, or drops c when its queue is full. The app reconnects and
// resumes, which is cheaper than letting one slow phone hold memory for everyone.
func (h *Hub) send(c *conn, body []byte) {
	select {
	case c.out <- body:
	default:
		h.remove(c)
		go c.drop()
	}
}

// prune drops expired and surplus history for user and returns what is left.
func (h *Hub) prune(user uuid.UUID) []stored {
	hist := h.history[user]
	cut := h.now().Add(-Retention)
	i := 0
	for i < len(hist) && hist[i].at.Before(cut) {
		i++
	}
	if over := len(hist) - i - maxHistory; over > 0 {
		i += over
	}
	if i > 0 {
		hist = append([]stored(nil), hist[i:]...)
		h.history[user] = hist
	}
	return hist
}

func (h *Hub) add(c *conn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.conns[c.user] == nil {
		h.conns[c.user] = map[*conn]struct{}{}
	}
	h.conns[c.user][c] = struct{}{}
}

func (h *Hub) remove(c *conn) {
	if set := h.conns[c.user]; set != nil {
		delete(set, c)
		if len(set) == 0 {
			delete(h.conns, c.user)
		}
	}
}

// Missed returns, oldest first, the events user has after lastID. An ID the hub no longer
// holds (older than the retention, or from before a restart) replays everything it has:
// the client drops what it already saw.
func (h *Hub) Missed(user, lastID uuid.UUID) [][]byte {
	h.mu.Lock()
	defer h.mu.Unlock()
	hist := h.prune(user)
	from := 0
	for i, s := range hist {
		if s.id == lastID {
			from = i + 1
			break
		}
	}
	out := make([][]byte, 0, len(hist)-from)
	for _, s := range hist[from:] {
		out = append(out, s.body)
	}
	return out
}

// Connections is how many sockets user has open (tests, metrics).
func (h *Hub) Connections(user uuid.UUID) int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.conns[user])
}
