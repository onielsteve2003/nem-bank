package kyc

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/audit"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/limits"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/testdb"
)

type rules struct{}

func (rules) Rules() limits.Rules { return limits.DefaultRules() }

func jpeg(n int) []byte { return append([]byte{0xFF, 0xD8, 0xFF, 0xE0}, make([]byte, n)...) }

func upload(t *testing.T, kind string, file []byte) *multipart.Reader {
	t.Helper()
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	if kind != "" {
		if err := w.WriteField("kind", kind); err != nil {
			t.Fatal(err)
		}
	}
	if file != nil {
		fw, err := w.CreateFormFile("file", "photo")
		if err != nil {
			t.Fatal(err)
		}
		_, _ = fw.Write(file)
	}
	_ = w.Close()
	return multipart.NewReader(&buf, w.Boundary())
}

type fixture struct {
	t    *testing.T
	pool *pgxpool.Pool
	svc  *Service
	now  time.Time
}

func newFixture(t *testing.T, sampleHashes ...string) *fixture {
	t.Helper()
	pool := testdb.New(t)
	f := &fixture{t: t, pool: pool, now: time.Date(2026, 11, 11, 10, 0, 0, 0, time.UTC)}
	svc, err := NewService(Config{
		Pool: pool, Identifiers: NewIdentifiers(keyring(t, 1)), Keyring: keyring(t, 1), Limits: rules{},
		SampleHashes: sampleHashes, Logger: slog.New(slog.NewTextHandler(io.Discard, nil)), Now: func() time.Time { return f.now },
	})
	if err != nil {
		t.Fatal(err)
	}
	f.svc = svc
	return f
}

func as(id uuid.UUID) identity.Principal {
	return identity.Principal{UserID: id, SessionID: uuid.New(), DeviceID: uuid.New()}
}

func (f *fixture) ctx(id uuid.UUID) context.Context {
	return identity.WithPrincipal(f.t.Context(), as(id))
}

func (f *fixture) outbox(topic string) int {
	f.t.Helper()
	var n int
	if err := f.pool.QueryRow(f.t.Context(), `SELECT count(*) FROM outbox_events WHERE topic = $1`, topic).Scan(&n); err != nil {
		f.t.Fatal(err)
	}
	return n
}

func problemStatus(t *testing.T, err error) int {
	t.Helper()
	var pe *problem.Error
	if !errors.As(err, &pe) {
		t.Fatalf("want a problem, got %v", err)
	}
	return pe.Status
}

func TestIdentityChecksUpgradeToTier2(t *testing.T) {
	f := newFixture(t)
	ada, other := customer(t, f.pool, 1), customer(t, f.pool, 2)
	ctx := f.ctx(ada)

	o, err := f.svc.Overview(ctx)
	if err != nil || o.Tier != 1 || len(o.Tiers) != 3 || !o.Tiers[0].Current || o.Tiers[2].MaxBalance != nil {
		t.Fatalf("overview = %+v, %v", o, err)
	}

	// No record for all zeros; a wrong date of birth fails even with a real number.
	v, err := f.svc.VerifyIdentity(ctx, BVN, "00000000000", nil)
	if err != nil || v.Verified || v.NameMatch.Result != api.NoMatch || !v.Sandbox {
		t.Fatalf("zeros = %+v, %v", v, err)
	}
	wrong := time.Date(1990, 1, 1, 0, 0, 0, 0, time.UTC)
	v, err = f.svc.VerifyIdentity(ctx, BVN, "22212345678", &wrong)
	if err != nil || v.Verified || v.DateOfBirthMatch == nil || *v.DateOfBirthMatch || v.Tier != 1 {
		t.Fatalf("wrong dob = %+v, %v", v, err)
	}
	if _, err := f.svc.VerifyIdentity(ctx, BVN, "123", nil); problemStatus(t, err) != http.StatusBadRequest {
		t.Errorf("a short number should be a validation error, got %v", err)
	}

	right := time.Date(1996, 4, 12, 0, 0, 0, 0, time.UTC)
	v, err = f.svc.VerifyIdentity(ctx, BVN, "22212345678", &right)
	if err != nil || !v.Verified || v.Tier != 2 || v.NameMatch.Result != api.Match {
		t.Fatalf("verified = %+v, %v", v, err)
	}
	if last4, err := f.svc.ids.Last4(t.Context(), f.pool, ada, BVN); err != nil || last4 != "5678" {
		t.Errorf("stored last4 = %q, %v", last4, err)
	}
	if f.outbox("kyc.updated") != 1 {
		t.Errorf("the Tier 2 upgrade should publish one kyc.updated event")
	}

	// Another customer cannot claim the same BVN, and the attempt is recorded.
	_, err = f.svc.VerifyIdentity(f.ctx(other), BVN, "22212345678", nil)
	if !errors.Is(err, ErrIdentifierInUse) {
		t.Fatalf("second owner of a BVN: %v", err)
	}
	var failed int
	if err := f.pool.QueryRow(t.Context(), `SELECT count(*) FROM kyc_identity_checks WHERE user_id = $1 AND NOT verified`, other).Scan(&failed); err != nil || failed != 1 {
		t.Errorf("failed attempts recorded for the other customer = %d, %v", failed, err)
	}
}

