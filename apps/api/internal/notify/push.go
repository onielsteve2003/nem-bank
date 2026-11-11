package notify

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// ExpoEndpoint is Expo's free push service. It needs no access token for a standard app.
const ExpoEndpoint = "https://exp.host/--/api/v2/push/send"

// Pusher sends one notification to a customer's devices. dead lists tokens Expo says no longer
// exist (the app was uninstalled), which the caller deletes.
type Pusher interface {
	Push(ctx context.Context, tokens []string, title, body, deepLink string) (dead []string, err error)
}

// Expo sends through the Expo push service.
type Expo struct {
	// Endpoint defaults to ExpoEndpoint; tests point it at a local server.
	Endpoint string
	Client   *http.Client
}

var pushClient = &http.Client{Timeout: 10 * time.Second}

type expoMessage struct {
	To    string         `json:"to"`
	Title string         `json:"title"`
	Body  string         `json:"body"`
	Sound string         `json:"sound"`
	Data  map[string]any `json:"data,omitempty"`
}

type expoReceipt struct {
	Status  string `json:"status"`
	Details struct {
		Error string `json:"error"`
	} `json:"details"`
}

// Push implements Pusher. Expo answers one receipt per message, in order.
func (e Expo) Push(ctx context.Context, tokens []string, title, body, deepLink string) ([]string, error) {
	if len(tokens) == 0 {
		return nil, nil
	}
	msgs := make([]expoMessage, len(tokens))
	for i, t := range tokens {
		msgs[i] = expoMessage{To: t, Title: title, Body: body, Sound: "default"}
		if deepLink != "" {
			msgs[i].Data = map[string]any{"url": deepLink}
		}
	}
	raw, err := json.Marshal(msgs)
	if err != nil {
		return nil, fmt.Errorf("encode push: %w", err)
	}
	endpoint := e.Endpoint
	if endpoint == "" {
		endpoint = ExpoEndpoint
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(raw))
	if err != nil {
		return nil, fmt.Errorf("build push request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	client := e.Client
	if client == nil {
		client = pushClient
	}
	resp, err := client.Do(req) //nolint:gosec // fixed Expo URL (or a test server), not caller-controlled
	if err != nil {
		return nil, fmt.Errorf("send push: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, fmt.Errorf("read push response: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("expo push: status %d", resp.StatusCode)
	}
	var out struct {
		Data []expoReceipt `json:"data"`
	}
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, fmt.Errorf("decode push response: %w", err)
	}
	var dead []string
	for i, r := range out.Data {
		if i < len(tokens) && r.Status == "error" && r.Details.Error == "DeviceNotRegistered" {
			dead = append(dead, tokens[i])
		}
	}
	return dead, nil
}
