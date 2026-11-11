-- +goose Up
-- KYC documents, identity checks and Tier 3 submissions (KYC-2..6).

-- What was uploaded. The photo itself is in kyc_document_blobs, encrypted, so listing
-- documents never reads image bytes.
CREATE TABLE kyc_documents (
  id             uuid        PRIMARY KEY,
  user_id        uuid        NOT NULL REFERENCES users (id),
  kind           text        NOT NULL CHECK (kind IN ('id_front', 'id_back', 'selfie', 'proof_of_address')),
  status         text        NOT NULL CHECK (status IN ('uploaded', 'accepted', 'rejected')),
  quality_issues text[]      NOT NULL DEFAULT '{}',
  content_type   text        NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'application/pdf')),
  size_bytes     integer     NOT NULL CHECK (size_bytes > 0),
  -- SHA-256 of the file: how a demo's bundled sample ID is recognised (prefill reads samples only).
  sha256         bytea       NOT NULL CHECK (length(sha256) = 32),
  sample         boolean     NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX kyc_documents_user ON kyc_documents (user_id, created_at DESC);

-- AES-256-GCM ciphertext (internal/platform/fieldcrypt) bound to the document id. This is the
-- default object store: free and on the existing database. The blob store is an interface, so an
-- S3-compatible bucket can replace it without touching the KYC flow.
CREATE TABLE kyc_document_blobs (
  document_id uuid  PRIMARY KEY REFERENCES kyc_documents (id),
  ciphertext  bytea NOT NULL
);

-- Every BVN/NIN check, so attempts can be rate limited and staff see the outcome. The number
-- itself is never here (it is field-encrypted in kyc_identifiers).
CREATE TABLE kyc_identity_checks (
  id               uuid        PRIMARY KEY,
  user_id          uuid        NOT NULL REFERENCES users (id),
  kind             text        NOT NULL CHECK (kind IN ('bvn', 'nin')),
  verified         boolean     NOT NULL,
  name_result      text        NOT NULL CHECK (name_result IN ('match', 'close_match', 'no_match')),
  name_confidence  real        NOT NULL CHECK (name_confidence BETWEEN 0 AND 1),
  dob_match        boolean,
  provider         text        NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX kyc_identity_checks_user ON kyc_identity_checks (user_id, created_at DESC);

CREATE TABLE kyc_submissions (
  id                  uuid        PRIMARY KEY,
  user_id             uuid        NOT NULL REFERENCES users (id),
  target_tier         smallint    NOT NULL CHECK (target_tier = 3),
  status              text        NOT NULL CHECK (status IN ('pending_review', 'approved', 'rejected', 'resubmit')),
  id_type             text        NOT NULL CHECK (id_type IN ('national_id', 'drivers_licence', 'international_passport', 'voters_card')),
  id_expiry_date      date,
  address             jsonb       NOT NULL CHECK (jsonb_typeof(address) = 'object'),
  document_ids        uuid[]      NOT NULL CHECK (cardinality(document_ids) BETWEEN 2 AND 6),
  submitted_at        timestamptz NOT NULL,
  reviewed_at         timestamptz,
  -- The staff member who decided. No foreign key to keep the customer domain free of the staff realm.
  reviewer_id         uuid,
  rejection_reason    text,
  resubmit_documents  text[]      NOT NULL DEFAULT '{}',
  -- A decided submission has a reviewer and a time; a pending one has neither.
  CHECK ((status = 'pending_review') = (reviewed_at IS NULL))
);
-- One submission waits for review per customer: the second submit is a 409, not a second queue entry.
CREATE UNIQUE INDEX kyc_submissions_one_pending ON kyc_submissions (user_id) WHERE status = 'pending_review';
CREATE INDEX kyc_submissions_queue ON kyc_submissions (status, submitted_at, id);
CREATE INDEX kyc_submissions_user ON kyc_submissions (user_id, submitted_at DESC);

-- +goose Down
DROP TABLE kyc_submissions;
DROP TABLE kyc_identity_checks;
DROP TABLE kyc_document_blobs;
DROP TABLE kyc_documents;
