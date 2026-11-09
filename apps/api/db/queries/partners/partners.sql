-- name: GetSimulatorSettings :one
SELECT settings FROM simulator_settings WHERE name = @name;

-- name: SetSimulatorSettings :one
UPDATE simulator_settings SET settings = @settings, updated_at = now(), updated_by = @updated_by
WHERE name = @name
RETURNING settings;

-- name: InsertSandboxPayment :one
-- A resend of a reference the sandbox already has writes nothing (no row comes back).
INSERT INTO sandbox_nip_payments (
  reference, partner_reference, bank_code, account_number, currency, amount_minor, outcome, failure_code,
  received_at, settle_at
) VALUES (
  @reference, @partner_reference, @bank_code, @account_number, @currency, @amount_minor, @outcome, @failure_code,
  @received_at, @settle_at
)
ON CONFLICT (reference) DO NOTHING
RETURNING *;

-- name: GetSandboxPayment :one
SELECT * FROM sandbox_nip_payments WHERE reference = $1;

-- name: MarkSandboxCallbackSent :exec
UPDATE sandbox_nip_payments SET callback_sent_at = now() WHERE reference = $1 AND callback_sent_at IS NULL;
