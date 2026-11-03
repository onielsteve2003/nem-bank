import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { DEMO_DEVELOPER_PIN } from '@/data/mock/developer';
import { useSession } from '@/features/auth/session';
import { renderApp } from '@/test/renderApp';

afterEach(() => useSession.getState().signOut());

describe('developer portal', () => {
  it('creates a key after the PIN and shows its secret once', async () => {
    const user = userEvent.setup();
    renderApp('/developers');
    await screen.findByRole('region', { name: 'Keys' });
    await user.type(screen.getByLabelText('Name'), 'Checkout');
    await user.type(screen.getByLabelText('Your PIN'), '1111');
    await user.click(screen.getByRole('button', { name: 'Create key' }));
    expect(screen.getByText('That PIN is not right.')).toBeVisible();

    await user.clear(screen.getByLabelText('Your PIN'));
    await user.type(screen.getByLabelText('Your PIN'), DEMO_DEVELOPER_PIN);
    await user.click(screen.getByRole('button', { name: 'Create key' }));
    const secret = await screen.findByRole('alert', { name: 'Your new API key' });
    expect(within(secret).getByLabelText('Secret')).toHaveTextContent(/^nem_test_/);

    await user.click(within(secret).getByRole('button', { name: "I've saved it" }));
    expect(screen.queryByRole('alert', { name: 'Your new API key' })).toBeNull();
    expect(await screen.findByText('Checkout')).toBeVisible();
  });

  it('revokes a key after confirming', async () => {
    const user = userEvent.setup();
    renderApp('/developers');
    await user.click(await screen.findByRole('button', { name: 'Revoke Store backend' }));
    await user.click(screen.getByRole('button', { name: 'Yes, revoke' }));
    expect(await screen.findAllByText(/^Revoked/)).toHaveLength(2);
  });

  it('shows the delivery log and replays a delivery', async () => {
    const user = userEvent.setup();
    renderApp('/developers/webhooks');
    await user.click(
      await screen.findByRole('link', { name: 'https://dayo-store.example.com/webhooks/nem' }),
    );
    const log = await screen.findByRole('region', { name: 'Deliveries' });
    const before = (await within(log).findAllByRole('button', { name: /^Replay/ })).length;
    await user.click(within(log).getAllByRole('button', { name: /^Replay/ })[0]!);
    expect(await within(log).findAllByRole('button', { name: /^Replay/ })).toHaveLength(before + 1);

    await user.click(screen.getByRole('button', { name: 'Send test event' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Test event sent: delivered');
  });
});
