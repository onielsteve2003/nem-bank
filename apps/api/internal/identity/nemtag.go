package identity

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity/identitydb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
)

// nemtagChangeDays is how often a @nemtag can change and how long the old one stays reserved.
const nemtagChangeDays = 30

var nemtagPattern = regexp.MustCompile(`^[a-z][a-z0-9_]{2,19}$`)

// reservedNemtags are handles nobody can own: they would look like the bank talking. The list is
// the same as @nem/shared's, which the app checks first.
var reservedNemtags = []string{"nem", "nembank", "admin", "support", "help", "security", "official", "staff"}

var (
	errNemtagTaken = problem.New(http.StatusConflict, "nemtag_taken", "That @nemtag is taken")
	// errNemtagCooldown is the mock bank's code; the detail carries the date.
	errNemtagCooldown = problem.New(http.StatusConflict, "nemtag_cooldown", "You changed your @nemtag recently")
)

// NemtagAvailability is whether a handle is free, with ideas when it is not.
type NemtagAvailability struct {
	Nemtag      string
	Available   bool
	Suggestions []string
}

// nemtagProblem is why a handle cannot be used at all (shape or reserved), or "".
func nemtagProblem(tag string) string {
	switch {
	case tag == "" || tag[0] < 'a' || tag[0] > 'z':
		return "Start with a letter"
	case !nemtagPattern.MatchString(tag):
		return "Use 3 to 20 letters, numbers or _"
	case slices.Contains(reservedNemtags, tag):
		return "This one is reserved. Try another."
	}
	return ""
}

// normalizeNemtag turns what people type ("@Tolu_A ") into what the bank stores ("tolu_a").
func normalizeNemtag(in string) string {
	return strings.TrimPrefix(strings.ToLower(strings.TrimSpace(in)), "@")
}

// nemtagTaken reports whether someone other than `me` owns or holds the handle right now.
func nemtagTaken(ctx context.Context, db interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}, tag string, me uuid.UUID, now time.Time) (bool, error) {
	var taken bool
	err := db.QueryRow(ctx, `
SELECT EXISTS (SELECT 1 FROM users WHERE nemtag = $1 AND id <> $2)
    OR EXISTS (SELECT 1 FROM nemtag_holds WHERE nemtag = $1 AND until > $3 AND user_id <> $2)`,
		tag, me, now).Scan(&taken)
	if err != nil {
		return false, fmt.Errorf("check nemtag: %w", err)
	}
	return taken, nil
}

// CheckNemtag says whether a handle is free for the caller, with up to three ideas when not.
// The caller's own current handle and the ones they hold count as free for them.
func (s *Service) CheckNemtag(ctx context.Context, raw string) (NemtagAvailability, error) {
	p, err := principal(ctx)
	if err != nil {
		return NemtagAvailability{}, err
	}
	tag := normalizeNemtag(raw)
	now := s.now()
	free := func(t string) (bool, error) {
		if nemtagProblem(t) != "" {
			return false, nil
		}
		taken, err := nemtagTaken(ctx, s.pool, t, p.UserID, now)
		return !taken, err
	}
	ok, err := free(tag)
	if err != nil {
		return NemtagAvailability{}, err
	}
	out := NemtagAvailability{Nemtag: tag, Available: ok, Suggestions: []string{}}
	if ok {
		return out, nil
	}
	base := strings.Map(func(r rune) rune {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '_' {
			return r
		}
		return -1
	}, tag)
	if len(base) > 16 {
		base = base[:16]
	}
	if base == "" {
		base = "nem"
	}
	for _, idea := range []string{base + "_ng", fmt.Sprintf("%s%02d", base, now.UTC().Year()%100), "the_" + base} {
		if good, err := free(idea); err != nil {
			return NemtagAvailability{}, err
		} else if good {
			out.Suggestions = append(out.Suggestions, idea)
		}
	}
	return out, nil
}

// SetNemtag claims or changes the caller's @nemtag. The first claim is free; after that a tag can
// change once every 30 days, and the old one stays reserved for the caller for 30 days.
func (s *Service) SetNemtag(ctx context.Context, raw string) (identitydb.User, error) {
	p, err := principal(ctx)
	if err != nil {
		return identitydb.User{}, err
	}
	tag := normalizeNemtag(raw)
	if msg := nemtagProblem(tag); msg != "" {
		return identitydb.User{}, problem.Validation(problem.Field("/nemtag", "invalid", msg))
	}
	now := s.now()
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		// The user row lock makes two changes by the same customer take turns.
		var current *string
		var changedAt *time.Time
		if err := tx.QueryRow(ctx, `SELECT nemtag, nemtag_changed_at FROM users WHERE id = $1 FOR UPDATE`, p.UserID).
			Scan(&current, &changedAt); err != nil {
			return fmt.Errorf("load user: %w", err)
		}
		if current != nil && *current == tag {
			return problem.Validation(problem.Field("/nemtag", "unchanged", "@"+tag+" is already your @nemtag"))
		}
		if current != nil && changedAt != nil {
			if until := changedAt.Add(nemtagChangeDays * 24 * time.Hour); until.After(now) {
				return errNemtagCooldown.WithDetail("You can change it again after " + until.UTC().Format("2006-01-02"))
			}
		}
		taken, err := nemtagTaken(ctx, tx, tag, p.UserID, now)
		if err != nil {
			return err
		}
		if taken {
			return errNemtagTaken
		}
		// A first claim leaves nemtag_changed_at empty: there is nothing to wait for yet.
		if current == nil {
			_, err = tx.Exec(ctx, `UPDATE users SET nemtag = $2, updated_at = $3 WHERE id = $1`, p.UserID, tag, now)
		} else {
			_, err = tx.Exec(ctx, `UPDATE users SET nemtag = $2, nemtag_changed_at = $3, updated_at = $3 WHERE id = $1`, p.UserID, tag, now)
		}
		if err != nil {
			return fmt.Errorf("set nemtag: %w", err)
		}
		// Taking back a held tag ends the hold; changing away from one starts a new hold.
		if _, err := tx.Exec(ctx, `DELETE FROM nemtag_holds WHERE nemtag = $1 AND user_id = $2`, tag, p.UserID); err != nil {
			return fmt.Errorf("release hold: %w", err)
		}
		if current != nil {
			if _, err := tx.Exec(ctx, `
INSERT INTO nemtag_holds (nemtag, user_id, until) VALUES ($1, $2, $3)
ON CONFLICT (nemtag) DO UPDATE SET user_id = EXCLUDED.user_id, until = EXCLUDED.until`,
				*current, p.UserID, now.Add(nemtagChangeDays*24*time.Hour)); err != nil {
				return fmt.Errorf("hold old nemtag: %w", err)
			}
		}
		return nil
	})
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return identitydb.User{}, errNemtagTaken // lost a race for the same handle
		}
		var pe *problem.Error
		if errors.As(err, &pe) {
			return identitydb.User{}, pe
		}
		return identitydb.User{}, fmt.Errorf("identity tx: %w", err)
	}
	return s.Me(ctx)
}
