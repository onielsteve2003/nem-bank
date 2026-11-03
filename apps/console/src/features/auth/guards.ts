import type { RouteOperationId } from '@nem/contracts';
import { redirect } from '@tanstack/react-router';

import { canCall } from './access';
import { isActive, useSession } from './session';

/** Thrown by a route guard; the staff layout shows "no access" for it. */
export class ForbiddenError extends Error {
  readonly operationId: RouteOperationId;

  constructor(operationId: RouteOperationId) {
    super(`Your role cannot open this page (${operationId}).`);
    this.name = 'ForbiddenError';
    this.operationId = operationId;
  }
}

/** Staff layout guard: no active session → login, then back here. */
export function requireSession({ location }: { location: { href: string } }): void {
  if (!isActive(useSession.getState().session)) {
    useSession.getState().signOut();
    throw redirect({ to: '/login', search: { redirect: location.href } });
  }
}

/** Page guard: the staff member's roles must allow the page's main call. */
export function requireAccess(operationId: RouteOperationId) {
  return (): void => {
    const roles = useSession.getState().session?.staff.roles ?? [];
    if (!canCall(roles, operationId)) throw new ForbiddenError(operationId);
  };
}
