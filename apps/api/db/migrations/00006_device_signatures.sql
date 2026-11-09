-- +goose Up
-- Replay protection for device-signed requests (T23.4). A nonce is accepted once per
-- device while its signed timestamp is inside the ±5 minute window; after that the
-- timestamp check alone refuses it, so the row can go. Each device clears its own
-- expired rows when it signs again, which keeps the table to a few minutes of traffic.
CREATE TABLE signed_request_nonces (
  device_id  uuid        NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  nonce      text        NOT NULL CHECK (length(nonce) BETWEEN 16 AND 64),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (device_id, nonce)
);

-- Biometric quick login (AUTH-5): the server picks a random nonce, the phone signs it
-- with the device key behind Face ID. One attempt per challenge, 2 minutes to answer.
CREATE TABLE device_challenges (
  id         uuid        PRIMARY KEY,
  device_id  uuid        NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  nonce      text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at    timestamptz
);
CREATE INDEX device_challenges_device ON device_challenges (device_id);

-- +goose Down
DROP TABLE device_challenges;
DROP TABLE signed_request_nonces;
