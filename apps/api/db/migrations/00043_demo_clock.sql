-- +goose Up
-- Demo time travel (DEMO-1, T31.5e). How many days a demo customer has moved their own clock
-- forward. Real time is untouched: the offset is added only where the demo asks for the date.
ALTER TABLE users
  ADD COLUMN demo_offset_days integer NOT NULL DEFAULT 0 CHECK (demo_offset_days BETWEEN 0 AND 365),
  ADD CONSTRAINT users_demo_clock_only_for_demo CHECK (is_demo OR demo_offset_days = 0);

-- +goose Down
ALTER TABLE users
  DROP CONSTRAINT users_demo_clock_only_for_demo,
  DROP COLUMN demo_offset_days;
