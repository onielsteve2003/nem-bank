import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { useSession } from '@/features/auth/session';
import { renderApp } from '@/test/renderApp';

afterEach(() => useSession.getState().signOut());

describe('configuration', () => {
  it('proposes a new FX spread for approval', async () => {
    const user = userEvent.setup();
    renderApp('/config', 'finance');
    const spreads = await screen.findByRole('region', { name: 'FX spreads' });
    expect(within(spreads).getByText('150 bps (1.50%)')).toBeVisible();

    await user.click(within(spreads).getByRole('button', { name: 'Propose change' }));
    const usd = within(spreads).getByLabelText('USD → NGN');
    await user.clear(usd);
    await user.type(usd, '125');
    expect(within(spreads).getByText(/1 value changed/)).toBeVisible();
    await user.type(within(spreads).getByLabelText(/Reason/), 'Narrower market spread.');
    await user.click(within(spreads).getByRole('button', { name: 'Send for approval' }));

    expect(await within(spreads).findByRole('status')).toHaveTextContent(
      'Waiting for a second approver',
    );
  });

  it('flags a value it cannot use', async () => {
    const user = userEvent.setup();
    renderApp('/config', 'admin');
    const device = await screen.findByRole('region', { name: 'New-device cool-off' });
    await user.click(within(device).getByRole('button', { name: 'Propose change' }));
    const hours = within(device).getByLabelText(/Lasts/);
    await user.clear(hours);
    await user.type(hours, '500');
    expect(within(device).getByText('A whole number from 0 to 168.')).toBeVisible();
    expect(within(device).getByRole('button', { name: 'Send for approval' })).toBeDisabled();
  });
});

describe('feature flags', () => {
  it('turns a flag off with a reason', async () => {
    const user = userEvent.setup();
    renderApp('/feature-flags', 'admin');
    const toggle = await screen.findByRole('switch', { name: 'Credit offers' });
    expect(toggle).toBeChecked();
    await user.click(toggle);
    await user.type(screen.getByLabelText(/Reason/), 'Pausing offers during the audit.');
    await user.click(screen.getByRole('button', { name: 'Turn off' }));
    expect(await screen.findByRole('switch', { name: 'Credit offers' })).not.toBeChecked();
  });

  it('explains why a paid feature stays off', async () => {
    const user = userEvent.setup();
    renderApp('/feature-flags', 'admin');
    await user.click(await screen.findByRole('switch', { name: 'Real money mode' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Real money mode needs a paid partner');
  });
});
