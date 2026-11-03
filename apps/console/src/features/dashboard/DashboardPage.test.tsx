import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { createQueryClient } from '@/app/App';
import { switchDemoRole } from '@/data/mock/auth';
import { createMockState } from '@/data/mock/state';
import { RepositoryProvider } from '@/data/provider';
import { useSession } from '@/features/auth/session';

import { DashboardPage } from './DashboardPage';

function renderDashboard() {
  const state = createMockState();
  useSession.getState().signIn(switchDemoRole(state, 'finance'));
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <RepositoryProvider mock={{ latencyMs: 0, state }}>
        <DashboardPage />
      </RepositoryProvider>
    </QueryClientProvider>,
  );
}

describe('DashboardPage', () => {
  it('shows KPIs, queues, volume per currency and transfers by status', async () => {
    renderDashboard();
    expect(await screen.findByText('Customers')).toBeInTheDocument();
    expect(screen.getByText('184,230')).toBeInTheDocument();
    expect(screen.getByText('Fraud hold rate')).toBeInTheDocument();
    expect(screen.getByText('KYC to review')).toBeInTheDocument();

    const volume = screen.getByRole('region', { name: 'Volume by currency' });
    for (const code of ['NGN', 'USD', 'GBP', 'EUR']) {
      expect(within(volume).getByLabelText(new RegExp(`^${code} in: `))).toBeInTheDocument();
    }
    expect(within(volume).getAllByText(/^₦[\d,]+$/).length).toBeGreaterThan(0);

    const byStatus = screen.getByRole('region', { name: 'Transfers by status' });
    expect(within(byStatus).getByText(/completed \(/)).toBeInTheDocument();
    expect(within(byStatus).getByLabelText(/^Held for review: /)).toBeInTheDocument();
    useSession.getState().signOut();
  });

  it('switches the chart to a table and changes the period', async () => {
    const user = userEvent.setup();
    renderDashboard();
    await screen.findByText('Customers');

    await user.click(screen.getByRole('button', { name: 'Show table' }));
    const table = screen.getByRole('table');
    expect(within(table).getByRole('cell', { name: 'Completed' })).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Period'), '7');
    expect(await screen.findByText(/^\d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}/)).toBeInTheDocument();
    useSession.getState().signOut();
  });
});
