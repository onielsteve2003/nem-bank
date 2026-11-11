package support

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/accounts"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/audit"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/testdb"
)

type fixture struct {
	t    *testing.T
	pool *pgxpool.Pool
	svc  *Service
	now  time.Time
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	pool := testdb.New(t)
	f := &fixture{t: t, pool: pool, now: time.Now().UTC()}
	svc, err := NewService(Config{
		Pool: pool, FilesKey: bytes.Repeat([]byte{9}, 32), Logger: slog.New(slog.NewTextHandler(io.Discard, nil)), Now: func() time.Time { return f.now },
	})
	if err != nil {
		t.Fatal(err)
	}
	f.svc = svc
	return f
}

type person struct {
	id      uuid.UUID
	account uuid.UUID
	ctx     context.Context
}

var seq int

func (f *fixture) person(name string) person {
	f.t.Helper()
	seq++
	id := uuid.New()
	if _, err := f.pool.Exec(f.t.Context(), `INSERT INTO users (id, first_name, last_name, email, phone, nemtag, date_of_birth,
		password_hash, terms_version, privacy_version, consent_accepted_at)
		VALUES ($1, $2, 'User', $3, $4, $5, '1996-04-12', 'x', '2026-10', '2026-10', now())`,
		id, name, name+"@example.com", "+234806610"+strings.Repeat("0", 4)[:4-len(itoa(seq))]+itoa(seq), name+"1"); err != nil {
		f.t.Fatal(err)
	}
	if err := pgx.BeginFunc(f.t.Context(), f.pool, func(tx pgx.Tx) error {
		return accounts.OpenCurrentAccount(f.t.Context(), tx, identity.NewCustomer{UserID: id, Name: name + " User"})
	}); err != nil {
		f.t.Fatal(err)
	}
	var acct uuid.UUID
	if err := f.pool.QueryRow(f.t.Context(), `SELECT account_id FROM customer_accounts WHERE user_id = $1 AND currency = 'NGN'`, id).Scan(&acct); err != nil {
		f.t.Fatal(err)
	}
	return person{id: id, account: acct, ctx: identity.WithPrincipal(f.t.Context(), identity.Principal{UserID: id, SessionID: uuid.New(), DeviceID: uuid.New()})}
}

func itoa(n int) string {
	return strings.TrimSpace(strings.Join(strings.Fields(string(rune('0'+n/10))+string(rune('0'+n%10))), ""))
}

// spend funds the account and records one debit line; it returns the line's ID.
func (f *fixture) spend(p person, kobo int64, status string, at time.Time) uuid.UUID {
	f.t.Helper()
	var id uuid.UUID
	err := pgx.BeginFunc(f.t.Context(), f.pool, func(tx pgx.Tx) error {
		src, err := ledger.SystemAccount(f.t.Context(), tx, ledger.KindDemoFunding, "NGN")
		if err != nil {
			return err
		}
		fund := money.New(1_000_000_00, money.NGN)
		if _, err := ledger.Post(f.t.Context(), tx, ledger.Entry{Kind: "demo_funding", Reference: "fund-" + uuid.NewString(), Legs: []ledger.Leg{ledger.Debit(src.ID, fund), ledger.Credit(p.account, fund)}}); err != nil {
			return err
		}
		amt := money.New(kobo, money.NGN)
		posted, err := ledger.Post(f.t.Context(), tx, ledger.Entry{Kind: "demo_funding", Reference: "spend-" + uuid.NewString(), Legs: []ledger.Leg{ledger.Debit(p.account, amt), ledger.Credit(src.ID, amt)}})
		if err != nil {
			return err
		}
		tx2, err := accounts.Record(f.t.Context(), tx, accounts.Line{
			UserID: p.id, AccountID: p.account, Type: "card_payment", Direction: "debit", Status: status, Amount: amt, Entry: &posted,
			Narration: "Shop", Reference: "ref-" + uuid.NewString(), Category: "shopping", At: at, Counterparty: api.Counterparty{Name: "Shop"},
		})
		id = tx2.ID
		return err
	})
	if err != nil {
		f.t.Fatal(err)
	}
	return id
}

