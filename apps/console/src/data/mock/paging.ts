import type { Schema, Staff } from '@nem/contracts';

import { problem } from '../errors';

const DEFAULT_LIMIT = 20;

/**
 * Cursor pagination over an already-sorted list. The cursor is an opaque offset here;
 * the API's is an encoded keyset, but pages only ever pass it back unchanged.
 */
export function paginate<T>(
  items: readonly T[],
  cursor: string | undefined,
  limit = DEFAULT_LIMIT,
): { data: T[]; page: Schema<'PageInfo'> } {
  const start = cursor ? Number.parseInt(cursor, 10) : 0;
  if (!Number.isInteger(start) || start < 0) {
    throw problem(400, 'invalid_cursor', 'That page link is no longer valid');
  }
  const end = start + limit;
  return {
    data: items.slice(start, end),
    page: { next_cursor: end < items.length ? String(end) : null },
  };
}

/** The handlers run after the dispatcher's auth check, so a staff member is always there. */
export function staffRef(staff: Staff | null): Schema<'StaffRef'> {
  if (!staff) throw problem(401, 'unauthorized', 'Sign in again');
  return { id: staff.id, name: staff.name };
}

export function requireReason(reason: string | undefined, field = '/reason'): string {
  const trimmed = reason?.trim() ?? '';
  if (trimmed.length < 5 || trimmed.length > 500) {
    throw problem(422, 'validation_failed', 'Give a reason of 5 to 500 characters', {
      errors: [{ field, code: 'length', message: 'Use 5 to 500 characters.' }],
    });
  }
  return trimmed;
}
