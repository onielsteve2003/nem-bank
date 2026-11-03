import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { useSession } from '@/features/auth/session';
import { renderApp } from '@/test/renderApp';

afterEach(() => useSession.getState().signOut());

describe('ledger', () => {
  it('opens a journal entry and shows it balances', async () => {
    const user = userEvent.setup();
    renderApp('/ledger?kind=fx_conversion', 'finance');
    const table = await screen.findByRole('region', { name: 'Journal entries' });
    await user.click(within(table).getAllByRole('link')[0]!);

    expect(await screen.findByRole('heading', { name: 'Postings' })).toBeVisible();
    // An FX conversion touches two currencies; each balances on its own.
    expect(screen.getByRole('rowheader', { name: /NGN total/ })).toHaveTextContent('Balanced');
    expect(screen.getByRole('rowheader', { name: /USD total/ })).toHaveTextContent('Balanced');
    expect(await screen.findByRole('link', { name: 'FX position (USD)' })).toBeVisible();
  });

  it('shows the trial balance netting to zero', async () => {
    renderApp('/ledger/trial-balance', 'finance');
    expect(await screen.findByRole('heading', { name: 'The ledger balances' })).toBeVisible();
    const ngn = screen.getByRole('region', { name: 'NGN' });
    expect(within(ngn).getByText('Sums to zero')).toBeVisible();
    expect(within(ngn).getByText('₦0.00')).toBeVisible();
  });

  it('lists reconciliation breaks for yesterday', async () => {
    renderApp('/ledger/reconciliation', 'admin');
    const breaks = await screen.findByRole('region', { name: 'Breaks' });
    expect(within(breaks).getAllByText('Missing at partner').length).toBeGreaterThan(0);
  });

  it('filters accounts to the bank’s own', async () => {
    const user = userEvent.setup();
    renderApp('/ledger/accounts', 'finance');
    await screen.findByRole('region', { name: 'Ledger accounts' });
    await user.click(screen.getByRole('button', { name: 'Bank' }));
    expect(await screen.findByRole('link', { name: 'Fee income (NGN)' })).toBeVisible();
    expect(screen.queryByRole('link', { name: /Adaeze Okonkwo/ })).not.toBeInTheDocument();
  });
});
