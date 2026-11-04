package httpserver

import (
	"context"
	"io"
	"log/slog"
	"net"
	"net/http"
	"testing"
	"time"
)

func TestServeFinishesInFlightRequestsOnShutdown(t *testing.T) {
	t.Parallel()

	started := make(chan struct{})
	slow := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		close(started)
		time.Sleep(200 * time.Millisecond)
		w.WriteHeader(http.StatusOK)
	})

	ln, err := (&net.ListenConfig{}).Listen(t.Context(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	srv := NewServer(ln.Addr().String(), slow, slog.New(slog.NewTextHandler(io.Discard, nil)), 5*time.Second)
	done := make(chan error, 1)
	go func() { done <- srv.Serve(ctx, ln) }()

	status := make(chan int, 1)
	go func() {
		req, _ := http.NewRequestWithContext(t.Context(), http.MethodGet, "http://"+ln.Addr().String(), nil)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			status <- 0
			return
		}
		_ = resp.Body.Close()
		status <- resp.StatusCode
	}()

	<-started
	cancel() // like SIGTERM while a request is running

	if got := <-status; got != http.StatusOK {
		t.Fatalf("in-flight request got %d, want 200", got)
	}
	if err := <-done; err != nil {
		t.Fatalf("Serve returned %v, want nil after a clean shutdown", err)
	}
}
