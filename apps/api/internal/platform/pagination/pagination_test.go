package pagination

import (
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
)

func ptr[T any](v T) *T { return &v }

func TestCursorRoundTripsTimeAndID(t *testing.T) {
	t.Parallel()

	want := Cursor{Time: time.Date(2026, 11, 9, 10, 30, 0, 123456789, time.UTC), ID: uuid.Must(uuid.NewV7())}
	enc := Encode(want)
	if strings.ContainsAny(enc, "+/=") {
		t.Fatalf("cursor %q is not URL safe", enc)
	}
	got, err := Decode(&enc)
	if err != nil || !got.Time.Equal(want.Time) || got.ID != want.ID {
		t.Fatalf("Decode(Encode(c)) = %+v, %v; want %+v", got, err, want)
	}
}

func TestAMissingCursorIsTheFirstPage(t *testing.T) {
	t.Parallel()

	for _, in := range []*string{nil, ptr("")} {
		c, err := Decode(in)
		if err != nil || !c.IsZero() {
			t.Fatalf("Decode(%v) = %+v, %v", in, c, err)
		}
	}
}

func TestDecodeRejectsCursorsTheServerDidNotIssue(t *testing.T) {
	t.Parallel()

	valid := Encode(Cursor{Time: time.Unix(1, 0), ID: uuid.New()})
	for name, in := range map[string]string{
		"not base64":    "!!!",
		"too short":     valid[:10],
		"offset number": "20",
		"wrong version": "Ag" + valid[2:],
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			_, err := Decode(&in)
			var p *problem.Error
			if !errors.Is(err, ErrInvalidCursor) || !errors.As(err, &p) ||
				p.Status != http.StatusBadRequest || p.Fields[0].Field != "query.cursor" {
				t.Fatalf("Decode(%q) err = %v", in, err)
			}
		})
	}
}

func TestLimitDefaultsAndClamps(t *testing.T) {
	t.Parallel()

	cases := []struct {
		in   *int
		want int
	}{{nil, DefaultLimit}, {ptr(5), 5}, {ptr(0), 1}, {ptr(-3), 1}, {ptr(1000), MaxLimit}}
	for _, tc := range cases {
		if got := Limit(tc.in); got != tc.want {
			t.Fatalf("Limit(%v) = %d, want %d", tc.in, got, tc.want)
		}
	}
}

type row struct {
	at time.Time
	id uuid.UUID
}

func key(r row) Cursor { return Cursor{Time: r.at, ID: r.id} }

func rows(n int) []row {
	out := make([]row, n)
	for i := range out {
		out[i] = row{at: time.Unix(int64(1000-i), 0).UTC(), id: uuid.Must(uuid.NewV7())}
	}
	return out
}

func TestPageWithAnExtraRowPointsAtTheLastKeptRow(t *testing.T) {
	t.Parallel()

	items, page := Page(rows(4), 3, key) // limit 3, fetched limit+1
	if len(items) != 3 || page.NextCursor == nil {
		t.Fatalf("items %d next %v", len(items), page.NextCursor)
	}
	next, err := Decode(page.NextCursor)
	if err != nil || next != key(items[2]) {
		t.Fatalf("next cursor = %+v, want the last kept row %+v", next, key(items[2]))
	}
}

func TestPageWithoutAnExtraRowIsTheLastPage(t *testing.T) {
	t.Parallel()

	for _, n := range []int{0, 2, 3} {
		items, page := Page(rows(n), 3, key)
		if len(items) != n || page.NextCursor != nil {
			t.Fatalf("n=%d: items %d next %v", n, len(items), page.NextCursor)
		}
	}
}
