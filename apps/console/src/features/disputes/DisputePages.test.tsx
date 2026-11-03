import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { disputeId } from '@/data/mock/disputeSeed';
import { conversationId } from '@/data/mock/supportSeed';
import { useSession } from '@/features/auth/session';
import { renderApp } from '@/test/renderApp';

afterEach(() => useSession.getState().signOut());

describe('disputes', () => {
  it('lists open disputes and opens one', async () => {
    const user = userEvent.setup();
    renderApp('/disputes', 'compliance');
    const table = await screen.findByRole('region', { name: 'Disputes' });
    await user.click(within(table).getByRole('link', { name: 'DSP-20261005' }));
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent(
      'DSP-20261005 · Not made by the customer',
    );
    expect(screen.getByRole('img', { name: 'Evidence: location-history.png' })).toBeVisible();
  });

  it('refunds part of a dispute', async () => {
    const user = userEvent.setup();
    renderApp(`/disputes/${disputeId(1)}`, 'compliance');
    const amount = await screen.findByLabelText(/Refund amount/);
    expect(amount).toHaveValue('45,000.00');
    await user.clear(amount);
    await user.type(amount, '50000');
    expect(screen.getByText('At most ₦45,000.00.')).toBeVisible();
    await user.clear(amount);
    await user.type(amount, '20000');
    await user.type(screen.getByLabelText('Note to the customer'), 'Refunding the second charge.');
    await user.click(screen.getByRole('button', { name: 'Refund' }));

    const outcome = await screen.findByRole('status');
    expect(within(outcome).getByRole('heading', { name: 'Refunded' })).toBeVisible();
    expect(within(outcome).getByText('₦20,000.00')).toBeVisible();
  });

  it('shows a large refund waiting for a second approver', async () => {
    const user = userEvent.setup();
    renderApp(`/disputes/${disputeId(5)}`, 'admin');
    await user.type(
      await screen.findByLabelText('Note to the customer'),
      'Card was used in Abuja while you were in Lagos.',
    );
    await user.click(screen.getByRole('button', { name: 'Refund' }));
    expect(
      await screen.findByRole('heading', { name: 'Waiting for a second approver' }),
    ).toBeVisible();
  });

  it('lets support read but not decide', async () => {
    renderApp(`/disputes/${disputeId(1)}`, 'support');
    expect(await screen.findByRole('heading', { name: 'Compliance decides this' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Refund' })).not.toBeInTheDocument();
  });
});

describe('support chat', () => {
  it('replies to a waiting customer with a saved reply and resolves the chat', async () => {
    const user = userEvent.setup();
    renderApp(`/support?status=active&mine=false&c=${conversationId(1)}`, 'support');
    const chats = await screen.findByRole('navigation', { name: 'Chats' });
    expect(within(chats).getAllByRole('link')[0]).toHaveTextContent('Emeka Nwosu');
    expect(await screen.findByText(/the person is waiting/)).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Held transfer' }));
    expect((screen.getByRole('textbox', { name: 'Reply' }) as HTMLTextAreaElement).value).toMatch(
      /held to protect you/,
    );
    await user.click(screen.getByRole('button', { name: 'Send' }));
    const messages = screen.getByRole('list', { name: 'Messages' });
    expect(await within(messages).findByText(/held to protect you/)).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Mark resolved' }));
    expect(
      await screen.findByText('Chidi marked this chat resolved.', { exact: false }),
    ).toBeVisible();
    expect(screen.queryByRole('textbox', { name: 'Reply' })).not.toBeInTheDocument();
  });
});
