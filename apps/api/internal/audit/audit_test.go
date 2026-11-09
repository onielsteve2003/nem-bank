package audit

import (
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/testdb"
)

func TestHashesMatchTheConsole(t *testing.T) {
	t.Parallel()
	// The console's canonical() + hashEntry() (apps/console/src/data/mock/audit.ts) run in
	// Node on this entry give the hash below. The metadata holds what JSON.stringify and
	// encoding/json write differently: <, >, &, U+2028, control characters, exponents.
	raw, err := json.Marshal(map[string]any{
		"b": "<x>&\u2028\"\\", "a": 1.5, "big": 1e21, "tiny": 1.5e-7, "ctl": "\u0001\n", "n": 1234567,
		"nested": map[string]any{"z": []any{1, "q", true}, "y": nil},
	})
	if err != nil {
		t.Fatal(err)
	}
	meta, err := canonicalJSON(raw)
	if err != nil {
		t.Fatal(err)
	}
	if want := `{"a":1.5,"b":"<x>&` + "\u2028" + `\"\\","big":1e+21,"ctl":"\u0001\n","n":1234567,` +
		`"nested":{"y":null,"z":[1,"q",true]},"tiny":1.5e-7}`; string(meta) != want {
		t.Fatalf("canonical metadata =\n%s\nwant\n%s", meta, want)
	}
	actor := "0192f5a4-7c1e-7b3a-9f10-3c5d2e8a4b62"
	at, _ := time.Parse(time.RFC3339Nano, "2026-11-09T14:11:00.123Z")
	h, err := HashEntry(Entry{
		Seq: 1, ID: uuid.MustParse("0192f5a4-7c1e-7b3a-9f10-3c5d2e8a4b61"), At: at,
		Actor: Actor{Type: ActorCustomer, ID: &actor}, Action: "device.revoke",
		ResourceType: "device", ResourceID: "d-1", Metadata: meta, PrevHash: GenesisHash,
	})
	if err != nil {
		t.Fatal(err)
	}
	if want := "d0f2abb4446aabc7db5cfeee859e4a5be7b628d76a9ad4c3b75a5e04231781ad"; h != want {
		t.Fatalf("hash = %s, want %s", h, want)
	}
}

func TestJSNumberFormatting(t *testing.T) {
	t.Parallel()
	for in, want := range map[string]string{
		"0": "0", "-0": "0", "-0.0": "0", "42": "42", "-7": "-7", "1.50": "1.5", "1234567.25": "1234567.25",
		"1e21": "1e+21", "1.5e-07": "1.5e-7", "0.000001": "0.000001", "123e18": "123000000000000000000",
		"9007199254740993": "9007199254740992", // past 2^53, JavaScript rounds too
	} {
		if got, err := jsNumber(json.Number(in)); err != nil || got != want {
			t.Errorf("jsNumber(%s) = %q, %v; want %q", in, got, err, want)
		}
	}
}

func appendOne(t *testing.T, pool *pgxpool.Pool, action string, meta map[string]any) Entry {
	t.Helper()
	var e Entry
	err := pgx.BeginFunc(t.Context(), pool, func(tx pgx.Tx) error {
		var err error
		e, err = Append(t.Context(), tx, Input{
			Actor: System(), Action: action, ResourceType: "user", ResourceID: "u-1", Metadata: meta,
		}, time.Now())
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	return e
}

func TestTheChainVerifiesAndAnyEditBreaksIt(t *testing.T) {
	t.Parallel()
	pool := testdb.New(t)
	ctx := t.Context()

	empty, err := Verify(ctx, pool, 0, 0)
	if err != nil || !empty.Valid || empty.HeadSeq != 0 || empty.HeadHash != GenesisHash {
		t.Fatalf("empty chain = %+v, %v", empty, err)
	}
	first := appendOne(t, pool, "device.bind", map[string]any{"device_id": "d-1", "platform": "ios"})
	second := appendOne(t, pool, "pin.reset", map[string]any{"amount_minor": "150000", "n": 3})
	third := appendOne(t, pool, "device.revoke", nil)
	if first.Seq != 1 || first.PrevHash != GenesisHash || second.PrevHash != first.Hash || third.Seq != 3 {
		t.Fatalf("chain links: %+v / %+v / %+v", first, second, third)
	}

	v, err := Verify(ctx, pool, 0, 0)
	if err != nil || !v.Valid || v.Checked != 3 || v.HeadSeq != 3 || v.HeadHash != third.Hash {
		t.Fatalf("verify = %+v, %v", v, err)
	}
	// jsonb hands metadata back reformatted; the hash still matches.
	part, err := Verify(ctx, pool, 2, 3)
	if err != nil || !part.Valid || part.Checked != 2 {
		t.Fatalf("verify 2..3 = %+v, %v", part, err)
	}

	// The table refuses edits from the app's role.
	for _, sql := range []string{
		`UPDATE audit_log SET action = 'pin.set' WHERE seq = 2`,
		`DELETE FROM audit_log WHERE seq = 3`,
		`TRUNCATE audit_log`,
	} {
		if _, err := pool.Exec(ctx, sql); err == nil || !strings.Contains(err.Error(), "append-only") {
			t.Fatalf("%s: err = %v", sql, err)
		}
	}

	// An insider who turns the trigger off and edits a row is caught by the chain.
	if _, err := pool.Exec(ctx, `ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_change;
		UPDATE audit_log SET metadata = '{"amount_minor":"9500000","n":3}' WHERE seq = 2`); err != nil {
		t.Fatal(err)
	}
	v, err = Verify(ctx, pool, 0, 0)
	if err != nil || v.Valid || v.FirstBrokenSeq == nil || *v.FirstBrokenSeq != 2 || v.Checked != 1 {
		t.Fatalf("after tampering = %+v, %v", v, err)
	}
	// Deleting the last row is caught when verifying up to a known head.
	if _, err := pool.Exec(ctx, `DELETE FROM audit_log WHERE seq = 3`); err != nil {
		t.Fatal(err)
	}
	if v, _ := Verify(ctx, pool, 3, 3); !v.Valid || v.HeadSeq != 2 {
		// Head moved back to 2: a range past the head is clamped, so record heads
		// externally (T32) to catch truncation. Seq 3 alone cannot be checked any more.
		t.Fatalf("after deleting the head = %+v", v)
	}
}

func TestConcurrentAppendsFormOneChain(t *testing.T) {
	t.Parallel()
	pool := testdb.New(t)
	var wg sync.WaitGroup
	for i := range 20 {
		wg.Go(func() { appendOne(t, pool, "session.revoke", map[string]any{"i": i}) })
	}
	wg.Wait()
	v, err := Verify(t.Context(), pool, 0, 0)
	if err != nil || !v.Valid || v.Checked != 20 || v.HeadSeq != 20 {
		t.Fatalf("verify = %+v, %v", v, err)
	}
}
