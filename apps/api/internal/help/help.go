// Package help serves the help center (SUP-2): a small set of articles anyone can read, with
// search. The articles are the same ones the app's offline demo bank shows.
package help

import (
	"context"
	"sort"
	"strings"
	"time"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
)

// Article is one help article. The body is Markdown.
type Article struct {
	Slug, Title, Category, Body string
}

var updated = time.Date(2026, 10, 1, 9, 0, 0, 0, time.UTC)

// articles are the help center's content, in the order shown when nothing is searched.
var articles = []Article{
	{"transfer-pending", "My transfer is pending", "Transfers",
		"Transfers to other banks usually arrive in seconds. If one fails, the money comes back to you automatically and we tell you."},
	{"cooling-off", "Why did my transfer to a new beneficiary wait 30 minutes?", "Security",
		"The first payment above ₦100,000 to someone new waits 30 minutes, or goes now if you confirm with your PIN or OTP. It stops most \"send it now\" scams."},
	{"panic-button", "Using the panic button", "Security",
		"Panic mode freezes every card and blocks money leaving your account in one tap. Releasing it needs a step-up check."},
	{"kyc-tiers", "KYC tiers and limits", "Account",
		"Tier 1: ₦50,000 a day. Tier 2 (BVN or NIN): ₦200,000. Tier 3 (ID, selfie, address): ₦5,000,000. These are demo values."},
	{"emtl", "What is the ₦50 EMTL charge?", "Fees",
		"The Electronic Money Transfer Levy is a ₦50 government levy on transfers into your account of ₦10,000 or more."},
	{"ajo", "How ajo works on Nem", "Savings",
		"Everyone pays the same amount each cycle into a protected pot, and one member takes the whole pot in turn."},
	{"freeze-card", "Freeze or replace a lost card", "Cards",
		"Open the card in the Cards tab and tap Freeze. Nothing can be charged until you unfreeze it.\n\nIf the card is gone for good, freeze it, then create a new virtual card. Your old card number stops working."},
	{"convert-currency", "Converting naira to dollars, pounds or euros", "FX",
		"Open Convert, choose the currencies and the amount. The rate is locked for 60 seconds while you confirm.\n\nThe rate you see is the rate you get: there is no hidden markup on top."},
	{"report-a-problem", "Reporting a problem with a payment", "Disputes",
		"Open the payment from your transactions and tap Report a problem. Tell us what went wrong and add photos if you have them.\n\nYou get a case number straight away and can follow it in Me > Disputes. If you were charged for a failed payment or charged twice, we usually refund you within a day."},
	{"statements", "Getting a bank statement for a visa or loan", "Account",
		"Go to Me > Statements and pick the dates. Every statement has a verification code and QR, so an embassy or lender can check it is real."},
	{"never-share-pin", "Someone asked for my PIN or a code", "Security",
		"Nem staff will never ask for your PIN, password or a one-time code, by phone, chat or email.\n\nIf someone does, stop talking to them, turn on the panic button if you shared anything, and chat with us from Me > Help and support."},
	{"bills-failed", "My airtime or electricity token did not arrive", "Bills",
		"Most bills complete in seconds. If the biller fails, the money comes back to you automatically.\n\nFor electricity, the token is on the receipt in your transactions. If it still has not arrived after 15 minutes, report a problem on the payment."},
}

// Search returns the articles in a category that contain every word of q, articles whose title
// has the words first. An empty q lists the category.
func Search(q, category string) []Article {
	words := strings.Fields(strings.ToLower(q))
	type hit struct {
		a     Article
		score int
	}
	var hits []hit
	for _, a := range articles {
		if category != "" && !strings.EqualFold(a.Category, category) {
			continue
		}
		title := strings.ToLower(a.Title)
		text := title + " " + strings.ToLower(a.Category) + " " + strings.ToLower(a.Body)
		score, all := 0, true
		for _, w := range words {
			if !strings.Contains(text, w) {
				all = false
				break
			}
			if strings.Contains(title, w) {
				score++
			}
		}
		if all {
			hits = append(hits, hit{a, score})
		}
	}
	sort.SliceStable(hits, func(i, j int) bool { return hits[i].score > hits[j].score })
	out := make([]Article, len(hits))
	for i, h := range hits {
		out[i] = h.a
	}
	return out
}

// excerpt is the first paragraph, cut at a word when it runs long.
func excerpt(body string) string {
	first, _, _ := strings.Cut(body, "\n\n")
	r := []rune(first)
	if len(r) <= 120 {
		return first
	}
	cut := strings.LastIndex(string(r[:117]), " ")
	if cut < 0 {
		cut = len(string(r[:117]))
	}
	return string(r[:117])[:cut] + "…"
}

// API serves the help center operations; the router embeds it. A nil *API answers 501.
type API struct{}

// NewAPI returns the help center operations for the router.
func NewAPI() *API { return &API{} }

// SearchHelpArticles is GET /v1/help/articles.
func (a *API) SearchHelpArticles(_ context.Context, req api.SearchHelpArticlesRequestObject) (api.SearchHelpArticlesResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	var q, category string
	if req.Params.Q != nil {
		q = *req.Params.Q
	}
	if req.Params.Category != nil {
		category = *req.Params.Category
	}
	found := Search(q, category)
	out := api.HelpArticleList{Data: make([]struct {
		Category string `json:"category"`
		Excerpt  string `json:"excerpt"`
		Slug     string `json:"slug"`
		Title    string `json:"title"`
	}, len(found))}
	for i, f := range found {
		out.Data[i].Slug, out.Data[i].Title, out.Data[i].Category, out.Data[i].Excerpt = f.Slug, f.Title, f.Category, excerpt(f.Body)
	}
	return api.SearchHelpArticles200JSONResponse(out), nil
}

// GetHelpArticle is GET /v1/help/articles/{slug}.
func (a *API) GetHelpArticle(_ context.Context, req api.GetHelpArticleRequestObject) (api.GetHelpArticleResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	for _, f := range articles {
		if f.Slug == req.Slug {
			return api.GetHelpArticle200JSONResponse(api.HelpArticle{
				Slug: f.Slug, Title: f.Title, Category: f.Category, BodyMarkdown: f.Body, UpdatedAt: updated,
			}), nil
		}
	}
	return nil, problem.NotFound("Article")
}
