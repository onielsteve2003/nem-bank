package assistant

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
)

// Gemini is Google's Gemini API on the free tier, over plain REST (no SDK: one request shape).
type Gemini struct {
	APIKey string
	// Model defaults to gemini-2.0-flash.
	Model string
	// BaseURL defaults to Google's endpoint; tests point it at a local server.
	BaseURL string
	Client  httpDoer
}

// Name implements Provider.
func (g *Gemini) Name() string { return "gemini" }

type gPart struct {
	Text             string         `json:"text,omitempty"`
	FunctionCall     *gFunctionCall `json:"functionCall,omitempty"`
	FunctionResponse *gFunctionResp `json:"functionResponse,omitempty"`
}

type gFunctionCall struct {
	Name string          `json:"name"`
	Args json.RawMessage `json:"args"`
}

type gFunctionResp struct {
	Name     string         `json:"name"`
	Response map[string]any `json:"response"`
}

type gContent struct {
	Role  string  `json:"role,omitempty"`
	Parts []gPart `json:"parts"`
}

// Generate implements Provider.
func (g *Gemini) Generate(ctx context.Context, req Request, onDelta func(string)) (Reply, error) {
	model, base, client := g.Model, g.BaseURL, g.Client
	if model == "" {
		model = "gemini-2.0-flash"
	}
	if base == "" {
		base = "https://generativelanguage.googleapis.com"
	}
	if client == nil {
		client = http.DefaultClient
	}
	body := map[string]any{
		"systemInstruction": gContent{Parts: []gPart{{Text: req.System}}},
		"contents":          geminiContents(req.Messages),
		"generationConfig":  map[string]any{"maxOutputTokens": req.MaxTokens, "temperature": 0.3},
	}
	if len(req.Tools) > 0 {
		decls := make([]map[string]any, len(req.Tools))
		for i, t := range req.Tools {
			decls[i] = map[string]any{"name": t.Name, "description": t.Description, "parameters": t.Parameters}
		}
		body["tools"] = []map[string]any{{"functionDeclarations": decls}}
	}
	// The key goes in a header, not the URL, so it never lands in an access log.
	resp, cancel, err := post(ctx, client, base+"/v1beta/models/"+model+":streamGenerateContent?alt=sse",
		map[string]string{"x-goog-api-key": g.APIKey}, body)
	if err != nil {
		return Reply{}, err
	}
	defer cancel()
	defer func() { _ = resp.Body.Close() }()

	var text strings.Builder
	var calls []ToolCall
	err = sseData(resp.Body, func(payload []byte) error {
		var chunk struct {
			Candidates []struct {
				Content gContent `json:"content"`
			} `json:"candidates"`
		}
		if err := json.Unmarshal(payload, &chunk); err != nil {
			return fmt.Errorf("decode chunk: %w", err)
		}
		for _, c := range chunk.Candidates {
			for _, p := range c.Content.Parts {
				if p.Text != "" {
					text.WriteString(p.Text)
					if onDelta != nil {
						onDelta(p.Text)
					}
				}
				if p.FunctionCall != nil {
					calls = append(calls, ToolCall{ID: fmt.Sprintf("call_%d", len(calls)+1), Name: p.FunctionCall.Name, Args: p.FunctionCall.Args})
				}
			}
		}
		return nil
	})
	if err != nil {
		return Reply{}, err
	}
	return Reply{Text: text.String(), Calls: calls}, nil
}

// geminiContents maps the neutral conversation to Gemini's: the assistant is "model", and a
// tool result is a user turn holding a functionResponse.
func geminiContents(msgs []Message) []gContent {
	var out []gContent
	add := func(role string, p gPart) {
		// Gemini wants one turn per role change; consecutive tool results share a turn.
		if n := len(out); n > 0 && out[n-1].Role == role && p.FunctionResponse != nil {
			out[n-1].Parts = append(out[n-1].Parts, p)
			return
		}
		out = append(out, gContent{Role: role, Parts: []gPart{p}})
	}
	for _, m := range msgs {
		switch m.Role {
		case RoleUser:
			add("user", gPart{Text: m.Text})
		case RoleAssistant:
			c := gContent{Role: "model"}
			if m.Text != "" {
				c.Parts = append(c.Parts, gPart{Text: m.Text})
			}
			for _, call := range m.Calls {
				c.Parts = append(c.Parts, gPart{FunctionCall: &gFunctionCall{Name: call.Name, Args: call.Args}})
			}
			out = append(out, c)
		case RoleTool:
			var resp map[string]any
			if json.Unmarshal([]byte(m.Text), &resp) != nil || resp == nil {
				resp = map[string]any{"result": m.Text}
			}
			add("user", gPart{FunctionResponse: &gFunctionResp{Name: m.Name, Response: resp}})
		}
	}
	return out
}
