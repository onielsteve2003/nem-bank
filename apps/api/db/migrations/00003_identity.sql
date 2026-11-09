-- +goose Up
-- Customers (AUTH-1). Email is stored lowercased and phone in E.164, so the unique indexes
-- catch "Tolu@x.com" vs "tolu@x.com" without citext.
CREATE TABLE users (
  id                  uuid        PRIMARY KEY,           -- UUIDv7
  first_name          text        NOT NULL CHECK (length(first_name) BETWEEN 1 AND 50),
  last_name           text        NOT NULL CHECK (length(last_name) BETWEEN 1 AND 50),
  preferred_name      text,
  email               text        NOT NULL CHECK (email = lower(email)),
  phone               text        NOT NULL CHECK (phone ~ '^\+234[789][01][0-9]{8}$'),
  date_of_birth       date        NOT NULL,
  nemtag              text        CHECK (nemtag ~ '^[a-z][a-z0-9_]{2,19}$'),
  nemtag_changed_at   timestamptz,
  password_hash       text        NOT NULL,              -- argon2id PHC string
  kyc_tier            smallint    NOT NULL DEFAULT 1 CHECK (kyc_tier BETWEEN 1 AND 3),
  kyc_status          text        NOT NULL DEFAULT 'not_started'
                      CHECK (kyc_status IN ('not_started', 'pending_review', 'approved', 'rejected', 'resubmit')),
  is_demo             boolean     NOT NULL DEFAULT false,
  -- NDPA 2023: which terms and privacy notice the customer accepted, and when.
  terms_version       text        NOT NULL,
  privacy_version     text        NOT NULL,
  consent_accepted_at timestamptz NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_key ON users (email);
CREATE UNIQUE INDEX users_phone_key ON users (phone);
CREATE UNIQUE INDEX users_nemtag_key ON users (nemtag) WHERE nemtag IS NOT NULL;
CREATE TRIGGER users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A sign-up in progress: details are held here, not in users, until the email is verified
-- and a password is set, so an unverified address never becomes an account.
CREATE TABLE signups (
  id                  uuid        PRIMARY KEY,
  first_name          text        NOT NULL,
  last_name           text        NOT NULL,
  email               text        NOT NULL CHECK (email = lower(email)),
  phone               text        NOT NULL,
  date_of_birth       date        NOT NULL,
  terms_version       text        NOT NULL,
  privacy_version     text        NOT NULL,
  consent_accepted_at timestamptz NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,
  completed_at        timestamptz,
  user_id             uuid        REFERENCES users (id)
);

-- Email one-time codes (AUTH-2) for sign-up, password reset and step-up. Codes are kept
-- only as an HMAC under a server key: 10^6 codes are trivial to brute force from a plain
-- hash, so a database leak alone must not reveal live codes.
CREATE TABLE otp_challenges (
  id                  uuid        PRIMARY KEY,
  purpose             text        NOT NULL CHECK (purpose IN ('signup', 'password_reset', 'step_up')),
  subject_id          uuid        NOT NULL,              -- signups.id or users.id, by purpose
  destination         text        NOT NULL,              -- lowercased email
  code_hash           bytea       NOT NULL,
  attempts_left       smallint    NOT NULL CHECK (attempts_left BETWEEN 0 AND 5),
  sends               smallint    NOT NULL DEFAULT 1 CHECK (sends >= 1),
  expires_at          timestamptz NOT NULL,
  resend_available_at timestamptz NOT NULL,
  verified_at         timestamptz,
  -- Issued once the code is right; the follow-up call (finish sign-up, reset password)
  -- presents it. Stored as SHA-256: it is 256 random bits, so no key is needed.
  token_hash          bytea       UNIQUE,
  token_expires_at    timestamptz,
  consumed_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);
-- The per-address send limit counts recent challenges for one destination.
CREATE INDEX otp_challenges_destination ON otp_challenges (destination, created_at);

-- +goose Down
DROP TABLE otp_challenges;
DROP TABLE signups;
DROP TABLE users;