func TestFailedChecksAreRateLimited(t *testing.T) {
	f := newFixture(t)
	ctx := f.ctx(customer(t, f.pool, 1))
	for range identityAttemptsPerHour {
		if v, err := f.svc.VerifyIdentity(ctx, NIN, "00000000000", nil); err != nil || v.Verified {
			t.Fatalf("attempt: %+v, %v", v, err)
		}
	}
	_, err := f.svc.VerifyIdentity(ctx, NIN, "22212345678", nil)
	if problemStatus(t, err) != http.StatusTooManyRequests {
		t.Fatalf("sixth attempt in an hour: %v", err)
	}
	f.now = f.now.Add(61 * time.Minute)
	if v, err := f.svc.VerifyIdentity(ctx, NIN, "22212345678", nil); err != nil || !v.Verified {
		t.Fatalf("after the window: %+v, %v", v, err)
	}
}

func TestDocumentUploadChecksTheBytesAndStoresThemEncrypted(t *testing.T) {
	photo := jpeg(3000)
	sum := sha256.Sum256(photo)
	f := newFixture(t, hex.EncodeToString(sum[:]))
	ada, other := customer(t, f.pool, 1), customer(t, f.pool, 2)
	ctx := f.ctx(ada)

	d, err := f.svc.Upload(ctx, upload(t, "id_front", photo))
	if err != nil || d.Status != api.KycDocumentStatusUploaded || d.QualityIssues != nil {
		t.Fatalf("upload = %+v, %v", d, err)
	}
	var stored []byte
	var sample bool
	if err := f.pool.QueryRow(t.Context(), `SELECT b.ciphertext, d.sample FROM kyc_document_blobs b JOIN kyc_documents d ON d.id = b.document_id WHERE d.id = $1`, d.Id).Scan(&stored, &sample); err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(stored, photo[:1000]) {
		t.Error("the photo is stored in plain text")
	}
	if !sample {
		t.Error("an upload matching a configured sample hash should be flagged as a sample")
	}
	got, err := f.svc.Document(t.Context(), ada, d.Id)
	if err != nil || !bytes.Equal(got.Data, photo) || got.ContentType != "image/jpeg" || !got.Sample {
		t.Fatalf("read back: %v", err)
	}
	if _, err := f.svc.Document(t.Context(), other, d.Id); !errors.Is(err, ErrDocumentNotFound) {
		t.Errorf("another customer read this photo: %v", err)
	}

	// A different photo is not a sample, even for the same kind.
	if d2, err := f.svc.Upload(ctx, upload(t, "id_front", jpeg(3500))); err != nil || d2.Status != api.KycDocumentStatusUploaded {
		t.Fatal(err)
	} else if doc, _ := f.svc.Document(t.Context(), ada, d2.Id); doc.Sample {
		t.Error("an unknown photo was flagged as a sample")
	}

	// Tiny photos fail the quality check; a selfie reports a missing face.
	if d, err := f.svc.Upload(ctx, upload(t, "selfie", jpeg(100))); err != nil || d.Status != api.KycDocumentStatusRejected || (*d.QualityIssues)[0] != api.KycDocumentQualityIssuesFaceNotFound {
		t.Errorf("tiny selfie = %+v, %v", d, err)
	}
	for name, c := range map[string]struct {
		kind string
		file []byte
		want int
	}{
		"text file":       {"id_front", bytes.Repeat([]byte("hello "), 500), http.StatusUnsupportedMediaType},
		"too large":       {"id_front", jpeg(MaxDocumentBytes), http.StatusRequestEntityTooLarge},
		"pdf as id":       {"id_front", append([]byte("%PDF-1.7\n"), make([]byte, 3000)...), http.StatusBadRequest},
		"unknown kind":    {"passport", photo, http.StatusBadRequest},
		"no file":         {"selfie", nil, http.StatusBadRequest},
		"no kind at all":  {"", photo, http.StatusBadRequest},
		"empty file body": {"selfie", []byte{}, http.StatusBadRequest},
	} {
		if _, err := f.svc.Upload(ctx, upload(t, c.kind, c.file)); problemStatus(t, err) != c.want {
			t.Errorf("%s: got %v, want status %d", name, err, c.want)
		}
	}
	if d, err := f.svc.Upload(ctx, upload(t, "proof_of_address", append([]byte("%PDF-1.7\n"), make([]byte, 3000)...))); err != nil || d.Status != api.KycDocumentStatusUploaded {
		t.Errorf("a PDF proof of address should be accepted: %+v, %v", d, err)
	}
}

