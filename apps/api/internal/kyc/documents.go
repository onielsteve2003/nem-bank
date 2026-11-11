package kyc

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"slices"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/kyc/kycdb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
)

const (
	// MaxDocumentBytes is the contract's 5 MB limit.
	MaxDocumentBytes = 5 << 20
	// minPhotoBytes: smaller than this cannot be a usable photo. There is no image analysis
	// here; a size check stands in for the bank's quality check so the retake path exists.
	minPhotoBytes = 2_000
)

var (
	errTooLarge    = problem.New(http.StatusRequestEntityTooLarge, "payload_too_large", "That file is too large").WithDetail("Send a JPEG, PNG or PDF of at most 5 MB.")
	errBadType     = problem.New(http.StatusUnsupportedMediaType, "unsupported_media_type", "That file type is not accepted").WithDetail("Send a JPEG, PNG or PDF.")
	errPDFOnlyAddr = problem.Validation(problem.Field("/file", "invalid", "Only a proof of address can be a PDF. Send a photo of your ID and your selfie."))
	errNoFile      = problem.Validation(problem.Field("/file", "required", "Choose a photo first."))
	errNoKind      = problem.Validation(problem.Field("/kind", "required", "Say which document this is."))
)

// BlobStore keeps document bytes. The bytes it receives are already encrypted. The default
// stores them in Postgres (free, and in the customer's own transaction); an S3-compatible
// bucket can replace it without changing the KYC flow.
type BlobStore interface {
	Put(ctx context.Context, db kycdb.DBTX, documentID uuid.UUID, ciphertext []byte) error
	Get(ctx context.Context, db kycdb.DBTX, documentID uuid.UUID) ([]byte, error)
}

// PostgresBlobs is the default BlobStore.
type PostgresBlobs struct{}

// Put implements BlobStore.
func (PostgresBlobs) Put(ctx context.Context, db kycdb.DBTX, id uuid.UUID, ciphertext []byte) error {
	return kycdb.New(db).InsertDocumentBlob(ctx, kycdb.InsertDocumentBlobParams{DocumentID: id, Ciphertext: ciphertext})
}

// Get implements BlobStore.
func (PostgresBlobs) Get(ctx context.Context, db kycdb.DBTX, id uuid.UUID) ([]byte, error) {
	b, err := kycdb.New(db).GetDocumentBlob(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrDocumentNotFound
	}
	return b, err
}

// documentAAD binds a photo's ciphertext to its document, so it cannot be swapped between rows.
func documentAAD(id uuid.UUID) []byte { return []byte("kyc_documents:" + id.String()) }

