import { QueryClient } from '@tanstack/react-query';
import { act, configure, fireEvent, render, screen } from '@testing-library/react-native';
import * as ImagePicker from 'expo-image-picker';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ModalSheetHost, ToastProvider } from '@/components';
import { RepositoryProvider, type Repositories } from '@/data';
import { createMockRepositories } from '@/data/mock';
import { createMemoryStore } from '@/data/mock/persistence/types';
import { QueryProvider } from '@/lib/query';
import { ThemeProvider } from '@/theme';

import { AVATAR_MAX_LENGTH, nemtagLockedUntil, nemtagRuleText, pickProfilePhoto } from '../profile';
import { NemtagChangeScreen } from '../screens/NemtagChangeScreen';
import { ProfileScreen } from '../screens/ProfileScreen';

const mockBack = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: mockBack }),
}));

jest.mock('expo-image-picker', () => ({
  CameraType: { front: 'front' },
  requestCameraPermissionsAsync: jest.fn(),
  launchCameraAsync: jest.fn(),
  launchImageLibraryAsync: jest.fn(),
}));
const picker = jest.mocked(ImagePicker);

configure({ defaultIncludeHiddenElements: true });

/** The demo clock; tests move it to pass the 30-day @nemtag wait. */
let clockOffset = 0;
beforeEach(() => {
  clockOffset = 0;
  jest.clearAllMocks();
});

const bank = () =>
  createMockRepositories({
    store: createMemoryStore(),
    clock: () => new Date(Date.now() + clockOffset),
    simulation: { latency: 'off' },
  });

