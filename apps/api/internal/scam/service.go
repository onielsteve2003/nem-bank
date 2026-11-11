package scam

import (
	"context"
	"errors"
	"net/http"
	"regexp"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
)

// Config holds the service's dependencies.
type Config struct {
	// Checker judges messages and links; nil builds the real one and, if its model will not
	// load, falls back to the rules alone.
	Checker *Checker
	// KnownAccount reports whether a Nem customer holds the account number; nil treats every
	// number as unknown.
	KnownAccount func(ctx context.Context, number string) (bool, error)
	// Reported reports whether other customers reported the account number; nil means no
	// reports exist yet, and the answer says nothing either way.
	Reported func(ctx context.Context, number string) (bool, error)
	// ModelEnabled is the customer's "AI scam checker" setting; nil means on. Off, the rules
	// and link checks answer alone.
	ModelEnabled func(ctx context.Context) bool
}

// Service is the scam checker.
type Service struct {
	checker  *Checker
	fallback *Checker
	known    func(context.Context, string) (bool, error)
	reported func(context.Context, string) (bool, error)
	enabled  func(context.Context) bool
}

// NewService builds the service.
func NewService(cfg Config) (*Service, error) {
	rulesOnly, err := RulesOnly()
	if err != nil {
		return nil, err
	}
	if cfg.Checker == nil {
		if cfg.Checker, err = New(); err != nil {
			// The model is an extra: without it the rules still protect the customer.
			cfg.Checker = rulesOnly
		}
	}
	return &Service{checker: cfg.Checker, fallback: rulesOnly, known: cfg.KnownAccount, reported: cfg.Reported, enabled: cfg.ModelEnabled}, nil
}

var errAccountDigits = problem.New(http.StatusUnprocessableEntity, problem.CodeValidationFailed, "Enter a 10-digit account number")

var nonDigits = regexp.MustCompile(`\D`)

// Outcome is a result plus what only an account check knows.
type Outcome struct {
	Result
	// ReportedAccount is set for account numbers when reports can be looked up.
	ReportedAccount *bool
}

// Check judges the content. It keeps nothing: the text is not stored and not logged.
func (s *Service) Check(ctx context.Context, kind, content string) (Outcome, error) {
	if _, ok := identity.PrincipalFrom(ctx); !ok {
		return Outcome{}, problem.Unauthorized()
	}
	checker := s.checker
	if s.enabled != nil && !s.enabled(ctx) {
		checker = s.fallback
	}
	switch api.ScamCheckRequestKind(kind) {
	case api.Message:
		return Outcome{Result: checker.CheckMessage(content)}, nil
	case api.Link:
		return Outcome{Result: checker.CheckLink(content)}, nil
	case api.AccountNumber:
		digits := nonDigits.ReplaceAllString(content, "")
		if len(digits) != 10 {
			return Outcome{}, errAccountDigits
		}
		known, reported := false, false
		var reportedAnswer *bool
		if s.known != nil {
			k, err := s.known(ctx, digits)
			if err != nil {
				return Outcome{}, err
			}
			known = k
		}
		if s.reported != nil {
			r, err := s.reported(ctx, digits)
			if err != nil {
				return Outcome{}, err
			}
			reported, reportedAnswer = r, &r
		}
		return Outcome{Result: checker.CheckAccount(known, reported), ReportedAccount: reportedAnswer}, nil
	default:
		return Outcome{}, errors.New("scam: unknown kind") // the contract validator refuses these first
	}
}

// API adapts the service to the contract's strict server; the router embeds it. A nil *API
// answers 501.
type API struct{ svc *Service }

// NewAPI returns the scam-checker operations for the router.
func NewAPI(svc *Service) *API { return &API{svc: svc} }

// CheckScam is POST /v1/security/scam-check.
func (a *API) CheckScam(ctx context.Context, req api.CheckScamRequestObject) (api.CheckScamResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	if req.Body == nil {
		return nil, problem.New(http.StatusBadRequest, problem.CodeValidationFailed, "Content to check is required")
	}
	o, err := a.svc.Check(ctx, string(req.Body.Kind), req.Body.Content)
	if err != nil {
		return nil, err
	}
	reasons := make([]api.RiskReason, len(o.Reasons))
	for i, r := range o.Reasons {
		reasons[i] = api.RiskReason{Code: r.Code, Message: r.Message, Severity: api.RiskReasonSeverity(r.Severity)}
	}
	meta := api.AiMeta{
		Feature:      api.AiMetaFeatureScamChecker,
		ModelVersion: o.ModelVersion, FallbackUsed: !o.ModelUsed,
		Explanation: explanation(o.ModelUsed),
	}
	if meta.ModelVersion == "" {
		meta.ModelVersion = "rules-v1"
	}
	return api.CheckScam200JSONResponse{
		Verdict: api.ScamCheckResultVerdict(o.Verdict), Score: float32(o.Score), Reasons: reasons, Advice: o.Advice,
		ReportedAccount: o.ReportedAccount, Ai: meta,
	}, nil
}

func explanation(modelUsed bool) string {
	if modelUsed {
		return "Checked with Nigerian scam rules, link checks and a text model trained on example scam and normal messages. Your message was checked and discarded, never stored."
	}
	return "Checked with Nigerian scam rules and link checks. Your message was checked and discarded, never stored."
}
