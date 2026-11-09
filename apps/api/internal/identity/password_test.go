package identity

import (
	"strings"
	"testing"
)

// The vectors from packages/shared/src/password.test.ts: the app's meter and the API must
// agree on what is acceptable.
var ada = PasswordContext{FirstName: "Ada", LastName: "Obiora", Email: "ada.obi@example.com", DateOfBirth: "1994-03-05"}

func TestCheckPasswordMatchesTheSharedRules(t *testing.T) {
	t.Parallel()

	tests := []struct {
		password string
		pc       PasswordContext
		want     string // "" = acceptable; otherwise a substring of the problem
	}{
		{"Xk7!pq", PasswordContext{}, "Use at least 10 characters"},
		{"Password2026!", PasswordContext{}, "leaked password lists"},
		{"P@ssw0rd-Lagos", PasswordContext{}, "leaked password lists"},
		{"MyQwerty#Key", PasswordContext{}, "leaked password lists"},
		{"Naija4life!!x", PasswordContext{}, "leaked password lists"},
		{"Obiora#Vault88", ada, "Leave out your name"},
		{"ada.obi-secret!", ada, "Leave out your name"},
		{"Tuber7#1994zz", ada, "Leave out your name"},
		{"tmbvrwkqzl", PasswordContext{}, "Make it a little stronger"},
		{"Tmb9#abcdzq", PasswordContext{}, "Make it a little stronger"}, // a run drops it to 1
		{"Tmb9#vrwkq", PasswordContext{}, ""},
		{"kitchen-mango-river", PasswordContext{}, ""},
		{"Kitchen-Mango-River-7", ada, ""},
		{strings.Repeat("Ab3#", 33), PasswordContext{}, "Use at most 128 characters"},
	}
	for _, tt := range tests {
		got := CheckPassword(tt.password, tt.pc)
		if tt.want == "" && got != "" {
			t.Errorf("CheckPassword(%q) = %q, want acceptable", tt.password, got)
		}
		if tt.want != "" && !strings.Contains(got, tt.want) {
			t.Errorf("CheckPassword(%q) = %q, want it to contain %q", tt.password, got, tt.want)
		}
	}
}

func TestHasherVerifiesOnlyTheRightSecret(t *testing.T) {
	t.Parallel()

	h := NewHasher(Argon2Params{MemoryKiB: 64, Time: 1, Threads: 1}, 2)
	ctx := t.Context()
	hash, err := h.Hash(ctx, "Kitchen-Mango-River-7")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(hash, "$argon2id$v=19$m=64,t=1,p=1$") {
		t.Fatalf("hash %q is not a PHC argon2id string", hash)
	}
	if ok, err := h.Verify(ctx, "Kitchen-Mango-River-7", hash); err != nil || !ok {
		t.Fatalf("right secret: ok=%v err=%v", ok, err)
	}
	if ok, err := h.Verify(ctx, "kitchen-mango-river-7", hash); err != nil || ok {
		t.Fatalf("wrong secret: ok=%v err=%v", ok, err)
	}
	other, _ := h.Hash(ctx, "Kitchen-Mango-River-7")
	if other == hash {
		t.Fatal("two hashes of one secret match: the salt is not random")
	}
}

func TestHasherRefusesMalformedOrCostlyHashes(t *testing.T) {
	t.Parallel()

	h := NewHasher(DefaultArgon2, 1)
	for _, bad := range []string{
		"",
		"$2a$10$bcrypt",
		"$argon2i$v=19$m=64,t=1,p=1$c2FsdA$aGFzaA",
		"$argon2id$v=19$m=999999999,t=1,p=1$c2FsdHNhbHRzYWx0c2FsdA$" + strings.Repeat("A", 43),
	} {
		if _, err := h.Verify(t.Context(), "x", bad); err == nil {
			t.Errorf("Verify(%q) accepted a bad hash", bad)
		}
	}
}

func TestMaskEmailKeepsTheFirstLetterAndDomain(t *testing.T) {
	t.Parallel()

	if got := MaskEmail("tolu@gmail.com"); got != "t***@gmail.com" {
		t.Fatalf("MaskEmail = %q", got)
	}
	if got := MaskEmail("nope"); got != "***" {
		t.Fatalf("MaskEmail(no @) = %q", got)
	}
}
