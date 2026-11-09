// Package api is the HTTP surface generated from packages/contracts/openapi.yaml: models,
// the Gin strict server interface, the embedded spec used for request validation, and an
// Unimplemented base for operations whose domain is not built yet.
package api

import "errors"

//go:generate go tool oapi-codegen -config oapi-codegen.yaml ../../../../packages/contracts/openapi.yaml
//go:generate go run ./stubgen

// ErrNotImplemented is returned by Unimplemented; the server maps it to 501.
var ErrNotImplemented = errors.New("operation not implemented")
