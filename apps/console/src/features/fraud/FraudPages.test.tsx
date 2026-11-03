import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { fraudCaseId } from '@/data/mock/fraudSeed';
import { useSession } from '@/features/auth/session';
import { renderApp } from '@/test/renderApp';

afterEach(() => useSession.getState().signOut());

describe('fraud cases', () => {
  it('lists held transfers by score and filters to my cases', async () => {
    const user = userEvent.setup();
    renderApp('/fraud', 'compliance');
    const table = await screen.findByRole('region', { name: 'Cases' });
    const firstRow = within(table).getAllByRole('row')[1]!;
    expect(within(firstRow).getByText('93')).toBeInTheDocument();
    expect(within(firstRow).getByRole('link', { name: 'Emeka Nwosu' })).toBeVisible();

    await user.click(screen.getByRole('checkbox', { name: 'Only my cases' }));
    expect(await screen.findByRole('link', { name: 'Kelechi Okafor' })).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Emeka Nwosu' })).not.toBeInTheDocument();
  });

  it('takes a case, then rejects it with a fraud label', async () => {
    const user = userEvent.setup();
    renderApp(`/fraud/${fraudCaseId(1)}`, 'admin');
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent(
      '₦1,850,000.00 to Chukwudi Enterprises',
    );
    expect(screen.getByRole('meter', { name: 'Risk score 93 out of 100' })).toBeInTheDocument();
    expect(screen.getByText('Sent from a device bound less than a day ago')).toBeVisible();
    expect(screen.getByText('First transfer')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Take case' }));
    await user.click(await screen.findByRole('radio', { name: /Reject/ }));
    expect(screen.getByRole('radio', { name: 'Fraud' })).toBeChecked();
    await user.type(screen.getByLabelText(/Internal note/), 'Customer did not recognise it.');
    await user.click(screen.getByRole('button', { name: 'Reject transfer' }));

    const outcome = await screen.findByRole('status');
    expect(within(outcome).getByRole('heading', { name: 'Rejected' })).toBeVisible();
    expect(within(outcome).getByText('Fraud')).toBeVisible();
    expect(screen.getByText('Stopped after review; money returned')).toBeVisible();
  });

  it('will not release a transfer labelled fraud', async () => {
    const user = userEvent.setup();
    renderApp(`/fraud/${fraudCaseId(5)}`, 'compliance');
    await user.click(await screen.findByRole('radio', { name: 'Fraud' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/can’t be labelled fraud/);
    expect(screen.getByRole('button', { name: 'Release transfer' })).toBeDisabled();
  });

  it('shows who has a case taken by someone else', async () => {
    renderApp(`/fraud/${fraudCaseId(5)}`, 'admin');
    expect(await screen.findByRole('heading', { name: 'Aisha Bello has this case' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Take case' })).not.toBeInTheDocument();
  });
});
