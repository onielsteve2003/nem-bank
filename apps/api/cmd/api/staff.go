package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"strings"
	"time"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/admin"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/config"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/database"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/fieldcrypt"
)

// createStaff is `api create-staff -name "Aisha Bello" -email aisha@nem.bank -roles compliance`.
// Staff accounts are made by an operator with database access, never through the API, so
// no console session can create another insider. The password is read from STAFF_PASSWORD
// (never a flag: flags show up in shell history and process lists). The new account
// enrols its authenticator app on first login.
func createStaff(args []string) error {
	fs := flag.NewFlagSet("create-staff", flag.ContinueOnError)
	name := fs.String("name", "", "full name")
	email := fs.String("email", "", "work email")
	roles := fs.String("roles", "", "comma-separated: support, compliance, finance, admin")
	if err := fs.Parse(args); err != nil {
		return err
	}
	password := os.Getenv("STAFF_PASSWORD")
	if *name == "" || *email == "" || *roles == "" || password == "" {
		return errors.New("usage: STAFF_PASSWORD=... api create-staff -name NAME -email EMAIL -roles ROLE[,ROLE]")
	}
	cfg, err := config.Load(os.Getenv)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	pool, err := database.Open(ctx, cfg.DatabaseURL, 2)
	if err != nil {
		return err
	}
	defer pool.Close()
	keyring, err := fieldcrypt.New(cfg.FieldKeys, cfg.FieldIndexKey)
	if err != nil {
		return err
	}
	svc, err := admin.NewService(admin.Config{
		Pool: pool, Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
		SigningKey: cfg.StaffJWTSigningKey, Keyring: keyring,
	})
	if err != nil {
		return err
	}
	var rs []admin.Role
	for _, r := range strings.Split(*roles, ",") {
		rs = append(rs, admin.Role(strings.TrimSpace(r)))
	}
	st, err := svc.CreateStaff(ctx, admin.StaffInput{Name: *name, Email: *email, Password: password, Roles: rs})
	if err != nil {
		return err
	}
	fmt.Printf("created staff %s (%s). They scan the authenticator QR on first login.\n", st.ID, st.Email)
	return nil
}