func (f *fixture) balance(p person) int64 {
	f.t.Helper()
	b, err := ledger.GetBalances(f.t.Context(), f.pool, p.account)
	if err != nil {
		f.t.Fatal(err)
	}
	return b.Ledger.Amount()
}

func (f *fixture) outbox(topic string) int {
	f.t.Helper()
	var n int
	if err := f.pool.QueryRow(f.t.Context(), `SELECT count(*) FROM outbox_events WHERE topic = $1`, topic).Scan(&n); err != nil {
		f.t.Fatal(err)
	}
	return n
}

func (f *fixture) agent(name string) Agent {
	f.t.Helper()
	id := uuid.New()
	if _, err := f.pool.Exec(f.t.Context(), `INSERT INTO staff (id, name, email, password_hash, roles, totp_secret) VALUES ($1, $2, $3, 'x', ARRAY['support'], '\x00')`,
		id, name, strings.ReplaceAll(strings.ToLower(name), " ", ".")+"@nem.test"); err != nil {
		f.t.Fatal(err)
	}
	sid := id.String()
	return Agent{ID: id, Name: name, Actor: audit.Actor{Type: audit.ActorStaff, ID: &sid}}
}

func png(n int) []byte { return append([]byte("\x89PNG\r\n\x1a\n"), make([]byte, n)...) }

func form(t *testing.T, file []byte) *multipart.Reader {
	t.Helper()
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	fw, err := w.CreateFormFile("file", "receipt.png")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = fw.Write(file)
	_ = w.Close()
	return multipart.NewReader(&buf, w.Boundary())
}

func code(t *testing.T, err error) int {
	t.Helper()
	var pe *problem.Error
	if !errors.As(err, &pe) {
		t.Fatalf("want a problem, got %v", err)
	}
	return pe.Status
}

