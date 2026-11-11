package assistant

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"
)

// Groq is Groq's free tier through its OpenAI-compatible chat API: the fallback when Gemini
// is out of quota or down.
type Groq struct {
	APIKey string
	// Model defaults to llama-3.3-70b-versatile.
	Model string
	// BaseURL defaults to Groq's endpoint; tests point it at a local server.
	BaseURL string
	Client  httpDoer
}

// Name implements Provider.
func (g *Groq) Name() string { return "groq" }

type oaMessage struct {
	Role       string       `json:"role"`
	Content    string       `json:"content,omitempty"`
	ToolCalls  []oaToolCall `json:"tool_calls,omitempty"`
	ToolCallID string       `json:"tool_call_id,omitempty"`
}

type oaToolCall struct {
	Index    int    `json:"index"`
	ID       string `json:"id,omitempty"`
	Type     string `json:"type,omitempty"`
	Function struct {
		Name      string `json:"name,omitempty"`
		Arguments string `json:"arguments,omitempty"`
	} `json:"function"`
}

// Generate implements Provider.
func (g *Groq) Generate(ctx context.Context, req Request, onDelta func(string)) (Reply, error) {
	model, base, client := g.Model, g.BaseURL, g.Client
	if model == "" {
		model = "llama-3.3-70b-versatile"
	}
	if base == "" {
		base = "https://api.groq.com"
	}
	if client == nil {
		client = http.DefaultClient
	}
	msgs := []oaMessage{{Role: "system", Content: req.System}}
	for _, m := range req.Messages {
		switch m.Role {
		case RoleUser:
			msgs = append(msgs, oaMessage{Role: "user", Content: m.Text})
		case RoleAssistant:
			om := oaMessage{Role: "assistant", Content: m.Text}
			for _, c := range m.Calls {
				tc := oaToolCall{ID: c.ID, Type: "function"}
				tc.Function.Name, tc.Function.Arguments = c.Name, string(c.Args)
				om.ToolCalls = append(om.ToolCalls, tc)
			}
			msgs = append(msgs, om)
		case RoleTool:
			msgs = append(msgs, oaMessage{Role: "tool", Content: m.Text, ToolCallID: m.CallID})
		}
	}
	body := map[string]any{"model": model, "messages": msgs, "stream": true, "max_tokens": req.MaxTokens, "temperature": 0.3}
	if len(req.Tools) > 0 {
		tools := make([]map[string]any, len(req.Tools))
		for i, t := range req.Tools {
			tools[i] = map[string]any{"type": "function", "function": map[string]any{"name": t.Name, "description": t.Description, "parameters": t.Parameters}}
		}
		body["tools"] = tools
	}
	resp, cancel, err := post(ctx, client, base+"/openai/v1/chat/completions", map[string]string{"Authorization": "Bearer " + g.APIKey}, body)
	if err != nil {
		return Reply{}, err
	}
	defer cancel()
	defer func() { _ = resp.Body.Close() }()

	var text strings.Builder
	// Tool calls arrive in pieces keyed by index: the name once, the arguments as fragments.
	partial := map[int]*ToolCall{}
	err = sseData(resp.Body, func(payload []byte) error {
		var chunk struct {
			Choices []struct {
				Delta struct {
					Content   string       `json:"content"`
					ToolCalls []oaToolCall `json:"tool_calls"`
				} `json:"delta"`
			} `json:"choices"`
		}
		if err := json.Unmarshal(payload, &chunk); err != nil {
			return fmt.Errorf("decode chunk: %w", err)
		}
		for _, c := range chunk.Choices {
			if c.Delta.Content != "" {
				text.WriteString(c.Delta.Content)
				if onDelta != nil {
					onDelta(c.Delta.Content)
				}
			}
			for _, tc := range c.Delta.ToolCalls {
				cur := partial[tc.Index]
				if cur == nil {
					cur = &ToolCall{}
					partial[tc.Index] = cur
				}
				if tc.ID != "" {
					cur.ID = tc.ID
				}
				if tc.Function.Name != "" {
					cur.Name = tc.Function.Name
				}
				cur.Args = append(cur.Args, tc.Function.Arguments...)
			}
		}
		return nil
	})
	if err != nil {
		return Reply{}, err
	}
	idx := make([]int, 0, len(partial))
	for i := range partial {
		idx = append(idx, i)
	}
	sort.Ints(idx)
	var calls []ToolCall
	for _, i := range idx {
		c := *partial[i]
		if c.ID == "" {
			c.ID = fmt.Sprintf("call_%d", i+1)
		}
		if len(c.Args) == 0 {
			c.Args = json.RawMessage("{}")
		}
		calls = append(calls, c)
	}
	return Reply{Text: text.String(), Calls: calls}, nil
}
