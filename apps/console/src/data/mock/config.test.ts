import type { Schema, StaffRole } from '@nem/contracts';
import { describe, expect, it } from 'vitest';

import { isApiError } from '../errors';
import { repositoriesFromDispatcher } from '../repositories';
import { switchDemoRole } from './auth';
import { createMockDispatcher } from './index';
import { createMockState, type MockState } from './state';

function reposAs(role: StaffRole, state: MockState = createMockState()) {
  const { access_token } = switchDemoRole(state, role);
  return repositoriesFromDispatcher(
    createMockDispatcher({ latencyMs: 0, state, getAccessToken: () => access_token }),
  );
}

async function rejection(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  if (!isApiError(error)) throw new Error('expected an API error');
  return error;
}

// The contract types a section value loosely (any object or array).
const spreads = {
  'USD-NGN': 125,
  'GBP-NGN': 175,
  'EUR-NGN': 175,
} as unknown as Schema<'ConfigChangeRequest'>['value'];

describe('mock configuration', () => {
  it('serves the fees and limits the app uses', async () => {
    const config = await reposAs('finance').config.get();
    expect(config.fees.external_transfer_bands.at(-1)!.up_to).toBeNull();
    expect(config.limits.map((l) => l.tier)).toEqual([1, 2, 3]);
    expect(config.limits[2]!.max_balance).toBeNull();
  });

  it('sends a change to maker-checker without applying it, once per section', async () => {
    const state = createMockState();
    const repos = reposAs('finance', state);
    const body = {
      section: 'fx_spreads_bps' as const,
      value: spreads,
      reason: 'Match the market after the CBN window narrowed.',
      base_version: state.config.version,
    };
    const approval = await repos.config.requestChange({ body });
    expect(approval).toMatchObject({ action: 'config_change', status: 'pending' });
    expect(approval.before).toMatchObject({ value: { 'USD-NGN': 150 } });
    expect(state.config.fx_spreads_bps['USD-NGN']).toBe(150);

    expect((await rejection(repos.config.requestChange({ body }))).code).toBe('approval_pending');
  });

  it('refuses a stale or invalid change', async () => {
    const state = createMockState();
    const repos = reposAs('admin', state);
    const stale = await rejection(
      repos.config.requestChange({
        body: { section: 'fx_spreads_bps', value: spreads, reason: 'Tidy up.', base_version: 1 },
      }),
    );
    expect(stale.code).toBe('stale_config');

    const limits = structuredClone(state.config.limits);
    limits[1]!.daily_limit = limits[0]!.daily_limit;
    const flat = await rejection(
      repos.config.requestChange({
        body: {
          section: 'limits',
          value: limits,
          reason: 'Same limit for tiers 1 and 2.',
          base_version: state.config.version,
        },
      }),
    );
    expect(flat.status).toBe(422);
  });

  it('toggles a free flag but keeps a paid one off until a partner exists', async () => {
    const repos = reposAs('admin');
    const off = await repos.config.updateFlag({
      path: { flag_key: 'credit_offers' },
      body: { enabled: false, reason: 'Pausing offers during the audit.' },
    });
    expect(off).toMatchObject({ enabled: false, updated_by: { name: 'Ifeoma Adeyemi' } });

    const paid = await rejection(
      repos.config.updateFlag({
        path: { flag_key: 'real_money_mode' },
        body: { enabled: true, reason: 'Go live please.' },
      }),
    );
    expect(paid.code).toBe('partner_not_configured');
    expect((await rejection(reposAs('finance').config.listFlags())).status).toBe(403);
  });
});
