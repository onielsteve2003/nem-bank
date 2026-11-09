package httpserver

import (
	"context"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/ratelimit"
)

// RateLimits are the request limits (T23.5). A zero Rule turns that limit off.
//
// They sit in front of the domains' own limits, which stay: 5 codes per address per hour,
// 5 tries per code, the PIN lockout, 10 step-ups per hour. These stop floods and
// credential stuffing before a request costs an argon2id hash or a database write.
type RateLimits struct {
	// IP caps every contract request per client address. Generous on purpose: Nigerian
	// mobile networks put many customers behind one address (carrier-grade NAT).
	IP ratelimit.Rule
	// User caps every authenticated request per customer.
	User ratelimit.Rule
	// Routes caps single public routes per client address: the ones that check a secret
	// or send email. Keyed "METHOD /gin/path".
	Routes map[string]ratelimit.Rule
	// Signed caps each money-moving route per customer.
	Signed ratelimit.Rule
	// CustomerRoutes caps single authenticated routes per customer: lookups a script could
	// use to walk account numbers and harvest names. Keyed "METHOD /gin/path".
	CustomerRoutes map[string]ratelimit.Rule
}

// DefaultRateLimits are the production limits.
func DefaultRateLimits() RateLimits {
	perMin := func(n int) ratelimit.Rule { return ratelimit.Rule{Limit: n, Window: time.Minute} }
	perHour := func(n int) ratelimit.Rule { return ratelimit.Rule{Limit: n, Window: time.Hour} }
	return RateLimits{
		IP:   perMin(600),
		User: perMin(300),
		Routes: map[string]ratelimit.Rule{
			"POST /v1/auth/signup":           perHour(20),
			"POST /v1/auth/signup/complete":  perHour(20),
			"POST /v1/auth/otp/verify":       perMin(10),
			"POST /v1/auth/otp/resend":       perHour(20),
			"POST /v1/auth/login":            perMin(10),
			"POST /v1/auth/device-challenge": perMin(10),
			"POST /v1/auth/login/device":     perMin(10),
			"POST /v1/auth/password/forgot":  perHour(10),
			"POST /v1/auth/password/reset":   perHour(10),
			"POST /v1/auth/demo":             perHour(30),
			"POST /v1/auth/refresh":          perMin(60),
			"POST /v1/admin/auth/login":      perMin(10),
			"POST /v1/admin/auth/totp":       perMin(10),
		},
		// A person sends a handful of payments a minute at most; a script sends hundreds.
		Signed: perMin(30),
		// Name enquiry answers "whose account is 0123456789?": generous for someone paying
		// people, useless for harvesting names.
		CustomerRoutes: map[string]ratelimit.Rule{
			"POST /v1/payees/resolve": perHour(60),
		},
	}
}

// limiter applies RateLimits with one shared Limiter.
type limiter struct {
	rules RateLimits
	l     *ratelimit.Limiter
	now   func() time.Time
}

func newLimiter(rules RateLimits, now func() time.Time) *limiter {
	return &limiter{rules: rules, l: ratelimit.New(now), now: now}
}

// allow returns the 429 to send, or nil. (A *problem.Error, not error, so a nil result is
// never a non-nil interface.)
func (lim *limiter) allow(key string, rule ratelimit.Rule) *problem.Error {
	if ok, wait := lim.l.Allow(key, rule); !ok {
		return problem.RateLimited(lim.now().Add(wait))
	}
	return nil
}

// byAddress is the per-address check, before validation: a flood is refused before it
// costs anything. Keys carry the rule's name so one route cannot spend another's budget.
func (lim *limiter) byAddress() gin.HandlerFunc {
	return func(c *gin.Context) {
		ip := c.ClientIP()
		if err := lim.allow("ip:"+ip, lim.rules.IP); err != nil {
			problem.Render(c, err)
			return
		}
		route := c.Request.Method + " " + c.FullPath()
		if rule, ok := lim.rules.Routes[route]; ok {
			if err := lim.allow("route:"+route+":"+ip, rule); err != nil {
				problem.Render(c, err)
				return
			}
		}
		c.Next()
	}
}

// byCustomer is the per-customer check, once the validator knows who is calling and
// before a money request's signature is checked (which writes its nonce).
func (lim *limiter) byCustomer(ctx context.Context, c *gin.Context, signed bool) error {
	p, ok := identity.PrincipalFrom(ctx)
	if !ok {
		return nil
	}
	user := p.UserID.String()
	if err := lim.allow("user:"+user, lim.rules.User); err != nil {
		return err
	}
	route := c.Request.Method + " " + c.FullPath()
	if rule, ok := lim.rules.CustomerRoutes[route]; ok {
		if err := lim.allow("customer-route:"+route+":"+user, rule); err != nil {
			return err
		}
	}
	if !signed {
		return nil
	}
	if err := lim.allow("signed:"+route+":"+user, lim.rules.Signed); err != nil {
		return err
	}
	return nil
}
