-- name: LockPanicAt :one
SELECT panic_at FROM users WHERE id = @id FOR UPDATE;

-- name: GetPanicAt :one
SELECT panic_at FROM users WHERE id = @id;

-- name: SetPanicAt :exec
UPDATE users SET panic_at = @panic_at WHERE id = @id;

-- A card that is already frozen (by the customer) is left alone, so releasing panic mode
-- does not unfreeze what the customer froze themselves.
-- name: FreezeCardsForPanic :execrows
UPDATE cards SET status = 'frozen', frozen_by_panic = true
WHERE user_id = @user_id AND status = 'active';

-- name: ReleasePanicCards :exec
UPDATE cards SET status = 'active', frozen_by_panic = false
WHERE user_id = @user_id AND frozen_by_panic AND status = 'frozen';

-- name: CountPanicCards :one
SELECT count(*) FROM cards WHERE user_id = @user_id AND frozen_by_panic AND status = 'frozen';
