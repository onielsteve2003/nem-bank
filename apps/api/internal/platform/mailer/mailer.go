// Package mailer sends transactional email: one-time codes now, statements and alerts
// later. Domains depend on the Mailer interface; main picks Brevo (free tier, 300 emails a
// day) when an API key is configured and the log mailer otherwise.
package mailer

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"time"
)

// Message is one plain-text email. Plain text keeps codes readable in every client and
// leaves nothing for a phishing kit to copy.
type Message struct {
	To      string
	Subject string
	Text    string
}

// Mailer delivers a message or reports why it could not.
type Mailer interface {
	Send(ctx context.Context, m Message) error
}

// Log writes each message to the log instead of sending it, so local sign-ups work with
// no account. Config refuses it in production, where the codes would sit in log storage.
type Log struct {
	Logger *slog.Logger
}

// Send logs the full message at info level.
func (l Log) Send(ctx context.Context, m Message) error {
	l.Logger.InfoContext(ctx, "email (log mailer, not sent)",
		slog.String("to", m.To), slog.String("subject", m.Subject), slog.String("text", m.Text))
	return nil
}

// BrevoEndpoint is Brevo's transactional email API.
const BrevoEndpoint = "https://api.brevo.com/v3/smtp/email"

// Brevo sends through Brevo's HTTP API. The sender address must be verified in Brevo.
type Brevo struct {
	APIKey    string
	FromEmail string
	FromName  string
	// Endpoint defaults to BrevoEndpoint; tests point it at a local server.
	Endpoint string
	// Client defaults to one with a 10-second timeout.
	Client *http.Client
}

var defaultClient = &http.Client{Timeout: 10 * time.Second}

type brevoAddress struct {
	Email string `json:"email"`
	Name  string `json:"name,omitempty"`
}

type brevoRequest struct {
	Sender      brevoAddress   `json:"sender"`
	To          []brevoAddress `json:"to"`
	Subject     string         `json:"subject"`
	TextContent string         `json:"textContent"`
}

// Send posts the message to Brevo. Any non-2xx answer is an error; the response body is
// read only for its length-bounded message, never logged with the recipient.
func (b Brevo) Send(ctx context.Context, m Message) error {
	if b.APIKey == "" || b.FromEmail == "" {
		return errors.New("brevo: api key and sender are required")
	}
	body, err := json.Marshal(brevoRequest{
		Sender:      brevoAddress{Email: b.FromEmail, Name: b.FromName},
		To:          []brevoAddress{{Email: m.To}},
		Subject:     m.Subject,
		TextContent: m.Text,
	})
	if err != nil {
		return fmt.Errorf("brevo: encode: %w", err)
	}
	endpoint := b.Endpoint
	if endpoint == "" {
		endpoint = BrevoEndpoint
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("brevo: %w", err)
	}
	req.Header.Set("api-key", b.APIKey)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	client := b.Client
	if client == nil {
		client = defaultClient
	}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("brevo: send: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode/100 != 2 {
		detail, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("brevo: status %d: %s", resp.StatusCode, bytes.TrimSpace(detail))
	}
	return nil
}
