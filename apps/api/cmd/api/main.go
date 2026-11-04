// Command api runs the Nem Bank HTTP API.
package main

import (
	"errors"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/httpserver"
)

// version is set at build time with -ldflags "-X main.version=...".
var version = "dev"

func main() {
	addr := ":" + envOr("PORT", "8080")
	srv := &http.Server{
		Addr:              addr,
		Handler:           httpserver.NewRouter(version),
		ReadHeaderTimeout: 5 * time.Second,
	}

	log.Printf("nem api %s listening on %s", version, addr)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("serve: %v", err)
	}
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
