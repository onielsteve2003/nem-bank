-- Ledger invariants after a load or crash test. Every query must return zero rows (the last
-- one prints the totals). Run: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f loadtest/verify.sql

\echo 'entries that do not net to zero per currency (want 0 rows)'
SELECT entry_id, currency, sum(amount_minor) AS net
FROM postings GROUP BY entry_id, currency HAVING sum(amount_minor) <> 0;

\echo 'accounts whose cached balance differs from their postings (want 0 rows)'
SELECT a.id, a.balance_minor, COALESCE(p.s, 0) AS from_postings
FROM ledger_accounts a
LEFT JOIN (SELECT account_id, sum(amount_minor) AS s FROM postings GROUP BY account_id) p ON p.account_id = a.id
WHERE a.balance_minor <> COALESCE(p.s, 0);

\echo 'customer deposits below zero (want 0 rows)'
SELECT id, balance_minor, available_minor FROM ledger_accounts
WHERE kind IN ('customer_current', 'customer_wallet', 'customer_savings', 'customer_locked')
  AND (balance_minor < 0 OR available_minor < 0);

\echo 'money created or destroyed: sum of every balance per currency (want 0 per row)'
SELECT currency, sum(balance_minor) AS total FROM ledger_accounts GROUP BY currency HAVING sum(balance_minor) <> 0;

\echo 'transfers stuck in a non-final state older than 5 minutes (want 0 rows)'
SELECT id, status, created_at FROM transfers
WHERE status IN ('created', 'risk_checked', 'processing') AND created_at < now() - interval '5 minutes';

\echo 'totals'
SELECT (SELECT count(*) FROM journal_entries) AS entries, (SELECT count(*) FROM postings) AS postings,
       (SELECT count(*) FROM transfers WHERE status = 'completed') AS completed_transfers;
