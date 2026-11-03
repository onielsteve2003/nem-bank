import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { useSession } from '@/features/auth/session';
import { renderApp } from '@/test/renderApp';

afterEach(() => useSession.getState().signOut());

describe('simulators', () => {
  it('charges a test card, then captures the hold', async () => {
    const user = userEvent.setup();
    renderApp('/simulators', 'admin');
    const merchant = await screen.findByRole('region', { name: 'Merchant Simulator' });
    await user.type(within(merchant).getByLabelText('Amount (NGN)'), '12,500');
    await user.click(within(merchant).getByRole('button', { name: 'Charge card' }));
    expect(await within(merchant).findByRole('status')).toHaveTextContent('Approved');

    await user.click(within(merchant).getByRole('button', { name: 'Capture Shoprite Lekki' }));
    expect(await within(merchant).findByText('settled')).toBeVisible();
  });

  it('shows the decline reason', async () => {
    const user = userEvent.setup();
    renderApp('/simulators', 'admin');
    const merchant = await screen.findByRole('region', { name: 'Merchant Simulator' });
    const cards = within(merchant).getByLabelText('Test card');
    await user.selectOptions(cards, within(cards).getByRole('option', { name: /frozen/ }));
    await user.type(within(merchant).getByLabelText('Amount (NGN)'), '500');
    await user.click(within(merchant).getByRole('button', { name: 'Charge card' }));
    expect(await within(merchant).findByRole('status')).toHaveTextContent(
      'The card or the customer is frozen',
    );
  });

  it('checks the bank partner delays before saving', async () => {
    const user = userEvent.setup();
    renderApp('/simulators', 'admin');
    const partner = await screen.findByRole('region', { name: 'Bank Partner Simulator' });
    const longest = await within(partner).findByLabelText(/Longest delay/);
    await user.clear(longest);
    await user.type(longest, '0');
    expect(within(partner).getByText('At least the shortest delay.')).toBeVisible();
    await user.clear(longest);
    await user.type(longest, '20');
    await user.click(within(partner).getByRole('button', { name: 'Save settings' }));
    expect(await within(partner).findByRole('status')).toHaveTextContent('Saved');
  });

  it('is only for admins', async () => {
    renderApp('/simulators', 'finance');
    expect(await screen.findByRole('heading', { name: 'No access' })).toBeVisible();
  });
});