func TestDisputeLifecycleRefundsThroughTheLedger(t *testing.T) {
	f := newFixture(t)
	ada, bob := f.person("ada"), f.person("bob")
	txn := f.spend(ada, 5_000_00, "completed", f.now.Add(-24*time.Hour))
	reviewer := Reviewer{ID: uuid.New(), Actor: audit.Actor{Type: audit.ActorStaff, ID: new(string)}}

	// Only your own, finished, recent transactions can be disputed.
	req := CreateDisputeRequest{TransactionID: txn, Reason: "unauthorised", Description: "I did not make this payment."}
	if _, err := f.svc.CreateDispute(bob.ctx, req); code(t, err) != http.StatusNotFound {
		t.Errorf("someone else's transaction: %v", err)
	}
	if _, err := f.svc.CreateDispute(ada.ctx, CreateDisputeRequest{TransactionID: txn, Reason: "other", Description: "short"}); code(t, err) != http.StatusBadRequest {
		t.Errorf("a too-short description: %v", err)
	}
	pending := f.spend(ada, 100_00, "pending", f.now)
	if _, err := f.svc.CreateDispute(ada.ctx, CreateDisputeRequest{TransactionID: pending, Reason: "other", Description: "Still shows as pending."}); code(t, err) != http.StatusUnprocessableEntity {
		t.Errorf("a pending transaction: %v", err)
	}
	old := f.spend(ada, 100_00, "completed", f.now.AddDate(0, 0, -121))
	if _, err := f.svc.CreateDispute(ada.ctx, CreateDisputeRequest{TransactionID: old, Reason: "other", Description: "This was a long time ago."}); code(t, err) != http.StatusUnprocessableEntity {
		t.Errorf("outside the 120-day window: %v", err)
	}

	// Evidence uploaded first can be attached once, and only by its owner.
	file, err := f.svc.Upload(ada.ctx, form(t, png(3000)), "support")
	if err != nil {
		t.Fatal(err)
	}
	req.AttachmentIDs = []uuid.UUID{file.Id}
	if other := (CreateDisputeRequest{TransactionID: txn, Reason: "other", Description: "I did not make this payment.", AttachmentIDs: []uuid.UUID{file.Id}}); true {
		if _, err := f.svc.CreateDispute(bob.ctx, other); code(t, err) != http.StatusNotFound {
			t.Errorf("bob on ada's transaction: %v", err)
		}
	}
	d, err := f.svc.CreateDispute(ada.ctx, req)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(d.CaseNumber, "DSP-1000") || d.Status != api.Submitted || len(d.Evidence) != 1 || len(d.Timeline) != 1 || d.Refund != nil {
		t.Fatalf("dispute = %+v", d)
	}
	if _, err := f.svc.CreateDispute(ada.ctx, req); code(t, err) != http.StatusBadRequest {
		t.Errorf("reusing a file that is already evidence: %v", err)
	}
	if _, err := f.svc.CreateDispute(ada.ctx, CreateDisputeRequest{TransactionID: txn, Reason: "other", Description: "Trying a second time."}); code(t, err) != http.StatusConflict {
		t.Errorf("a second open dispute on one transaction: %v", err)
	}
	if _, err := f.svc.Dispute(bob.ctx, d.Id); !errors.Is(err, ErrDisputeNotFound) {
		t.Errorf("bob read ada's dispute: %v", err)
	}

	// Staff look, ask for more; the customer's evidence puts it back under review.
	if err := f.svc.StartReview(t.Context(), d.Id, reviewer); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.Decide(t.Context(), Decision{DisputeID: d.Id, Outcome: "request_info", Note: "Please send the receipt.", Reviewer: reviewer}); err != nil {
		t.Fatal(err)
	}
	got, err := f.svc.AddEvidence(ada.ctx, d.Id, form(t, png(3500)))
	if err != nil || got.Status != api.UnderReview || len(got.Evidence) != 2 {
		t.Fatalf("after evidence: %+v, %v", got, err)
	}
	if _, err := f.svc.AddEvidence(ada.ctx, d.Id, form(t, bytes.Repeat([]byte("not an image "), 400))); code(t, err) != http.StatusUnsupportedMediaType {
		t.Errorf("a text file as evidence: %v", err)
	}

	// A refund is bounded by the disputed amount and its currency, and needs an amount.
	over := money.New(5_000_01, money.NGN)
	if _, err := f.svc.Decide(t.Context(), Decision{DisputeID: d.Id, Outcome: "refund", Note: "Refund it all.", Refund: &over, Reviewer: reviewer}); code(t, err) != http.StatusBadRequest {
		t.Errorf("a refund above the transaction: %v", err)
	}
	if _, err := f.svc.Decide(t.Context(), Decision{DisputeID: d.Id, Outcome: "refund", Note: "Refund it all.", Reviewer: reviewer}); code(t, err) != http.StatusBadRequest {
		t.Errorf("a refund with no amount: %v", err)
	}
	before := f.balance(ada)
	refund := money.New(2_000_00, money.NGN)
	res, err := f.svc.Decide(t.Context(), Decision{DisputeID: d.Id, Outcome: "refund", Note: "Merchant confirmed the error.", Refund: &refund, Reviewer: reviewer})
	if err != nil || res.Status != "resolved_refunded" || res.RefundTransactionID == nil {
		t.Fatalf("refund = %+v, %v", res, err)
	}
	if after := f.balance(ada); after != before+2_000_00 {
		t.Errorf("balance %d → %d, want +₦2,000", before, after)
	}
	var typ, dir string
	if err := f.pool.QueryRow(t.Context(), `SELECT type, direction FROM transactions WHERE id = $1`, *res.RefundTransactionID).Scan(&typ, &dir); err != nil || typ != "dispute_refund" || dir != "credit" {
		t.Errorf("history line = %s/%s, %v", typ, dir, err)
	}
	final, err := f.svc.Dispute(ada.ctx, d.Id)
	if err != nil || final.Refund == nil || final.Refund.AmountMinor != "200000" || final.ResolvedAt == nil || len(final.Timeline) < 5 {
		t.Fatalf("final = %+v, %v", final, err)
	}
	// Settled is settled: no second refund, no withdrawing, no more evidence.
	if _, err := f.svc.Decide(t.Context(), Decision{DisputeID: d.Id, Outcome: "refund", Note: "Refund again.", Refund: &refund, Reviewer: reviewer}); !errors.Is(err, ErrDisputeClosed) {
		t.Errorf("second refund: %v", err)
	}
	if _, err := f.svc.Withdraw(ada.ctx, d.Id); !errors.Is(err, ErrDisputeClosed) {
		t.Errorf("withdraw a resolved dispute: %v", err)
	}
	if _, err := f.svc.AddEvidence(ada.ctx, d.Id, form(t, png(3000))); !errors.Is(err, ErrDisputeClosed) {
		t.Errorf("evidence on a resolved dispute: %v", err)
	}
	if after := f.balance(ada); after != before+2_000_00 {
		t.Errorf("a refused second refund still moved money: %d", after)
	}

	// With the first one settled, a new dispute on the transaction is allowed, and can be withdrawn.
	again, err := f.svc.CreateDispute(ada.ctx, CreateDisputeRequest{TransactionID: txn, Reason: "wrong_amount", Description: "The rest is still wrong."})
	if err != nil {
		t.Fatal(err)
	}
	if w, err := f.svc.Withdraw(ada.ctx, again.Id); err != nil || w.Status != api.Withdrawn {
		t.Errorf("withdraw: %+v, %v", w, err)
	}
	list, page, err := f.svc.Disputes(ada.ctx, nil, nil)
	if err != nil || len(list) != 2 || page.NextCursor != nil || list[0].Id != again.Id {
		t.Errorf("list = %d disputes, newest first expected: %v", len(list), err)
	}
	queue, _, err := f.svc.DisputeQueue(t.Context(), "", nil, nil)
	if err != nil || len(queue) != 0 {
		t.Errorf("open queue = %d, want none: %v", len(queue), err)
	}
	// submitted, under review, info requested, back under review, refunded, second submitted, withdrawn.
	if n := f.outbox(TopicDisputeUpdated); n != 7 {
		t.Errorf("dispute.updated events = %d", n)
	}
	var audited int
	if err := f.pool.QueryRow(t.Context(), `SELECT count(*) FROM audit_log WHERE action LIKE 'dispute.%'`).Scan(&audited); err != nil || audited != 2 {
		t.Errorf("staff rulings audited = %d, %v (the request for info and the refund; refused rulings write nothing)", audited, err)
	}
}

