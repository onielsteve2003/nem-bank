// Package assistant is Nem Assistant (AI-6) and the LLM gateway behind it.
//
// The model never touches money or the database. It sees redacted text and calls typed
// server tools; the tools return aggregates, and the ones that would move money only
// prepare an action the customer must confirm with their PIN or biometrics. Whatever the
// model says is sanitised before the customer sees it.
package assistant

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Role is who said a message in a model conversation.
type Role string

// Roles.
const (
	RoleUser      Role = "user"
	RoleAssistant Role = "assistant"
	RoleTool      Role = "tool"
)

// ToolCall is the model asking for a tool.
type ToolCall struct {
	ID   string
	Name string
	Args json.RawMessage
}

// Image is a picture sent to a vision-capable model.
type Image struct {
	MIME string
	Data []byte
}

// Message is one turn sent to a model.
type Message struct {
	Role Role
	Text string
	// Images ride along with a user turn (the optional ID prefill).
	Images []Image
	// Calls are the tool calls an assistant turn made.
	Calls []ToolCall
	// CallID and Name tie a tool turn to the call it answers.
	CallID string
	Name   string
}

// ToolDef describes a tool to the model. Parameters is a JSON Schema subset
// (type, properties, required, enum, description) both providers accept.
type ToolDef struct {
	Name        string
	Description string
	Parameters  map[string]any
}

// Request is one model call.
type Request struct {
	System    string
	Messages  []Message
	Tools     []ToolDef
	MaxTokens int
	// JSON asks for a single JSON object as the answer (no tools in the same call).
	JSON bool
}

// Reply is what the model said: text, tool calls, or both.
type Reply struct {
	Text     string
	Calls    []ToolCall
	Provider string
}

// Provider is a large language model behind a plain interface (PRD §11): going from Gemini
// to another vendor is a new adapter, not a rewrite. onDelta, when not nil, receives text
// as it arrives.
type Provider interface {
	Name() string
	Generate(ctx context.Context, req Request, onDelta func(string)) (Reply, error)
}

// ErrUnavailable means no configured provider could answer.
var ErrUnavailable = errors.New("assistant: no language model available")

// Gateway tries providers in order. A provider that fails before it has said anything is
// skipped; one that fails after the customer has already seen text is not retried, because
// the second answer would be glued onto the first.
type Gateway struct {
	providers []Provider
}

// NewGateway builds a gateway over the providers, most preferred first. Nil providers
// (a missing API key) are dropped.
func NewGateway(providers ...Provider) *Gateway {
	g := &Gateway{}
	for _, p := range providers {
		if p != nil {
			g.providers = append(g.providers, p)
		}
	}
	return g
}

// Available reports whether any provider is configured.
func (g *Gateway) Available() bool { return g != nil && len(g.providers) > 0 }

// Generate asks the providers in turn.
func (g *Gateway) Generate(ctx context.Context, req Request, onDelta func(string)) (Reply, error) {
	if !g.Available() {
		return Reply{}, ErrUnavailable
	}
	var errs []error
	for _, p := range g.providers {
		spoke := false
		var forward func(string)
		if onDelta != nil {
			forward = func(s string) {
				if s != "" {
					spoke = true
				}
				onDelta(s)
			}
		}
		r, err := p.Generate(ctx, req, forward)
		if err == nil {
			r.Provider = p.Name()
			return r, nil
		}
		if ctx.Err() != nil {
			return Reply{}, ctx.Err()
		}
		errs = append(errs, fmt.Errorf("%s: %w", p.Name(), err))
		if spoke {
			break
		}
	}
	return Reply{}, fmt.Errorf("%w: %w", ErrUnavailable, errors.Join(errs...))
}

// httpDoer is the HTTP client; tests substitute a server's.
type httpDoer interface {
	Do(*http.Request) (*http.Response, error)
}

// callTimeout bounds one model call. A free tier that stalls must not hold a request open.
const callTimeout = 25 * time.Second

// post sends a JSON body and returns the response, turning a non-200 into an error that
// carries the status but never the request (which holds the customer's redacted text).
func post(ctx context.Context, c httpDoer, endpoint string, header map[string]string, body any) (*http.Response, context.CancelFunc, error) {
	raw, err := json.Marshal(body)
	if err != nil {
		return nil, nil, fmt.Errorf("encode request: %w", err)
	}
	ctx, cancel := context.WithTimeout(ctx, callTimeout)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(string(raw)))
	if err != nil {
		cancel()
		return nil, nil, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	for k, v := range header {
		req.Header.Set(k, v)
	}
	resp, err := c.Do(req) //nolint:gosec // the URL is a constant provider endpoint, not caller input
	if err != nil {
		cancel()
		// The URL error repeats the address; the cause alone is what matters (and is safe to log).
		var ue *url.Error
		if errors.As(err, &ue) {
			err = ue.Err
		}
		return nil, nil, fmt.Errorf("send: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4<<10))
		_ = resp.Body.Close()
		cancel()
		return nil, nil, fmt.Errorf("status %d", resp.StatusCode)
	}
	return resp, cancel, nil
}

// sseData yields the payload of each `data:` line of a server-sent-events stream.
func sseData(r io.Reader, fn func(payload []byte) error) error {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64<<10), 1<<20)
	for sc.Scan() {
		line := sc.Text()
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if payload == "" || payload == "[DONE]" {
			continue
		}
		if err := fn([]byte(payload)); err != nil {
			return err
		}
	}
	return sc.Err()
}
