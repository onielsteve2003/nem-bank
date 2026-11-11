-- name: InsertRate :exec
-- A reading is unique per pair and instant; a repeated insert (a retried job) is a no-op.
INSERT INTO fx_rates (id, pair, mid_e8, source, as_of)
VALUES (@id, @pair, @mid_e8, @source, @as_of)
ON CONFLICT (pair, as_of) DO NOTHING;

-- name: LatestRates :many
SELECT DISTINCT ON (pair) pair, mid_e8, source, as_of
FROM fx_rates
ORDER BY pair, as_of DESC;

-- name: LatestRate :one
SELECT pair, mid_e8, source, as_of
FROM fx_rates
WHERE pair = @pair
ORDER BY as_of DESC
LIMIT 1;

-- name: RateHistory :many
-- The last reading in each @step_seconds bucket since @since, oldest first. A bucket is
-- reported at its start, so the points sit on an even grid for the chart.
SELECT bucket::bigint AS bucket, mid_e8
FROM (
  SELECT DISTINCT ON (bucket) bucket, mid_e8
  FROM (
    SELECT (extract(epoch FROM as_of)::bigint / @step_seconds::bigint) AS bucket, mid_e8, as_of
    FROM fx_rates
    WHERE pair = @pair AND as_of >= @since
  ) readings
  ORDER BY bucket, as_of DESC
) latest
ORDER BY bucket;

-- name: PruneRates :execrows
DELETE FROM fx_rates WHERE as_of < @before;
