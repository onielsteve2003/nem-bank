-- name: UserCreatedAt :one
SELECT created_at FROM users WHERE id = @id;

-- name: RecurringCandidates :many
-- Card and bill payments in the categories where subscriptions live: the only rows
-- recurrence detection looks at.
SELECT id, currency, amount_minor, created_at, card_id, COALESCE(counterparty->>'name', '')::text AS merchant
FROM transactions
WHERE user_id = @user_id AND status = 'completed' AND direction = 'debit'
  AND type IN ('card_payment', 'bill_payment')
  AND category IN ('subscriptions', 'bills_utilities', 'airtime_data', 'entertainment')
  AND created_at >= @since
ORDER BY created_at;

-- name: SpendingSince :many
-- Naira that left for everyday costs. Savings, FX and loan movements are the customer
-- moving their own money around, not spending.
SELECT id, amount_minor, created_at
FROM transactions
WHERE user_id = @user_id AND status = 'completed' AND direction = 'debit' AND currency = 'NGN'
  AND type IN ('transfer_out', 'card_payment', 'bill_payment', 'fee', 'levy')
  AND created_at >= @since
ORDER BY created_at;

-- name: SalaryCredits :many
SELECT amount_minor, created_at
FROM transactions
WHERE user_id = @user_id AND status = 'completed' AND direction = 'credit' AND currency = 'NGN'
  AND category = 'salary_income' AND created_at >= @since
ORDER BY created_at;
