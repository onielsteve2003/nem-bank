import { describe, expect, it } from 'vitest';

import { CONSOLE_AREAS, canCall, rolesFor } from './access';
import { ForbiddenError, requireAccess } from './guards';
import { useSession } from './session';

describe('RBAC from the contract', () => {
  it('reads x-roles for staff operations', () => {
    expect(rolesFor('listFeatureFlags')).toEqual(['admin']);
    expect(rolesFor('listLedgerAccounts')).toEqual(['finance', 'admin']);
    expect(rolesFor('getAdminDashboard')).toHaveLength(4);
  });

  it('allows a page when any of the staff roles is listed', () => {
    expect(canCall(['support'], 'getAdminDashboard')).toBe(true);
    expect(canCall(['support'], 'listKycReviews')).toBe(false);
    expect(canCall(['support', 'compliance'], 'listKycReviews')).toBe(true);
  });

  it('gives admin every area and each other role only some', () => {
    const open = (role: 'admin' | 'support') =>
      CONSOLE_AREAS.filter((a) => canCall([role], a.operationId)).length;
    expect(open('admin')).toBe(CONSOLE_AREAS.length);
    expect(open('support')).toBeLessThan(CONSOLE_AREAS.length);
  });

  it('route guard throws ForbiddenError for the wrong role', () => {
    useSession.setState({
      session: {
        access_token: 't',
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        staff: {
          id: 's',
          name: 'S',
          email: 's@nem.bank',
          roles: ['finance'],
          totp_enrolled: true,
          last_login_at: null,
        },
      },
    });
    expect(() => requireAccess('listKycReviews')()).toThrow(ForbiddenError);
    expect(() => requireAccess('getTrialBalance')()).not.toThrow();
    useSession.setState({ session: null });
  });
});
