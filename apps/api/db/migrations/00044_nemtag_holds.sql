-- +goose Up
-- A customer who changes their @nemtag keeps the old one reserved for 30 days, so nobody else can
-- take it while people still send money to it (AUTH-10, the contract's setNemtag). The holder can
-- take it back; anyone else is told it is taken. Expired rows are ignored and replaced on the next
-- change, so nothing has to sweep this table.
CREATE TABLE nemtag_holds (
  nemtag  text        PRIMARY KEY CHECK (nemtag ~ '^[a-z][a-z0-9_]{2,19}$'),
  user_id uuid        NOT NULL REFERENCES users (id),
  until   timestamptz NOT NULL
);
CREATE INDEX nemtag_holds_user_idx ON nemtag_holds (user_id);

-- +goose Down
DROP TABLE nemtag_holds;
