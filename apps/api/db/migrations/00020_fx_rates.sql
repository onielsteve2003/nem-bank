-- +goose Up
-- Foreign exchange (FR-FX). Rates are stored as whole numbers of 1e-8, never as floats: the
-- contract allows eight decimal places, and an integer converts exactly.

-- Every hourly reading, kept as the rate history for the charts (FX-2). The mid rate is
-- NGN per one unit of the foreign currency; the spread is applied when it is read.
CREATE TABLE fx_rates (
  id      uuid        PRIMARY KEY,
  pair    text        NOT NULL CHECK (pair IN ('USD-NGN', 'GBP-NGN', 'EUR-NGN')),
  mid_e8  bigint      NOT NULL CHECK (mid_e8 > 0),
  source  text        NOT NULL CHECK (source IN ('open_er_api', 'frankfurter')),
  as_of   timestamptz NOT NULL,
  -- Also the index for "latest per pair" and for history ranges.
  UNIQUE (pair, as_of)
);

-- +goose Down
DROP TABLE fx_rates;
