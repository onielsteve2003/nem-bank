import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { useSession } from '@/features/auth/session';
import { renderApp } from '@/test/renderApp';

afterEach(() => useSession.getState().signOut());

describe('approvals inbox', () => {
  it('shows the diff and applies the change on approval', async () => {
    const user = userEvent.setup();
    const { state } = renderApp('/approvals', 'admin');
    await user.click(
      await screen.findByRole('link', { name: 'Change new-beneficiary cooling-off (config v7)' }),
    );
    const diff = await screen.findByRole('region', { name: 'What changes' });
    expect(within(diff).getByText('2 fields change.', { exact: false })).toBeVisible();
    expect(within(diff).getByRole('rowheader', { name: /delay minutes/ })).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Approve and apply' }));
    expect(await screen.findByText('Approved')).toBeVisible();
    expect(state.config.cooling_off.delay_minutes).toBe(60);
  });

  it('will not let the maker approve their own request', async () => {
    renderApp('/approvals/01900000-0000-7000-8000-0000000f0003', 'finance');
    expect(await screen.findByRole('note', { name: 'Maker-checker' })).toHaveTextContent(
      'You made this request',
    );
    expect(screen.queryByRole('button', { name: 'Approve and apply' })).toBeNull();
  });
});

describe('audit log', () => {
  it('verifies the chain, then finds the tampered entry', async () => {
    const user = userEvent.setup();
    renderApp('/audit', 'compliance');
    expect(await screen.findByRole('region', { name: 'Audit entries' })).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Verify chain' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Chain intact');

    await user.click(screen.getByRole('button', { name: 'Tamper with an entry' }));
    await user.click(screen.getByRole('button', { name: 'Verify chain' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Chain broken');
  });
});