func TestChatAssignmentRepliesAndClosing(t *testing.T) {
	f := newFixture(t)
	ada, bob := f.person("ada"), f.person("bob")

	// With no agent on duty the chat still opens, unassigned, with an honest welcome.
	c0, err := f.svc.StartConversation(ada.ctx, "Card question", "My card was declined.", nil)
	if err != nil || c0.AssignedAgent != nil || c0.Status != api.SupportConversationStatusOpen {
		t.Fatalf("no agent: %+v, %v", c0, err)
	}
	if _, err := f.svc.StartConversation(ada.ctx, "", "x", nil); code(t, err) != http.StatusBadRequest {
		t.Errorf("empty subject: %v", err)
	}
	if _, err := f.svc.StartConversation(ada.ctx, "About a payment", "Hello", &[]uuid.UUID{uuid.New()}[0]); code(t, err) != http.StatusNotFound {
		t.Errorf("a made-up transaction: %v", err)
	}

	// The agent with the fewest open chats gets the next one; ties go to the lowest ID.
	grace, tunde := f.agent("Grace Okafor"), f.agent("Tunde Bello")
	c1, err := f.svc.StartConversation(bob.ctx, "Transfer delay", "Where is my money?", nil)
	if err != nil || c1.AssignedAgent == nil {
		t.Fatalf("assigned: %+v, %v", c1, err)
	}
	first := *c1.AssignedAgent
	c2, _ := f.svc.StartConversation(bob.ctx, "Another thing", "One more question.", nil)
	if c2.AssignedAgent == nil || *c2.AssignedAgent == first {
		t.Errorf("the second chat went to the same busy agent: %v vs %v", c2.AssignedAgent, first)
	}
	if first != "Grace" && first != "Tunde" {
		t.Errorf("agent name shown = %q, want a first name only", first)
	}
	_ = grace
	_ = tunde

	// Messages: newest first, the welcome is unread until the customer opens the chat.
	conv, _ := f.svc.Conversation(bob.ctx, c1.Id)
	if conv.UnreadCount != 1 {
		t.Errorf("unread before opening = %d, want the welcome", conv.UnreadCount)
	}
	msgs, _, err := f.svc.Messages(bob.ctx, c1.Id, nil, nil)
	if err != nil || len(msgs) != 2 || msgs[0].Sender != api.SupportMessageSender("system") || msgs[1].Body != "Where is my money?" {
		t.Fatalf("messages = %+v, %v", msgs, err)
	}
	if conv, _ = f.svc.Conversation(bob.ctx, c1.Id); conv.UnreadCount != 0 {
		t.Errorf("unread after opening = %d", conv.UnreadCount)
	}
	if _, _, err := f.svc.Messages(ada.ctx, c1.Id, nil, nil); !errors.Is(err, ErrConversationNotFound) {
		t.Errorf("ada read bob's chat: %v", err)
	}

	// An agent replies: the chat waits on the customer and the customer has one unread.
	agent := grace
	if first == "Tunde" {
		agent = tunde
	}
	rep, err := f.svc.Reply(t.Context(), c1.Id, agent, "We are checking it now.")
	if err != nil || rep.Sender != api.SupportMessageSenderAgent || rep.SenderName == nil {
		t.Fatalf("reply = %+v, %v", rep, err)
	}
	if conv, _ = f.svc.Conversation(bob.ctx, c1.Id); conv.Status != api.SupportConversationStatusWaitingOnCustomer || conv.UnreadCount != 1 {
		t.Errorf("after reply: %+v", conv)
	}

	// The customer answers with a file; a file can only be used once, and not by someone else.
	att, err := f.svc.Upload(bob.ctx, form(t, png(3000)), "support")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.SendMessage(ada.ctx, c1.Id, "hi", []uuid.UUID{att.Id}); !errors.Is(err, ErrConversationNotFound) {
		t.Errorf("ada wrote into bob's chat: %v", err)
	}
	sent, err := f.svc.SendMessage(bob.ctx, c1.Id, "Here is the receipt.", []uuid.UUID{att.Id})
	if err != nil || len(sent.Attachments) != 1 {
		t.Fatalf("send = %+v, %v", sent, err)
	}
	if _, err := f.svc.SendMessage(bob.ctx, c1.Id, "Again", []uuid.UUID{att.Id}); code(t, err) != http.StatusBadRequest {
		t.Errorf("reusing an attachment: %v", err)
	}
	if conv, _ = f.svc.Conversation(bob.ctx, c1.Id); conv.Status != api.SupportConversationStatusOpen {
		t.Errorf("a customer message should reopen the wait: %+v", conv)
	}

	// The agent's inbox: mine only, longest waiting first, with the customer's name.
	inbox, _, err := f.svc.AgentInbox(t.Context(), "open", &agent.ID, nil, nil)
	if err != nil || len(inbox) == 0 || inbox[0].Customer.Name != "bob User" {
		t.Fatalf("inbox = %+v, %v", inbox, err)
	}
	agentMsgs, _, err := f.svc.AgentMessages(t.Context(), c1.Id, nil, nil)
	if err != nil || len(agentMsgs) != 4 {
		t.Fatalf("agent view = %d messages, %v", len(agentMsgs), err)
	}
	// An unassigned chat goes to whoever replies first.
	if _, err := f.svc.Reply(t.Context(), c0.Id, tunde, "Hello Ada."); err != nil {
		t.Fatal(err)
	}
	if conv0, _ := f.svc.Conversation(ada.ctx, c0.Id); conv0.AssignedAgent == nil || *conv0.AssignedAgent != "Tunde" {
		t.Errorf("first replier should own the chat: %+v", conv0)
	}
	moved, err := f.svc.Assign(t.Context(), c0.Id, grace)
	if err != nil || moved.AgentName == nil || *moved.AgentName != "Grace" {
		t.Errorf("reassign: %+v, %v", moved, err)
	}

	// Resolving closes it: nobody can post, and the customer sees how it ended.
	if _, err := f.svc.Resolve(t.Context(), c1.Id, agent); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.SendMessage(bob.ctx, c1.Id, "One more thing", nil); code(t, err) != http.StatusConflict {
		t.Errorf("writing to a resolved chat: %v", err)
	}
	if _, err := f.svc.Reply(t.Context(), c1.Id, agent, "Hello?"); code(t, err) != http.StatusConflict {
		t.Errorf("agent writing to a resolved chat: %v", err)
	}
	list, err := f.svc.Conversations(bob.ctx)
	if err != nil || len(list) != 2 || list[0].Status == api.SupportConversationStatusResolved || list[1].Status != api.SupportConversationStatusResolved {
		t.Errorf("open chats should list first: %+v, %v", list, err)
	}
	if n := f.outbox(TopicMessage); n < 9 {
		t.Errorf("support.message events = %d", n)
	}
	if err := f.svc.Typing(t.Context(), c1.Id, true); err != nil {
		t.Errorf("typing with no hub should be a quiet no-op: %v", err)
	}
}

