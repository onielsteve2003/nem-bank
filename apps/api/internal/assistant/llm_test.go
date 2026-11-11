package assistant

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func sse(w http.ResponseWriter, chunks ...string) {
	w.Header().Set("Content-Type", "text/event-stream")
	for _, c := range chunks {
		_, _ = io.WriteString(w, "data: "+c+"\n\n")
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
	}
}

func TestGeminiStreamsTextAndToolCalls(t *testing.T) {
	t.Parallel()
	var gotKey, gotPath, gotQuery string
	var body map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotKey, gotPath, gotQuery = r.Header.Get("x-goog-api-key"), r.URL.Path, r.URL.RawQuery
		_ = json.NewDecoder(r.Body).Decode(&body)
		sse(w,
			`{"candidates":[{"content":{"parts":[{"text":"Checking "}]}}]}`,
			`{"candidates":[{"content":{"parts":[{"text":"now."},{"functionCall":{"name":"get_balances","args":{}}}]}}]}`)
	}))
	defer srv.Close()

	g := &Gemini{APIKey: "test-key", BaseURL: srv.URL, Client: srv.Client()}
	var deltas []string
	r, err := g.Generate(context.Background(), Request{
		System: "rules", MaxTokens: 100,
		Messages: []Message{
			{Role: RoleUser, Text: "balance?"},
			{Role: RoleAssistant, Calls: []ToolCall{{ID: "c1", Name: "get_balances", Args: json.RawMessage(`{}`)}}},
			{Role: RoleTool, CallID: "c1", Name: "get_balances", Text: `{"accounts":[]}`},
		},
		Tools: []ToolDef{{Name: "get_balances", Description: "d", Parameters: obj(map[string]any{})}},
	}, func(s string) { deltas = append(deltas, s) })
	if err != nil {
		t.Fatal(err)
	}
	if r.Text != "Checking now." || len(r.Calls) != 1 || r.Calls[0].Name != "get_balances" || strings.Join(deltas, "|") != "Checking |now." {
		t.Fatalf("reply = %+v deltas = %v", r, deltas)
	}
	if gotKey != "test-key" || strings.Contains(gotQuery, "test-key") {
		t.Fatalf("the key must travel in a header only: header %q query %q", gotKey, gotQuery)
	}
	if !strings.HasSuffix(gotPath, ":streamGenerateContent") {
		t.Fatalf("path = %s", gotPath)
	}
	contents, _ := body["contents"].([]any)
	if len(contents) != 3 {
		t.Fatalf("contents = %v", body["contents"])
	}
	raw, _ := json.Marshal(contents)
	for _, want := range []string{`"role":"model"`, `"functionCall"`, `"functionResponse"`} {
		if !strings.Contains(string(raw), want) {
			t.Errorf("request lacks %s: %s", want, raw)
		}
	}
}

func TestGroqStreamsAndAssemblesToolCallFragments(t *testing.T) {
	t.Parallel()
	var auth string
	var body map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth = r.Header.Get("Authorization")
		_ = json.NewDecoder(r.Body).Decode(&body)
		sse(w,
			`{"choices":[{"delta":{"content":"Let me "}}]}`,
			`{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c9","function":{"name":"spending_by_category","arguments":"{\"per"}}]}}]}`,
			`{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"iod\":\"this_month\"}"}}]}}]}`,
			`[DONE]`)
	}))
	defer srv.Close()

	g := &Groq{APIKey: "gk", BaseURL: srv.URL, Client: srv.Client()}
	r, err := g.Generate(context.Background(), Request{System: "rules", MaxTokens: 50, Messages: []Message{{Role: RoleUser, Text: "hi"}},
		Tools: []ToolDef{{Name: "spending_by_category", Parameters: obj(map[string]any{})}}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if r.Text != "Let me " || len(r.Calls) != 1 || r.Calls[0].ID != "c9" || string(r.Calls[0].Args) != `{"period":"this_month"}` {
		t.Fatalf("reply = %+v (args %s)", r, r.Calls)
	}
	if auth != "Bearer gk" || body["stream"] != true {
		t.Fatalf("auth %q stream %v", auth, body["stream"])
	}
}

func TestProviderErrorsCarryStatusNotRequest(t *testing.T) {
	t.Parallel()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "quota", http.StatusTooManyRequests)
	}))
	defer srv.Close()
	_, err := (&Gemini{APIKey: "k", BaseURL: srv.URL, Client: srv.Client()}).Generate(context.Background(),
		Request{System: "s", Messages: []Message{{Role: RoleUser, Text: "my secret question"}}}, nil)
	if err == nil || !strings.Contains(err.Error(), "429") || strings.Contains(err.Error(), "secret") {
		t.Fatalf("err = %v", err)
	}
}

type fakeProvider struct {
	name  string
	reply Reply
	err   error
	say   string // streamed before failing
	calls int
}

func (f *fakeProvider) Name() string { return f.name }
func (f *fakeProvider) Generate(_ context.Context, _ Request, onDelta func(string)) (Reply, error) {
	f.calls++
	if f.say != "" && onDelta != nil {
		onDelta(f.say)
	}
	return f.reply, f.err
}

func TestGatewayFallsBackOnlyBeforeTheCustomerSawText(t *testing.T) {
	t.Parallel()
	boom := errors.New("quota")
	ctx := context.Background()

	a, b := &fakeProvider{name: "gemini", err: boom}, &fakeProvider{name: "groq", reply: Reply{Text: "from groq"}}
	r, err := NewGateway(a, nil, b).Generate(ctx, Request{}, func(string) {})
	if err != nil || r.Text != "from groq" || r.Provider != "groq" || a.calls != 1 {
		t.Fatalf("reply %+v err %v", r, err)
	}

	// Gemini already streamed words: a second answer would be glued on, so no fallback.
	a, b = &fakeProvider{name: "gemini", err: boom, say: "Your balan"}, &fakeProvider{name: "groq", reply: Reply{Text: "x"}}
	if _, err := NewGateway(a, b).Generate(ctx, Request{}, func(string) {}); !errors.Is(err, ErrUnavailable) || b.calls != 0 {
		t.Fatalf("err %v, groq calls %d", err, b.calls)
	}

	if _, err := NewGateway().Generate(ctx, Request{}, nil); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("empty gateway: %v", err)
	}
	if NewGateway(nil).Available() {
		t.Fatal("a gateway with only nil providers is not available")
	}
}
