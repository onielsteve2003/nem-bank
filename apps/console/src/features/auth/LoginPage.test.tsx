import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { createQueryClient } from '@/app/App';
import { createAppRouter } from '@/app/router';
import { RepositoryProvider, useRepositories } from '@/data/provider';

import { useSession } from './session';

function Harness({ path }: { path: string }) {
  const repositories = useRepositories();
  const [queryClient] = useState(createQueryClient);
  const [router] = useState(() =>
    createAppRouter({ queryClient, repositories }, createMemoryHistory({ initialEntries: [path] })),
  );
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}

const renderAt = (path: string) =>
  render(
    <RepositoryProvider mock={{ latencyMs: 0 }}>
      <Harness path={path} />
    </RepositoryProvider>,
  );

afterEach(() => useSession.getState().signOut());

describe('staff login', () => {
  it('sends a signed-out visitor to login, then through TOTP to the dashboard', async () => {
    const user = userEvent.setup();
    renderAt('/');

    await user.click(await screen.findByRole('button', { name: /Compliance/ }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByRole('heading', { name: 'Two-step sign in' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Use this code' }));

    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
    expect(useSession.getState().session?.staff.roles).toEqual(['compliance']);

    await user.click(screen.getByRole('link', { name: 'My access' }));
    await screen.findByRole('heading', { name: 'My access' });
    expect(screen.getByText('KYC reviews').closest('li')).toHaveAttribute('data-allowed', 'true');
    expect(screen.getByText('Feature flags').closest('li')).toHaveAttribute(
      'data-allowed',
      'false',
    );
  });

  it('shows the enrolment QR on a first login', async () => {
    const user = userEvent.setup();
    renderAt('/login');
    await user.click(await screen.findByRole('button', { name: /Support/ }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('img', { name: 'Authenticator QR code' })).toBeInTheDocument();
  });

  it('shows a wrong password without saying which part was wrong', async () => {
    const user = userEvent.setup();
    renderAt('/login');
    await user.type(await screen.findByLabelText('Work email'), 'admin@nem.bank');
    await user.type(screen.getByLabelText('Password'), 'wrong-password');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Email or password is wrong');
  });

  it('demo role switcher re-signs in as another role', async () => {
    const user = userEvent.setup();
    renderAt('/');
    await user.click(await screen.findByRole('button', { name: /Admin/ }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(await screen.findByRole('button', { name: 'Use this code' }));
    await screen.findByRole('heading', { name: 'Dashboard' });
    expect(screen.getByText('Ifeoma Adeyemi')).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText(/view the console as another role/), 'finance');
    expect(await screen.findByText('Tunde Okafor')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('heading', { name: 'Staff sign in' })).toBeInTheDocument();
  });
});
