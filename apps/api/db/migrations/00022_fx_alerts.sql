-- +goose Up
-- Rate alerts (FX-2): "tell me when USD/NGN goes above X". An alert is checked against the
-- mid rate after every hourly reading and fires once.
CREATE TABLE fx_alerts (
  id                uuid        PRIMARY KEY,
  user_id           uuid        NOT NULL REFERENCES users (id),
  pair              text        NOT NULL CHECK (pair IN ('USD-NGN', 'GBP-NGN', 'EUR-NGN')),
  direction         text        NOT NULL CHECK (direction IN ('above', 'below')),
  target_e8         bigint      NOT NULL CHECK (target_e8 > 0),
  status            text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'triggered')),
  created_at        timestamptz NOT NULL,
  triggered_at      timestamptz,
  triggered_rate_e8 bigint,
  CHECK ((status = 'triggered') = (triggered_at IS NOT NULL))
);
-- The hourly check reads only the alerts still waiting, by pair.
CREATE INDEX fx_alerts_active ON fx_alerts (pair) WHERE status = 'active';
CREATE INDEX fx_alerts_user ON fx_alerts (user_id, created_at DESC);

-- +goose Down
DROP TABLE fx_alerts;
