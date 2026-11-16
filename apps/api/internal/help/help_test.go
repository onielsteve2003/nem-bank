package help

import (
	"errors"
	"testing"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
)

func TestSearchNeedsEveryWordAndRanksTitlesFirst(t *testing.T) {
	t.Parallel()
	if got := Search("", ""); len(got) != len(articles) {
		t.Fatalf("empty search lists %d, want all %d", len(got), len(articles))
	}
	if got := Search("", "security"); len(got) != 3 {
		t.Fatalf("category filter (case-insensitive) = %d, want 3", len(got))
	}
	got := Search("card freeze", "")
	if len(got) == 0 || got[0].Slug != "freeze-card" {
		t.Fatalf("card freeze = %+v", got)
	}
	// "pin" is in a title and in other bodies: the title match comes first.
	if got := Search("pin", ""); len(got) < 2 || got[0].Slug != "never-share-pin" {
		t.Fatalf("pin = %+v", got)
	}
	if got := Search("xyzzy", ""); len(got) != 0 {
		t.Fatalf("nonsense = %+v", got)
	}
}

func TestExcerptCutsLongFirstParagraphAtAWord(t *testing.T) {
	t.Parallel()
	if got := excerpt("Short.\n\nSecond paragraph."); got != "Short." {
		t.Fatalf("short = %q", got)
	}
	long := excerpt("word word word word word word word word word word word word word word word word word word word word word word word word word")
	if len([]rune(long)) > 121 || long[len(long)-len("…"):] != "…" {
		t.Fatalf("long = %q", long)
	}
}

func TestAPI(t *testing.T) {
	t.Parallel()
	a := NewAPI()
	list, err := a.SearchHelpArticles(t.Context(), api.SearchHelpArticlesRequestObject{})
	if err != nil || len(list.(api.SearchHelpArticles200JSONResponse).Data) != len(articles) {
		t.Fatalf("list = %v, %v", list, err)
	}
	one, err := a.GetHelpArticle(t.Context(), api.GetHelpArticleRequestObject{Slug: "emtl"})
	if err != nil || one.(api.GetHelpArticle200JSONResponse).Title != "What is the ₦50 EMTL charge?" {
		t.Fatalf("get = %v, %v", one, err)
	}
	if _, err := a.GetHelpArticle(t.Context(), api.GetHelpArticleRequestObject{Slug: "nope"}); !errors.Is(err, problem.NotFound("Article")) {
		t.Fatalf("missing: %v", err)
	}
	var none *API
	if _, err := none.GetHelpArticle(t.Context(), api.GetHelpArticleRequestObject{}); !errors.Is(err, api.ErrNotImplemented) {
		t.Fatalf("nil API: %v", err)
	}
}