const wrap = (repos: Repositories, ui: React.ReactElement) => (
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

const PHOTO = 'data:image/jpeg;base64,/9j/AAAA';
const user = (extra = {}) => ({ nemtag: 'tolu', ...extra }) as never;

describe('profile rules', () => {
  const now = new Date('2026-10-28T10:00:00Z');

  it('lets a @nemtag change when there is no wait, or the wait is over', () => {
    expect(nemtagLockedUntil(user(), now)).toBeNull();
    expect(
      nemtagLockedUntil(user({ nemtag_changeable_at: '2026-10-01T00:00:00Z' }), now),
    ).toBeNull();
    expect(nemtagRuleText(user(), now)).toBe('You can change it once every 30 days');
  });

  it('says when a recently changed @nemtag can change again', () => {
    const waiting = user({ nemtag_changeable_at: '2026-11-27T10:00:00Z' });
    expect(nemtagLockedUntil(waiting, now)).toEqual(new Date('2026-11-27T10:00:00Z'));
    expect(nemtagRuleText(waiting, now)).toBe('You can change it again on 27 Nov 2026');
  });

  it('turns a picked photo into a data URI, and refuses one too large to keep', async () => {
    picker.launchImageLibraryAsync.mockResolvedValueOnce({
      canceled: false,
      assets: [{ base64: '/9j/AAAA', mimeType: 'image/jpeg' }],
    } as never);
    expect(await pickProfilePhoto('library')).toEqual({ kind: 'photo', uri: PHOTO });

    picker.launchImageLibraryAsync.mockResolvedValueOnce({
      canceled: false,
      assets: [{ base64: 'A'.repeat(AVATAR_MAX_LENGTH), mimeType: 'image/png' }],
    } as never);
    expect(await pickProfilePhoto('library')).toEqual({ kind: 'too_large' });

    picker.launchImageLibraryAsync.mockResolvedValueOnce({ canceled: true, assets: null });
    expect(await pickProfilePhoto('library')).toEqual({ kind: 'cancelled' });
  });

  it('asks for the camera, and stops when it is refused', async () => {
    picker.requestCameraPermissionsAsync.mockResolvedValueOnce({ granted: false } as never);
    expect(await pickProfilePhoto('camera')).toEqual({ kind: 'denied' });
    expect(picker.launchCameraAsync).not.toHaveBeenCalled();
  });
});

describe('mock profile rules', () => {
  it('keeps JPEG or PNG photos only, and removes them', async () => {
    const repos = bank();
    await expect(
      repos.users.updateMe({ body: { avatar_url: 'https://example.com/me.jpg' } }),
    ).rejects.toMatchObject({ problem: { code: 'validation_failed' } });
    expect((await repos.users.updateMe({ body: { avatar_url: PHOTO } })).avatar_url).toBe(PHOTO);
    expect((await repos.users.updateMe({ body: { avatar_url: null } })).avatar_url).toBeNull();
  });

  it('changes a @nemtag once every 30 days and holds the old one for you', async () => {
    const repos = bank();
    const old = (await repos.users.getMe()).nemtag!;
    const changed = await repos.users.setNemtag({ body: { nemtag: 'tolu_new' } });
    expect(changed.nemtag).toBe('tolu_new');
    expect(changed.nemtag_changeable_at).toBeTruthy();
    await expect(repos.users.setNemtag({ body: { nemtag: 'tolu_again' } })).rejects.toMatchObject({
      problem: { code: 'nemtag_cooldown' },
    });

    clockOffset = 31 * 24 * 60 * 60 * 1000;
    // The old tag is still held, and still yours to take back.
    expect((await repos.users.setNemtag({ body: { nemtag: old } })).nemtag).toBe(old);
  });
});

describe('ProfileScreen', () => {
  it('saves a preferred name', async () => {
    const repos = bank();
    await render(wrap(repos, <ProfileScreen />));
    const field = await screen.findByLabelText('Preferred name');
    expect(screen.getByRole('button', { name: 'Save name' })).toBeDisabled();
    await fireEvent.changeText(field, 'Tee');
    await fireEvent.press(screen.getByRole('button', { name: 'Save name' }));
    expect(await screen.findByText('Name saved')).toBeOnTheScreen();
    expect((await repos.users.getMe()).preferred_name).toBe('Tee');
  });

  it('adds and removes a photo from the library', async () => {
    const repos = bank();
    picker.launchImageLibraryAsync.mockResolvedValueOnce({
      canceled: false,
      assets: [{ base64: '/9j/AAAA', mimeType: 'image/jpeg' }],
    } as never);
    await render(wrap(repos, <ProfileScreen />));
    await fireEvent.press(await screen.findByRole('button', { name: 'Choose a photo' }));
    expect(await screen.findByText('Photo updated')).toBeOnTheScreen();
    expect((await repos.users.getMe()).avatar_url).toBe(PHOTO);
    await fireEvent.press(await screen.findByRole('button', { name: 'Remove photo' }));
    expect(await screen.findByText('Photo removed')).toBeOnTheScreen();
  });

  it('explains a refused camera and offers Settings', async () => {
    picker.requestCameraPermissionsAsync.mockResolvedValueOnce({ granted: false } as never);
    await render(wrap(bank(), <ProfileScreen />));
    await fireEvent.press(await screen.findByRole('button', { name: 'Take a photo' }));
    expect(await screen.findByText(/needs the camera/)).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Open Settings' })).toBeOnTheScreen();
  });

  it('shows the details only identity verification can change', async () => {
    await render(wrap(bank(), <ProfileScreen />));
    expect(await screen.findByText('Legal name')).toBeOnTheScreen();
    expect(screen.getByText(/change only through identity verification/)).toBeOnTheScreen();
    expect(screen.getByText('You can change it once every 30 days')).toBeOnTheScreen();
  });
});

describe('NemtagChangeScreen', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('checks a new @nemtag, confirms the rules and changes it', async () => {
    const repos = bank();
    const me = await repos.users.getMe();
    await render(wrap(repos, <NemtagChangeScreen />));
    const field = await screen.findByLabelText('New @nemtag');

    await fireEvent.changeText(field, me.nemtag!);
    expect(screen.getByText(`@${me.nemtag} is your @nemtag now`)).toBeOnTheScreen();

    await fireEvent.changeText(field, 'tolu_new');
    await act(() => jest.advanceTimersByTimeAsync(500));
    expect(await screen.findByText('@tolu_new is yours if you want it')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Change to @tolu_new' }));
    expect(
      await screen.findByText(/won’t be able to change it again for 30 days/),
    ).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Change' }));
    await act(() => jest.advanceTimersByTimeAsync(50));
    expect((await repos.users.getMe()).nemtag).toBe('tolu_new');
    expect(mockBack).toHaveBeenCalled();
  });

  it('waits 30 days after a change', async () => {
    const repos = bank();
    await repos.users.setNemtag({ body: { nemtag: 'tolu_new' } });
    await render(wrap(repos, <NemtagChangeScreen />));
    expect(await screen.findByText('@tolu_new is yours for now')).toBeOnTheScreen();
    expect(screen.getByText(/You can change it again on/)).toBeOnTheScreen();
  });
});
