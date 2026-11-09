// Package pagination implements the contract's opaque cursor pages: `cursor` and `limit`
// in, `{ "data": [...], "page": { "next_cursor": ... } }` out.
//
// Cursors are keyset positions, not offsets: a page is "rows after (time, id)" in the
// list's order, so inserts never shift or repeat rows across pages, and the query stays an
// index range scan however deep the client pages. Fetch Limit+1 rows and let Page decide
// whether there is a next page:
//
//	after, err := pagination.Decode(params.Cursor)        // zero Cursor = first page
//	limit := pagination.Limit(params.Limit)
//	rows, err := q.ListX(ctx, ..., after.Time, after.ID, limit+1)
//	items, page := pagination.Page(rows, limit, func(r Row) pagination.Cursor { ... })
package pagination

import (
	"encoding/base64"
	"encoding/binary"
	"time"

	"github.com/google/uuid"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
)

// Page sizes, matching components.parameters.Limit in the contract.
const (
	DefaultLimit = 20
	MaxLimit     = 100
)

// version leads every encoded cursor so the format can change without misreading old ones.
const version byte = 1

// encodedLen is version (1) + unix nanoseconds (8) + UUID (16).
const encodedLen = 1 + 8 + 16

// Cursor is the sort key of the last row on a page. The zero value means "from the start".
type Cursor struct {
	Time time.Time
	ID   uuid.UUID
}

// IsZero reports whether c is the start of the list.
func (c Cursor) IsZero() bool { return c.Time.IsZero() && c.ID == uuid.Nil }

// Encode returns the opaque, URL-safe form of c.
func Encode(c Cursor) string {
	var b [encodedLen]byte
	b[0] = version
	// Nanoseconds since 1970 fit an int64 until the year 2262; the cast keeps the bits.
	binary.BigEndian.PutUint64(b[1:9], uint64(c.Time.UnixNano())) //nolint:gosec // round-trips through int64 in Decode
	copy(b[9:], c.ID[:])
	return base64.RawURLEncoding.EncodeToString(b[:])
}

// ErrInvalidCursor is the problem for a cursor the server did not issue.
var ErrInvalidCursor = problem.Validation(problem.Field("query.cursor", "invalid",
	"The page cursor is not valid. Start again from the first page."))

// Decode parses a cursor from the query string. nil or empty means the first page. A
// cursor this server did not issue returns ErrInvalidCursor (400). Cursors carry no
// authority: every list query is scoped to the caller, so a forged cursor can only seek
// within the caller's own rows.
func Decode(s *string) (Cursor, error) {
	if s == nil || *s == "" {
		return Cursor{}, nil
	}
	b, err := base64.RawURLEncoding.DecodeString(*s)
	if err != nil || len(b) != encodedLen || b[0] != version {
		return Cursor{}, ErrInvalidCursor
	}
	id, err := uuid.FromBytes(b[9:])
	if err != nil {
		return Cursor{}, ErrInvalidCursor
	}
	nanos := int64(binary.BigEndian.Uint64(b[1:9])) //nolint:gosec // inverse of the cast in Encode
	return Cursor{Time: time.Unix(0, nanos).UTC(), ID: id}, nil
}

// Limit returns the page size: the default when absent, clamped to 1..MaxLimit. The
// request validator already rejects out-of-range values; clamping keeps callers that skip
// it (jobs, tests) safe.
func Limit(l *int) int {
	if l == nil {
		return DefaultLimit
	}
	return min(max(*l, 1), MaxLimit)
}

// Page trims rows fetched with limit+1 to limit and returns the page info. next_cursor
// is set only when the extra row proved there is more.
func Page[T any](rows []T, limit int, key func(T) Cursor) ([]T, api.PageInfo) {
	if len(rows) <= limit {
		return rows, api.PageInfo{NextCursor: nil}
	}
	rows = rows[:limit]
	next := Encode(key(rows[len(rows)-1]))
	return rows, api.PageInfo{NextCursor: &next}
}
