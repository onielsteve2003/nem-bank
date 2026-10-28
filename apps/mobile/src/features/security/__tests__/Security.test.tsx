import { QueryClient } from '@tanstack/react-query';
import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ModalSheetHost, ToastProvider } from '@/components';
import { RepositoryProvider, type Repositories } from '@/data';
import { createMockRepositories } from '@/data/mock';
import { createMemoryStore } from '@/data/mock/persistence/types';
import { QueryProvider } from '@/lib/query';
import { ThemeProvider } from '@/theme';

import { DevicesScreen } from '../screens/DevicesScreen';
import { SecurityScreen } from '../screens/SecurityScreen';
import { checkupAction, deviceStatus, scoreBand, splitCheckup } from '../security';

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
  useLocalSearchParams: () => ({}),
}));

configure({ defaultIncludeHiddenElements: true });

const bank = () =>
  createMockRepositories({
    store: createMemoryStore(),
    clock: () => new Date(Date.now()),
    simulation: { latency: 'off' },
  });

const wrap = (repos: Repositories, ui: React.ReactElement = <SecurityScreen />) => (
  <SafeAreaProvider
    initialMetrics={{
      frame: { x: 0, y: 0, width: 390, height: 844 },
      insets: { top: 47, left: 0, right: 0, bottom: 34 },
    }}
  >
    <RepositoryProvider repositories={repos}>
      <QueryProvider
        client={
          new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false } } })
        }
      >
        <ThemeProvider initialPreference="dark">
          <ToastProvider>
            <ModalSheetHost>{ui}</ModalSheetHost>
          </ToastProvider>
        </ThemeProvider>
      </QueryProvider>
    </RepositoryProvider>
  </SafeAreaProvider>
);

const item = (id: string, points: number, done: boolean) =>
  ({ id, title: id, description: '', points, done }) as never;

describe('security checkup rules', () => {
  it('names the score band in words', () => {
    expect(scoreBand(100).label).toBe('Strong');
    expect(scoreBand(80).label).toBe('Strong');
    expect(scoreBand(79).label).toBe('Good, could be better');
    expect(scoreBand(49).label).toBe('Needs attention');
  });

  it('puts the biggest gains first and keeps done items apart', () => {
    const { todo, done } = splitCheckup([
      item('alerts_on', 10, false),
      item('pin_set', 20, true),
      item('kyc_tier_2', 20, false),
    ]);
    expect(todo.map((i) => (i as { id: string }).id)).toEqual(['kyc_tier_2', 'alerts_on']);
    expect(done).toHaveLength(1);
  });

  it('sends each to-do to the screen that fixes it', () => {
    expect(checkupAction('kyc_tier_2')).toEqual({ kind: 'route', href: '/kyc' });
    expect(checkupAction('security_question_set')).toEqual({ kind: 'question' });
    expect(checkupAction('duress_pin_set')).toBeNull();
  });
});

describe('security center', () => {
  const fixFor = (title: string) => {
    const button = screen
      .getAllByRole('button', { name: 'Fix this' })
      .find((b) => b.props.accessibilityHint === title);
    if (!button) throw new Error(`No fix button for ${title}`);
    return button;
  };

  it('shows the score with what to do next and what is done', async () => {
    const repos = bank();
    const { score } = await repos.security.getCheckup();
    await render(wrap(repos));
    expect(
      await screen.findByLabelText(new RegExp(`^Security score ${score} out of 100\.`)),
    ).toBeTruthy();
    expect(screen.getByText('Do next')).toBeTruthy();
    expect(screen.getByText('Set a duress PIN')).toBeTruthy();
    expect(screen.getByText('Done')).toBeTruthy();
    expect(
      screen.getByLabelText(
        'Panic button. Freeze every card and stop money going out. Coming soon',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: /Devices and sessions/ })).toBeTruthy();
  });

  it('adds a security question and the score goes up', async () => {
    const repos = bank();
    const before = (await repos.security.getCheckup()).score;
    await render(wrap(repos));
    await screen.findByText('Add a security question');
    await fireEvent.press(fixFor('Add a security question'));
    await fireEvent.press(
      await screen.findByRole('button', { name: 'In which town did your parents meet?' }),
    );
    expect(screen.getByRole('button', { name: 'Save security question' })).toBeDisabled();
    await fireEvent.changeText(screen.getByLabelText('Answer'), 'Enugu');
    await fireEvent.press(screen.getByRole('button', { name: 'Save security question' }));
    await waitFor(() =>
      expect(
        screen.getByLabelText(new RegExp(`^Security score ${before + 10} out of 100\.`)),
      ).toBeTruthy(),
    );
    expect(
      (await repos.security.getCheckup()).items.find((i) => i.id === 'security_question_set')?.done,
    ).toBe(true);
  });

  it('says which fixes are still to come rather than offering a dead button', async () => {
    await render(wrap(bank()));
    await screen.findByText('Set a duress PIN');
    expect(screen.getAllByText('You can fix this soon').length).toBeGreaterThan(0);
    expect(
      screen
        .queryAllByRole('button', { name: 'Fix this' })
        .some((b) => b.props.accessibilityHint === 'Set a duress PIN'),
    ).toBe(false);
  });
});

describe('devices and sessions', () => {
  it('describes a device’s trust in words', () => {
    const base = {
      trusted: true,
      hardware_backed: true,
      cool_off_until: null,
    } as unknown as Parameters<typeof deviceStatus>[0];
    expect(deviceStatus(base).label).toBe('Trusted, key in secure hardware');
    expect(deviceStatus({ ...base, hardware_backed: false }).label).toBe('Trusted');
    expect(deviceStatus({ ...base, trusted: false }).label).toBe('Not trusted yet');
    expect(
      deviceStatus({ ...base, cool_off_until: '2026-01-02T00:00:00Z' }, new Date('2026-01-01'))
        .label,
    ).toBe('New device, lower limits for now');
  });

  it('removes another device, which ends its sign-ins and lifts the score', async () => {
    const repos = bank();
    const before = (await repos.security.getCheckup()).score;
    await render(wrap(repos, <DevicesScreen />));
    expect(await screen.findByText('This device')).toBeTruthy();
    expect(screen.getAllByText('Chrome on Windows')).toHaveLength(2);
    const remove = screen
      .getAllByRole('button', { name: 'Remove' })
      .find((b) => b.props.accessibilityHint === 'Chrome on Windows');
    await fireEvent.press(remove!);
    await fireEvent.press(await screen.findByRole('button', { name: 'Remove device' }));
    await waitFor(() => expect(screen.queryAllByText('Chrome on Windows')).toHaveLength(0));
    expect((await repos.devices.list()).data).toHaveLength(1);
    expect((await repos.security.listSessions()).data.every((s) => s.current)).toBe(true);
    expect((await repos.security.getCheckup()).score).toBe(before + 10);
  });

  it('signs out another session but keeps the device', async () => {
    const repos = bank();
    await render(wrap(repos, <DevicesScreen />));
    await fireEvent.press(await screen.findByRole('button', { name: 'Sign out' }));
    await fireEvent.press(await screen.findByRole('button', { name: 'Sign out now' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull());
    expect((await repos.security.listSessions()).data).toHaveLength(1);
    expect((await repos.devices.list()).data).toHaveLength(2);
    expect(screen.getByText('You’re here')).toBeTruthy();
  });
});
