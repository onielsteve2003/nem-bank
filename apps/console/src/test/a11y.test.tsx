import type { StaffRole } from '@nem/contracts';
import { render, screen, waitFor } from '@testing-library/react';
import axe from 'axe-core';
import { QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

import { createQueryClient } from '@/app/App';
import { createMockState } from '@/data/mock/state';
import { RepositoryProvider } from '@/data/provider';
import { LoginPage } from '@/features/auth/LoginPage';

import { renderApp } from './renderApp';

// Seeds are deterministic, so a throwaway state gives the IDs the app's own state will hold.
const seed = createMockState();
const first = <T,>(map: Map<string, T>) => [...map.keys()][0]!;

const ROUTES: [path: string, role: StaffRole][] = [
  ['/', 'admin'],
  ['/customers', 'support'],
  [`/customers/${first(seed.customers)}`, 'compliance'],
  ['/kyc', 'compliance'],
  [`/kyc/${first(seed.kyc)}`, 'compliance'],
  ['/fraud', 'compliance'],
  [`/fraud/${first(seed.fraud)}`, 'compliance'],
  ['/disputes', 'compliance'],
  [`/disputes/${first(seed.disputes)}`, 'compliance'],
  ['/support', 'support'],
  ['/ledger', 'finance'],
  [`/ledger/entries/${seed.ledger.entries[0]!.id}`, 'finance'],
  ['/ledger/accounts', 'finance'],
  [`/ledger/accounts/${first(seed.ledger.accounts)}`, 'finance'],
  ['/ledger/trial-balance', 'finance'],
  ['/ledger/reconciliation', 'finance'],
  ['/config', 'admin'],
  ['/feature-flags', 'admin'],
  ['/audit', 'compliance'],
  ['/approvals', 'admin'],
  [`/approvals/${first(seed.approvals)}`, 'admin'],
  ['/simulators', 'admin'],
  ['/me', 'admin'],
  ['/developers', 'admin'],
  ['/developers/webhooks', 'admin'],
  [`/developers/webhooks/${first(seed.developer.endpoints)}`, 'admin'],
];

/**
 * WCAG 2.2 A/AA plus axe best practices. jsdom has no layout, so colour contrast is enforced on
 * the shared tokens instead (packages/shared/src/tokens/tokens.test.ts).
 */
async function violations(root: Element) {
  const result = await axe.run(root, {
    runOnly: {
      type: 'tag',
      values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'],
    },
    rules: { 'color-contrast': { enabled: false } },
  });
  return result.violations.map(
    (v) => `${v.id}: ${v.help}\n  ${v.nodes.map((n) => n.target.join(' ')).join('\n  ')}`,
  );
}

describe('console accessibility (axe)', () => {
  it('has no violations on the sign-in page', async () => {
    const { container } = render(
      <QueryClientProvider client={createQueryClient()}>
        <RepositoryProvider mock={{ latencyMs: 0, state: createMockState() }}>
          <LoginPage />
        </RepositoryProvider>
      </QueryClientProvider>,
    );
    expect(await violations(container)).toEqual([]);
  });

  it.each(ROUTES)('has no violations on %s', async (path, role) => {
    const { container } = renderApp(path, role);
    await screen.findByRole('main');
    await waitFor(() =>
      expect(container.querySelector('.skeleton, [aria-busy="true"]')).toBeNull(),
    );
    expect(await violations(container)).toEqual([]);
  });
});
