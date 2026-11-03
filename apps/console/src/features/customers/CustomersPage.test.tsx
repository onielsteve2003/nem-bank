import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { useSession } from '@/features/auth/session';
import { renderApp } from '@/test/renderApp';

afterEach(() => useSession.getState().signOut());

describe('customers', () => {
  it('searches and opens the 360 view', async () => {
    const user = userEvent.setup();
    renderApp('/customers', 'support');
    await user.type(await screen.findByRole('searchbox'), 'emeka');
    await user.click(screen.getByRole('button', { name: 'Search' }));

    await user.click(await screen.findByRole('link', { name: 'Emeka Nwosu' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Emeka Nwosu' })).toBeVisible();
    expect(screen.getByText('Fraud watch')).toBeInTheDocument();
    expect(screen.getByText('Hidden for your role')).toBeInTheDocument();
    expect(screen.getByText(/Only Compliance and Admin/)).toBeInTheDocument();
    const accounts = screen.getByRole('region', { name: 'Accounts' });
    expect(within(accounts).getAllByText('₦412,300.00')).toHaveLength(2);
  });

  it('shows an empty state when nothing matches', async () => {
    renderApp('/customers?q=nobody', 'support');
    expect(await screen.findByText('No customers match “nobody”')).toBeInTheDocument();
  });

  it('freezes with a reason, then sends an unfreeze for approval', async () => {
    const user = userEvent.setup();
    renderApp('/customers/01900000-0000-7000-8000-0000000c0003', 'compliance');
    await user.click(await screen.findByRole('button', { name: 'Freeze account' }));
    const submit = screen.getByRole('button', { name: 'Freeze account' });
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText(/Reason/), 'Account takeover reported by phone');
    await user.click(submit);

    expect(await screen.findByRole('button', { name: 'Request unfreeze' })).toBeVisible();
    expect(screen.getAllByText('Frozen').length).toBeGreaterThan(0);
    expect(screen.getByText(/Froze the account: Account takeover/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Request unfreeze' }));
    await user.type(screen.getByLabelText(/Reason/), 'Identity confirmed on a call');
    await user.click(screen.getByRole('button', { name: 'Send for approval' }));
    expect(await screen.findByText('Unfreeze sent for approval')).toBeVisible();
  });

  it('adds a staff note', async () => {
    const user = userEvent.setup();
    renderApp('/customers/01900000-0000-7000-8000-0000000c0002', 'support');
    await user.type(await screen.findByLabelText(/Add a note/), 'Asked for a callback at 3pm.');
    await user.click(screen.getByRole('button', { name: 'Add note' }));
    expect(await screen.findByText('Asked for a callback at 3pm.')).toBeInTheDocument();
    expect(screen.getByLabelText(/Add a note/)).toHaveValue('');
  });
});