// Upload reads one multipart upload ("kind" and "file" parts), checks it and stores it
// encrypted (KYC-3). The body is read to at most 5 MB.
func (s *Service) Upload(ctx context.Context, form *multipart.Reader) (api.KycDocument, error) {
	p, err := principal(ctx)
	if err != nil {
		return api.KycDocument{}, err
	}
	if form == nil {
		return api.KycDocument{}, errNoFile
	}
	var kind string
	var data []byte
	for range 8 { // a bounded number of parts: this form has two
		part, err := form.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return api.KycDocument{}, problem.Validation(problem.Field("/", "malformed", "The upload could not be read."))
		}
		switch part.FormName() {
		case "kind":
			b, _ := io.ReadAll(io.LimitReader(part, 64))
			kind = string(b)
		case "file":
			data, err = io.ReadAll(io.LimitReader(part, MaxDocumentBytes+1))
			if err != nil {
				return api.KycDocument{}, problem.Validation(problem.Field("/file", "malformed", "The file could not be read."))
			}
			if len(data) > MaxDocumentBytes {
				return api.KycDocument{}, errTooLarge
			}
		}
		_ = part.Close()
	}
	if !slices.Contains([]string{"id_front", "id_back", "selfie", "proof_of_address"}, kind) {
		return api.KycDocument{}, errNoKind
	}
	if len(data) == 0 {
		return api.KycDocument{}, errNoFile
	}
	// The type comes from the bytes, never from the name or the header the client sent.
	contentType := http.DetectContentType(data)
	if !slices.Contains([]string{"image/jpeg", "image/png", "application/pdf"}, contentType) {
		return api.KycDocument{}, errBadType
	}
	if contentType == "application/pdf" && kind != "proof_of_address" {
		return api.KycDocument{}, errPDFOnlyAddr
	}

	now := s.now().UTC()
	recent, err := s.q.CountUploadsSince(ctx, kycdb.CountUploadsSinceParams{UserID: p.UserID, Since: now.Add(-time.Hour)})
	if err != nil {
		return api.KycDocument{}, fmt.Errorf("count uploads: %w", err)
	}
	if recent >= uploadsPerHour {
		return api.KycDocument{}, problem.RateLimited(now.Add(time.Hour))
	}

	id, err := uuid.NewV7()
	if err != nil {
		return api.KycDocument{}, fmt.Errorf("document id: %w", err)
	}
	sum := sha256.Sum256(data)
	status, issues := "uploaded", []string{}
	if len(data) < minPhotoBytes && contentType != "application/pdf" {
		status = "rejected"
		issues = []string{"blurry"}
		if kind == "selfie" {
			issues = []string{"face_not_found"}
		}
	}
	ct, err := s.keys.Encrypt(data, documentAAD(id))
	if err != nil {
		return api.KycDocument{}, fmt.Errorf("encrypt document: %w", err)
	}
	row := kycdb.InsertDocumentParams{
		ID: id, UserID: p.UserID, Kind: kind, Status: status, QualityIssues: issues, ContentType: contentType, SizeBytes: int32(len(data)), //nolint:gosec // at most 5 MB
		Sha256: sum[:], Sample: kind == "id_front" && s.samples[hex.EncodeToString(sum[:])], CreatedAt: now,
	}
	err = s.inTx(ctx, func(tx pgx.Tx, q *kycdb.Queries) error {
		if err := q.InsertDocument(ctx, row); err != nil {
			return fmt.Errorf("insert document: %w", err)
		}
		return s.blobs.Put(ctx, tx, id, ct)
	})
	if err != nil {
		return api.KycDocument{}, err
	}
	return documentJSON(row), nil
}

func documentJSON(r kycdb.InsertDocumentParams) api.KycDocument {
	out := api.KycDocument{Id: r.ID, Kind: api.KycDocumentKind(r.Kind), Status: api.KycDocumentStatus(r.Status), UploadedAt: r.CreatedAt.UTC()}
	if len(r.QualityIssues) > 0 {
		issues := make([]api.KycDocumentQualityIssues, len(r.QualityIssues))
		for i, q := range r.QualityIssues {
			issues[i] = api.KycDocumentQualityIssues(q)
		}
		out.QualityIssues = &issues
	}
	return out
}

// Document returns the customer's own uploaded photo, decrypted. It is how ID prefill reads a
// photo (see Documents), and it is scoped to the owner.
func (s *Service) Document(ctx context.Context, userID, id uuid.UUID) (Document, error) {
	row, err := s.q.GetDocument(ctx, kycdb.GetDocumentParams{ID: id, UserID: userID})
	if errors.Is(err, pgx.ErrNoRows) {
		return Document{}, ErrDocumentNotFound
	}
	if err != nil {
		return Document{}, fmt.Errorf("load document: %w", err)
	}
	return s.open(ctx, row)
}

func (s *Service) open(ctx context.Context, row kycdb.KycDocument) (Document, error) {
	ct, err := s.blobs.Get(ctx, s.pool, row.ID)
	if err != nil {
		return Document{}, err
	}
	plain, err := s.keys.Decrypt(ct, documentAAD(row.ID))
	if err != nil {
		return Document{}, fmt.Errorf("decrypt document: %w", err)
	}
	return Document{ID: row.ID, ContentType: row.ContentType, Data: plain, Sample: row.Sample}, nil
}

var _ Documents = (*Service)(nil)
