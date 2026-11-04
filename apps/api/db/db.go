// Package db embeds the SQL migrations so the binary carries its own schema.
package db

import "embed"

// Migrations holds the goose migrations in migrations/.
//
//go:embed migrations/*.sql
var Migrations embed.FS
