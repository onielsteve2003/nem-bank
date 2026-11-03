import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { submissionId } from '@/data/mock/kycSeed';
import { useSession } from '@/features/auth/session';
import { renderApp } from '@/test/renderApp';

afterEach(() => useSession.getState().signOut());

describe('KYC review', () => {
  it('lists waiting submissions and switches filters', async () => {
    const user = userEvent.setup();
    renderApp('/kyc', 'compliance');
    const table = await screen.findByRole('region', { name: 'Submissions' });
    expect(within(table).getAllByRole('row')).toHaveLength(7);
    expect(within(table).getAllByText('Over a day').length).toBeGreaterThan(0);

    await user.click(screen.getByRole('button', { name: 'Rejected' }));
    expect(await screen.findByRole('link', { name: 'Emeka Nwosu' })).toBeVisible();
  });

  it('views documents, then asks for one to be uploaded again', async () => {
    const user = userEvent.setup();
    renderApp(`/kyc/${submissionId(2)}`, 'compliance');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Funmilayo Adebayo' }),
    ).toBeVisible();
    expect(screen.getByRole('img', { name: /ID front/ })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /ID back/ }));
    expect(screen.getByRole('img', { name: /ID back/ })).toBeInTheDocument();
    expect(screen.getByText('⚠ Glare')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Zoom to 200%' }));
    expect(screen.getByRole('button', { name: 'Fit to frame' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await user.click(screen.getByRole('radio', { name: /Ask to resubmit/ }));
    const submit = screen.getByRole('button', { name: 'Ask to resubmit' });
    expect(submit).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: 'ID back' }));
    await user.type(
      screen.getByLabelText(/Message to the customer/),
      'The back of your ID has glare. Take it again away from the light.',
    );
    await user.click(submit);

    const decided = await screen.findByRole('status');
    expect(within(decided).getByText(/Aisha Bello decided this/)).toBeInTheDocument();
    expect(within(decided).getByText('To upload again: ID back')).toBeInTheDocument();
  });

  it('approves a Tier 2 upgrade with no documents', async () => {
    const user = userEvent.setup();
    renderApp(`/kyc/${submissionId(1)}`, 'admin');
    expect(await screen.findByText(/This upgrade needs no documents/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByRole('heading', { name: 'Approved' })).toBeVisible();
  });

  it('hides the queue from support', async () => {
    renderApp('/kyc', 'support');
    expect(await screen.findByRole('heading', { name: 'No access' })).toBeVisible();
    expect(screen.queryByRole('link', { name: 'KYC reviews' })).not.toBeInTheDocument();
  });
});