func TestStartingChatsIsCappedPerDay(t *testing.T) {
	f := newFixture(t)
	ada := f.person("ada")
	for i := range chatsPerDay {
		if _, err := f.svc.StartConversation(ada.ctx, "Question", "Hello "+string(rune('a'+i)), nil); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := f.svc.StartConversation(ada.ctx, "Question", "One more", nil); code(t, err) != http.StatusTooManyRequests {
		t.Errorf("sixth chat in a day: %v", err)
	}
	f.now = f.now.Add(25 * time.Hour)
	if _, err := f.svc.StartConversation(ada.ctx, "Question", "Tomorrow", nil); err != nil {
		t.Errorf("after the window: %v", err)
	}
}

func TestSignedFileLinks(t *testing.T) {
	f := newFixture(t)
	ada := f.person("ada")
	photo := png(3000)
	att, err := f.svc.Upload(ada.ctx, form(t, photo), "support")
	if err != nil {
		t.Fatal(err)
	}
	if att.ContentType != api.Imagepng || att.SizeBytes != len(photo) || att.FileName != "receipt.png" {
		t.Fatalf("attachment = %+v", att)
	}
	get := func(link string) *httptest.ResponseRecorder {
		u, err := url.Parse(link)
		if err != nil {
			t.Fatal(err)
		}
		rec := httptest.NewRecorder()
		f.svc.Serve(rec, httptest.NewRequestWithContext(t.Context(), http.MethodGet, link, nil), strings.TrimPrefix(u.Path, "/v1/files/"), u.Query().Get("exp"), u.Query().Get("sig"))
		return rec
	}
	rec := get(att.Url)
	if rec.Code != http.StatusOK || rec.Header().Get("Content-Type") != "image/png" || !bytes.Equal(rec.Body.Bytes(), photo) || rec.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("valid link = %d %q", rec.Code, rec.Header().Get("Content-Type"))
	}
	if rec := get(strings.Replace(att.Url, "sig=", "sig=x", 1)); rec.Code != http.StatusNotFound {
		t.Errorf("a tampered signature = %d", rec.Code)
	}
	// The expiry is part of what is signed: extending it invalidates the link.
	u, _ := url.Parse(att.Url)
	q := u.Query()
	q.Set("exp", "99999999999")
	u.RawQuery = q.Encode()
	if rec := get(u.String()); rec.Code != http.StatusNotFound {
		t.Errorf("an extended expiry = %d", rec.Code)
	}
	f.now = f.now.Add(6 * time.Minute)
	if rec := get(att.Url); rec.Code != http.StatusNotFound {
		t.Errorf("an expired link = %d", rec.Code)
	}
	// Uploads are bounded and typed by their bytes.
	if _, err := f.svc.Upload(ada.ctx, form(t, append([]byte("\xff\xd8\xff\xe0"), make([]byte, MaxFileBytes)...)), "support"); code(t, err) != http.StatusRequestEntityTooLarge {
		t.Errorf("an oversized file: %v", err)
	}
	if _, err := f.svc.Upload(ada.ctx, form(t, []byte("<html><script>alert(1)</script></html>")), "support"); code(t, err) != http.StatusUnsupportedMediaType {
		t.Errorf("an HTML file: %v", err)
	}
}
