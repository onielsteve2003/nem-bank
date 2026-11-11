-- name: SpreadByCurrency :many
-- Completed conversions in [@from, @to), per foreign currency. The spread is what the
-- customer gave up against the mid rate the quote was made from, in kobo: selling foreign
-- the bank pays less than mid, buying it charges more. Money is integer arithmetic on
-- numeric, rounded down so income is never overstated.
SELECT
  (CASE WHEN q.sell_currency = 'NGN' THEN q.buy_currency ELSE q.sell_currency END)::text AS currency,
  count(*)::bigint AS conversions,
  COALESCE(sum(q.sell_minor) FILTER (WHERE q.sell_currency <> 'NGN'), 0)::bigint AS bought_minor,
  COALESCE(sum(q.buy_minor) FILTER (WHERE q.sell_currency = 'NGN'), 0)::bigint AS sold_minor,
  COALESCE(sum(floor(
    CASE WHEN q.sell_currency <> 'NGN'
         THEN q.sell_minor::numeric * q.mid_e8 / 100000000 - q.buy_minor
         ELSE q.sell_minor - q.buy_minor::numeric * 100000000 / q.mid_e8
    END)), 0)::bigint AS spread_minor
FROM fx_conversions c
JOIN fx_quotes q ON q.id = c.quote_id
WHERE c.status = 'completed' AND c.created_at >= @from_at AND c.created_at < @to_at
GROUP BY 1
ORDER BY 1;
