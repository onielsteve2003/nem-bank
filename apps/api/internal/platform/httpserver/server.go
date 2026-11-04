package httpserver

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"time"
)

// Server wraps http.Server with graceful shutdown tied to a context.
type Server struct {
	http            *http.Server
	log             *slog.Logger
	shutdownTimeout time.Duration
}

// NewServer returns a server for handler on addr. shutdownTimeout bounds how long
// in-flight requests get to finish once shutdown starts.
func NewServer(addr string, handler http.Handler, log *slog.Logger, shutdownTimeout time.Duration) *Server {
	return &Server{
		http: &http.Server{
			Addr:              addr,
			Handler:           handler,
			ReadHeaderTimeout: 5 * time.Second,
			ReadTimeout:       15 * time.Second,
			WriteTimeout:      30 * time.Second,
			IdleTimeout:       60 * time.Second,
			ErrorLog:          slog.NewLogLogger(log.Handler(), slog.LevelWarn),
		},
		log:             log,
		shutdownTimeout: shutdownTimeout,
	}
}

// Run listens on the server's address and serves until ctx is cancelled.
func (s *Server) Run(ctx context.Context) error {
	ln, err := (&net.ListenConfig{}).Listen(ctx, "tcp", s.http.Addr)
	if err != nil {
		return fmt.Errorf("listen on %s: %w", s.http.Addr, err)
	}
	return s.Serve(ctx, ln)
}

// Serve accepts connections on ln until ctx is cancelled, then stops taking new
// connections and waits up to the shutdown timeout for in-flight requests.
func (s *Server) Serve(ctx context.Context, ln net.Listener) error {
	errc := make(chan error, 1)
	go func() {
		s.log.Info("http server listening", "addr", ln.Addr().String())
		errc <- s.http.Serve(ln)
	}()

	select {
	case err := <-errc:
		return fmt.Errorf("serve: %w", err)
	case <-ctx.Done():
	}

	s.log.Info("shutting down", "timeout", s.shutdownTimeout.String())
	shutdownCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), s.shutdownTimeout)
	defer cancel()
	if err := s.http.Shutdown(shutdownCtx); err != nil {
		return fmt.Errorf("shutdown: %w", err)
	}
	if err := <-errc; !errors.Is(err, http.ErrServerClosed) {
		return fmt.Errorf("serve: %w", err)
	}
	s.log.Info("shutdown complete")
	return nil
}
