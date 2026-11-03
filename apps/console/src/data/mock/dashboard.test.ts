import { describe, expect, it } from 'vitest';

import { formatBps } from '@/features/dashboard/format';

import { isApiError } from '../errors';
import { repositoriesFromDispatcher } from '../repositories';
import { switchDemoRole } from './auth';
import { buildDashboard } from './dashboard';
import { createMockDispatcher } from './index';
import { createMockState } from './state';

describe('mock dashboard', () => {
  it('is deterministic for a period and scales with its length', () => {
    const week = buildDashboard('2026-10-28', '2026-11-03');
    expect(buildDashboard('2026-10-28', '2026-11-03')).toEqual(week);

    const quarter = buildDashboard('2026-08-06', '2026-11-03');
    const ngn = (d: typeof week) =>
      BigInt(d.volume.find((v) => v.currency === 'NGN')!.inflow.amount_minor);
    expect(ngn(quarter)).toBeGreaterThan(ngn(week) * 8n);
  });

  it('keeps money in minor-unit strings per currency and the hold rate consistent', () => {
    const d = buildDashboard('2026-10-05', '2026-11-03');
    for (const v of d.volume) {
      expect(v.inflow.amount_minor).toMatch(/^\d+$/);
      expect(v.inflow.currency).toBe(v.currency);
      expect(v.outflow.currency).toBe(v.currency);
    }
    const total = d.volume.reduce((n, v) => n + v.count, 0);
    const held = d.transfers_by_status.find((s) => s.status === 'held_for_review')!.count;
    expect(d.fraud_hold_rate_bps).toBe(Math.floor((held * 10_000) / total));
  });

  it('defaults to the last 30 days and rejects a reversed range', async () => {
    const state = createMockState(() => Date.parse('2026-11-03T10:00:00Z'));
    const { access_token } = switchDemoRole(state, 'support');
    const repos = repositoriesFromDispatcher(
      createMockDispatcher({ latencyMs: 0, state, getAccessToken: () => access_token }),
    );
    const d = await repos.dashboard.get();
    expect([d.period_from, d.period_to]).toEqual(['2026-10-05', '2026-11-03']);
    await expect(
      repos.dashboard.get({ query: { from: '2026-11-03', to: '2026-11-01' } }),
    ).rejects.toSatisfy((e) => isApiError(e, 'validation_failed'));
  });
});

describe('formatBps', () => {
  it('formats basis points exactly', () => {
    expect(formatBps(62)).toBe('0.62%');
    expect(formatBps(150)).toBe('1.50%');
    expect(formatBps(0)).toBe('0.00%');
  });
});