func (f *fixture) tier2(id uuid.UUID, bvn string) {
	f.t.Helper()
	if _, err := f.svc.VerifyIdentity(f.ctx(id), BVN, bvn, nil); err != nil {
		f.t.Fatal(err)
	}
}

func (f *fixture) docs(id uuid.UUID, kinds ...string) []uuid.UUID {
	f.t.Helper()
	var out []uuid.UUID
	for _, k := range kinds {
		d, err := f.svc.Upload(f.ctx(id), upload(f.t, k, jpeg(3000)))
		if err != nil {
			f.t.Fatal(err)
		}
		out = append(out, d.Id)
	}
	return out
}

func request(docs []uuid.UUID) SubmitRequest {
	return SubmitRequest{IDType: "national_id", IDNumber: "12345678901", DocumentIDs: docs, Address: api.Address{Line1: "1 Marina", City: "Lagos", State: "Lagos", Country: "NG"}}
}

func TestSubmissionAndReviewWorkflow(t *testing.T) {
	f := newFixture(t)
	ada, other := customer(t, f.pool, 1), customer(t, f.pool, 2)
	ctx := f.ctx(ada)
	staff := audit.Actor{Type: audit.ActorStaff, ID: new(string)}
	reviewer := uuid.New()

	// Tier 3 needs Tier 2 first.
	if _, err := f.svc.Submit(ctx, request(f.docs(ada, "id_front", "selfie"))); problemStatus(t, err) != http.StatusForbidden {
		t.Fatalf("submit at Tier 1: %v", err)
	}
	f.tier2(ada, "22212345678")

	// An ID photo and a selfie are both required, they must be accepted by the quality check,
	// and they must be the customer's own.
	if _, err := f.svc.Submit(ctx, request(f.docs(ada, "id_front", "proof_of_address"))); problemStatus(t, err) != http.StatusBadRequest {
		t.Errorf("no selfie: %v", err)
	}
	tiny, _ := f.svc.Upload(ctx, upload(t, "selfie", jpeg(50)))
	good := f.docs(ada, "id_front")
	if _, err := f.svc.Submit(ctx, request(append(good, tiny.Id))); problemStatus(t, err) != http.StatusBadRequest {
		t.Errorf("a rejected selfie should not count: %v", err)
	}
	theirs := f.docs(other, "selfie")
	if _, err := f.svc.Submit(ctx, request(append(good, theirs...))); problemStatus(t, err) != http.StatusBadRequest {
		t.Errorf("someone else's document: %v", err)
	}
	bad := request(append(good, f.docs(ada, "selfie")...))
	past := f.now.AddDate(0, 0, -1)
	bad.IDExpiry = &past
	if _, err := f.svc.Submit(ctx, bad); problemStatus(t, err) != http.StatusBadRequest {
		t.Errorf("expired ID: %v", err)
	}

	docs := append(good, f.docs(ada, "selfie")...)
	sub, err := f.svc.Submit(ctx, request(docs))
	if err != nil || sub.Status != api.KycSubmissionStatusPendingReview || sub.TargetTier != 3 {
		t.Fatalf("submit = %+v, %v", sub, err)
	}
	if _, err := f.svc.Submit(ctx, request(docs)); problemStatus(t, err) != http.StatusConflict {
		t.Errorf("second submission while pending: %v", err)
	}
	if o, _ := f.svc.Overview(ctx); o.Status != api.KycStatus("pending_review") || o.LatestSubmission == nil || o.LatestSubmission.Id != sub.Id {
		t.Errorf("overview while pending = %+v", o)
	}
	if _, err := f.svc.Submission(f.ctx(other), sub.Id); problemStatus(t, err) != http.StatusNotFound {
		t.Errorf("another customer read the submission: %v", err)
	}

	// The queue shows it; the review loads without opening a photo.
	q, page, err := f.svc.Queue(t.Context(), "pending_review", nil, nil)
	if err != nil || len(q) != 1 || page.NextCursor != nil || q[0].Customer.Name != "Tolu Adeyemi" {
		t.Fatalf("queue = %+v, %v", q, err)
	}
	rev, err := f.svc.GetReview(t.Context(), sub.Id)
	if err != nil || len(rev.Documents) != 2 || rev.IDLast4 != "8901" || len(rev.Checks) == 0 {
		t.Fatalf("review = %+v, %v", rev, err)
	}
	if _, err := f.svc.OpenDocument(t.Context(), staff, sub.Id, rev.Documents[0].ID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.OpenDocument(t.Context(), staff, sub.Id, uuid.New()); !errors.Is(err, ErrDocumentNotFound) {
		t.Errorf("a document outside the submission: %v", err)
	}

	// Rulings need a reason, and resubmit needs to name the photos.
	d := Decision{SubmissionID: sub.Id, Outcome: "reject", Reviewer: staff, ReviewerID: reviewer}
	if _, err := f.svc.Decide(t.Context(), d); problemStatus(t, err) != http.StatusBadRequest {
		t.Errorf("reject without a reason: %v", err)
	}
	d.Outcome, d.Reason = "resubmit", "Your selfie was too dark."
	if _, err := f.svc.Decide(t.Context(), d); problemStatus(t, err) != http.StatusBadRequest {
		t.Errorf("resubmit without documents: %v", err)
	}
	d.ResubmitDocuments = []string{"selfie"}
	r, err := f.svc.Decide(t.Context(), d)
	if err != nil || r.Status != "resubmit" || len(r.ResubmitDocuments) != 1 {
		t.Fatalf("resubmit = %+v, %v", r, err)
	}
	if _, err := f.svc.Decide(t.Context(), d); !errors.Is(err, ErrNotPending) {
		t.Errorf("deciding twice: %v", err)
	}

	// The customer can submit again, and an approval makes them Tier 3.
	sub2, err := f.svc.Submit(ctx, request(append(good, f.docs(ada, "selfie")...)))
	if err != nil {
		t.Fatalf("resubmit: %v", err)
	}
	d = Decision{SubmissionID: sub2.Id, Outcome: "approve", Reviewer: staff, ReviewerID: reviewer}
	if _, err := f.svc.Decide(t.Context(), d); err != nil {
		t.Fatal(err)
	}
	o, _ := f.svc.Overview(ctx)
	if o.Tier != 3 || o.Status != api.KycStatus("approved") || !o.Tiers[2].Current {
		t.Errorf("after approval: %+v", o)
	}
	if _, err := f.svc.Submit(ctx, request(docs)); problemStatus(t, err) != http.StatusConflict {
		t.Errorf("submit at Tier 3: %v", err)
	}
	// Tier 2 upgrade, submit, resubmit request, submit, approve: five events.
	if n := f.outbox("kyc.updated"); n != 5 {
		t.Errorf("kyc.updated events = %d, want 5", n)
	}
	var views int
	if err := f.pool.QueryRow(t.Context(), `SELECT count(*) FROM audit_log WHERE action = 'kyc.document_view'`).Scan(&views); err != nil || views != 1 {
		t.Errorf("document views audited = %d, %v (a failed open must not be audited)", views, err)
	}

	// A rejection leaves the tier alone and gives the customer the reason.
	f.tier2(other, "33312345678")
	s3, err := f.svc.Submit(f.ctx(other), request(f.docs(other, "id_front", "selfie")))
	if err != nil {
		t.Fatal(err)
	}
	r, err = f.svc.Decide(t.Context(), Decision{SubmissionID: s3.Id, Outcome: "reject", Reason: "The name does not match.", Reviewer: staff, ReviewerID: reviewer})
	if err != nil || r.Status != "rejected" || r.RejectionReason == nil {
		t.Fatalf("reject = %+v, %v", r, err)
	}
	if o, _ := f.svc.Overview(f.ctx(other)); o.Tier != 2 || o.Status != api.KycStatus("rejected") {
		t.Errorf("after rejection: %+v", o)
	}
}
