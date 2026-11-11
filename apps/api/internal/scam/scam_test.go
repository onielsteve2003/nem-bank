package scam

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"os"
	"slices"
	"testing"

	"github.com/google/uuid"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity"
)

func mustNew(t testing.TB) *Checker {
	t.Helper()
	c, err := New()
	if err != nil {
		t.Fatal(err)
	}
	return c
}

// TestMatchesPython is the parity gate: probabilities and fired rules must equal what the
// Python exporter recorded for 60 messages, including a bank's "do not share" OTP notice, which
// the rules must not take for a request, and non-ASCII and empty text.
func TestMatchesPython(t *testing.T) {
	c := mustNew(t)
	raw, err := os.ReadFile("model/golden.json")
	if err != nil {
		t.Fatal(err)
	}
	var g struct {
		Tolerance float64 `json:"tolerance"`
		Cases     []struct {
			Text          string    `json:"text"`
			Probabilities []float64 `json:"probabilities"`
			Rules         []string  `json:"rules"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &g); err != nil {
		t.Fatal(err)
	}
	if len(g.Cases) < 60 {
		t.Fatalf("golden has %d cases, want 60", len(g.Cases))
	}
	for _, tc := range g.Cases {
		got := c.model.Probabilities(tc.Text)
		for k, want := range tc.Probabilities {
			if math.Abs(got[k]-want) > g.Tolerance*0.01 {
				t.Errorf("%q class %d: go %.6f, python %.6f", tc.Text, k, got[k], want)
			}
		}
		rules := c.MessageRules(tc.Text)
		if rules == nil {
			rules = []string{}
		}
		if !slices.Equal(rules, tc.Rules) {
			t.Errorf("%q rules: go %v, python %v", tc.Text, rules, tc.Rules)
		}
	}
}

func TestKnownScamsAreCaughtWithReasons(t *testing.T) {
	c := mustNew(t)
	for text, want := range map[string]string{
		"Dear customer, your account will be blocked within 24 hours. Update your BVN at http://gtb-verify.com/login": "bvn_update",
		"Hello pls I mistakenly sent N50,000 to your account, kindly send it back":                                    "wrong_transfer",
		"Congratulations! You have won N500,000 in the MTN promo. Pay a processing fee of N5,000 to claim.":           "advance_fee",
		"Hi mum this is my new number, my phone got spoilt. I need urgent help, send N150,000 now":                    "family_emergency",
		"Send me the OTP wey dem send you sharp sharp":                                                                "asks_for_secret",
	} {
		r := c.CheckMessage(text)
		if r.Verdict != LikelyScam {
			t.Errorf("%q: %s (score %.2f), want likely_scam", text, r.Verdict, r.Score)
		}
		if !hasReason(r, want) || r.Advice == "" || !r.ModelUsed || r.ModelVersion == "" {
			t.Errorf("%q: missing %s in %+v", text, want, r)
		}
	}
}

func TestLegitimateMessagesAreLeftAlone(t *testing.T) {
	c := mustNew(t)
	for _, text := range []string{
		"Your Nem Bank OTP is 482913. It expires in 10 minutes. Do not share it with anyone.",
		"Debit Alert: Acct 012***789 debited with NGN20,000 on 11-Nov-2026. Bal: NGN150,000.",
		"See you at church on Sunday. Mum says bring the cake.",
		"I dey come, wait for me at the junction.",
		"Your Jumia order has been shipped and will arrive on Friday.",
	} {
		if r := c.CheckMessage(text); r.Verdict != LooksSafe {
			t.Errorf("%q flagged: %s (score %.2f) %+v", text, r.Verdict, r.Score, r.Reasons)
		}
	}
}

func TestRealOTPNoticeIsNotARequestButARequestIs(t *testing.T) {
	c := mustNew(t)
	if hasReason(c.CheckMessage("Your OTP is 123456. Never share this code with anyone."), "asks_for_secret") {
		t.Error("a bank's own OTP notice was taken for a request")
	}
	if !hasReason(c.CheckMessage("Please reply with your OTP and card PIN to keep your account"), "asks_for_secret") {
		t.Error("a request for the OTP was missed")
	}
}

func TestLinkChecks(t *testing.T) {
	c := mustNew(t)
	for text, want := range map[string]string{
		"visit http://192.168.4.20/pay now":          "ip_link",
		"go to https://xn--gtbank-9ya.com/login":     "disguised_link",
		"click bit.ly/3xK9aQ":                        "short_link",
		"open https://nem-bank-secure.xyz/verify":    "lookalike_domain",
		"http://example.com/page":                    "insecure_link",
		"pay at https://paystack.com/pay/abc":        "",
		"our app https://nem-bank-fodx.vercel.app/x": "",
	} {
		r := c.CheckLink(text)
		if want == "" {
			if len(r.Reasons) != 0 {
				t.Errorf("%q flagged: %+v", text, r.Reasons)
			}
			continue
		}
		if !hasReason(r, want) {
			t.Errorf("%q: want %s, got %+v", text, want, r.Reasons)
		}
	}
}

func TestRulesOnlyIsTheFallback(t *testing.T) {
	c, err := RulesOnly()
	if err != nil {
		t.Fatal(err)
	}
	if c.ModelLoaded() {
		t.Fatal("rules-only checker has a model")
	}
	r := c.CheckMessage("URGENT: your account is blocked. Send your OTP and PIN now.")
	if r.Verdict != LikelyScam || r.ModelUsed || r.ModelVersion != "" {
		t.Fatalf("rules-only = %+v", r)
	}
	if got := c.CheckMessage("See you at church on Sunday"); got.Verdict != LooksSafe || got.Score != 0.02 {
		t.Fatalf("calm message = %+v", got)
	}
}

func TestScoreAndVerdictsMatchTheApp(t *testing.T) {
	c, _ := RulesOnly()
	// Two medium signs: 0.02 + 0.2 + 0.2 = 0.42, suspicious (the app says the same).
	if r := c.CheckMessage("Your account is blocked, act immediately"); r.Verdict != Suspicious || r.Score != 0.42 {
		t.Fatalf("two medium signs = %s %.2f", r.Verdict, r.Score)
	}
	// One high and one medium: 0.02 + 0.45 + 0.2 = 0.67, likely a scam.
	if r := c.CheckMessage("Send your OTP immediately"); r.Verdict != LikelyScam || r.Score != 0.67 {
		t.Fatalf("high plus medium = %s %.2f", r.Verdict, r.Score)
	}
}

func TestAccountChecks(t *testing.T) {
	c := mustNew(t)
	if r := c.CheckAccount(true, false); r.Verdict != LooksSafe || len(r.Reasons) != 0 {
		t.Fatalf("known account = %+v", r)
	}
	if r := c.CheckAccount(false, false); r.Verdict != LooksSafe || !hasReason(r, "unknown_account") {
		t.Fatalf("unknown account = %+v", r)
	}
	if r := c.CheckAccount(false, true); r.Verdict != LikelyScam || !hasReason(r, "reported_account") {
		t.Fatalf("reported account = %+v", r)
	}
}

func hasReason(r Result, code string) bool {
	for _, x := range r.Reasons {
		if x.Code == code {
			return true
		}
	}
	return false
}

func signedIn() context.Context {
	return identity.WithPrincipal(context.Background(), identity.Principal{UserID: uuid.New()})
}

func TestServiceChecksEachKind(t *testing.T) {
	var asked []string
	s, err := NewService(Config{
		KnownAccount: func(_ context.Context, n string) (bool, error) {
			asked = append(asked, n)
			return n == "0123456789", nil
		},
		Reported: func(_ context.Context, n string) (bool, error) { return n == "1111111111", nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx := signedIn()

	o, err := s.Check(ctx, "message", "Urgent! You have won N500,000. Pay a processing fee to claim.")
	if err != nil || o.Verdict != LikelyScam || o.ReportedAccount != nil {
		t.Fatalf("message = %+v %v", o, err)
	}
	if o, err = s.Check(ctx, "account_number", "0123-456-789"); err != nil || o.Verdict != LooksSafe || o.ReportedAccount == nil || *o.ReportedAccount {
		t.Fatalf("known account = %+v %v", o, err)
	}
	if asked[0] != "0123456789" {
		t.Fatalf("lookup got %q, want digits only", asked[0])
	}
	if o, err = s.Check(ctx, "account_number", "1111111111"); err != nil || o.Verdict != LikelyScam || !*o.ReportedAccount {
		t.Fatalf("reported account = %+v %v", o, err)
	}
	if _, err = s.Check(ctx, "account_number", "12345"); err == nil {
		t.Fatal("accepted a short account number")
	}
	if _, err = s.Check(context.Background(), "message", "hi"); err == nil {
		t.Fatal("answered without a signed-in customer")
	}
	failing, _ := NewService(Config{KnownAccount: func(context.Context, string) (bool, error) { return false, errors.New("db down") }})
	if _, err = failing.Check(ctx, "account_number", "0123456789"); err == nil {
		t.Fatal("hid a lookup failure behind a verdict")
	}
}

func TestSettingOffUsesTheRulesAlone(t *testing.T) {
	on := true
	s, err := NewService(Config{ModelEnabled: func(context.Context) bool { return on }})
	if err != nil {
		t.Fatal(err)
	}
	if o, _ := s.Check(signedIn(), "message", "hello there"); !o.ModelUsed {
		t.Fatal("model not used while enabled")
	}
	on = false
	if o, _ := s.Check(signedIn(), "message", "hello there"); o.ModelUsed {
		t.Fatal("model used while the customer switched the AI checker off")
	}
}

func TestAPIAnswersWithTheAIBadge(t *testing.T) {
	s, err := NewService(Config{})
	if err != nil {
		t.Fatal(err)
	}
	a := NewAPI(s)
	resp, err := a.CheckScam(signedIn(), api.CheckScamRequestObject{Body: &api.CheckScamJSONRequestBody{
		Kind: api.Message, Content: "Dear customer, update your BVN at bit.ly/abc or your account will be blocked",
	}})
	if err != nil {
		t.Fatal(err)
	}
	r, ok := resp.(api.CheckScam200JSONResponse)
	if !ok {
		t.Fatalf("response is %T", resp)
	}
	if r.Verdict != api.ScamCheckResultVerdict(LikelyScam) || r.Ai.Feature != api.AiMetaFeatureScamChecker || r.Ai.FallbackUsed ||
		r.Ai.Explanation == "" || len(r.Reasons) == 0 || r.Score <= 0 || r.Score > 1 {
		t.Fatalf("result = %+v", r)
	}
	var nilAPI *API
	if _, err := nilAPI.CheckScam(signedIn(), api.CheckScamRequestObject{}); !errors.Is(err, api.ErrNotImplemented) {
		t.Fatalf("nil API: %v", err)
	}
}

func BenchmarkCheckMessage(b *testing.B) {
	c := mustNew(b)
	msg := "Dear customer, your account will be blocked. Update your BVN at http://gtb-verify.com/login now"
	b.ResetTimer()
	for range b.N {
		c.CheckMessage(msg)
	}
}
