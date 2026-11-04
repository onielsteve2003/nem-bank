-- +goose Up
-- Shared trigger function: every table with an updated_at column attaches it with
--   CREATE TRIGGER <table>_updated_at BEFORE UPDATE ON <table>
--     FOR EACH ROW EXECUTE FUNCTION set_updated_at();
-- +goose StatementBegin
CREATE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
-- +goose StatementEnd

-- +goose Down
DROP FUNCTION set_updated_at();
