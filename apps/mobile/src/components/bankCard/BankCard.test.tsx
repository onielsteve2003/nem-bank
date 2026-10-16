import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Accelerometer } from 'expo-sensors';
import { useReducedMotion } from 'react-native-reanimated';

import { ThemeProvider } from '@/theme';

import { BankCard, groupPan } from './BankCard';
import { followBaseline, MAX_TILT_DEG, tiltFromGravity } from './useDeviceTilt';

jest.mock('@/lib/haptics', () => ({ haptic: jest.fn() }));
jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  ...jest.requireActual('react-native-reanimated'),
  useReducedMotion: jest.fn(() => false),
}));
jest.mock('expo-sensors', () => ({
  Accelerometer: {
    isAvailableAsync: jest.fn(async () => true),
    setUpdateInterval: jest.fn(),
    addListener: jest.fn(() => ({ remove: jest.fn() })),
  },
}));

const renderThemed = (ui: React.ReactElement) =>
  render(<ThemeProvider initialPreference="light">{ui}</ThemeProvider>);

const CARD = { holder: 'Ada Lovelace', last4: '4821', expiry: '09/29', network: 'visa' } as const;

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(useReducedMotion).mockReturnValue(false);
});

describe('tilt maths', () => {
  it('is flat at the resting pose and clamps big swings', () => {
    expect(tiltFromGravity({ x: 0.1, y: -0.7 }, { x: 0.1, y: -0.7 })).toEqual({
      rotateX: 0,
      rotateY: 0,
    });
    expect(tiltFromGravity({ x: 0.25, y: 0 }, { x: 0, y: 0 }).rotateY).toBe(MAX_TILT_DEG / 2);
    expect(tiltFromGravity({ x: 0, y: -2 }, { x: 0, y: 0 }).rotateX).toBe(-MAX_TILT_DEG);
  });

  it('lets the resting pose drift towards how the phone is held', () => {
    const next = followBaseline({ x: 0, y: 0 }, { x: 1, y: -1 });
    expect(next.x).toBeGreaterThan(0);
    expect(next.x).toBeLessThan(0.1);
    expect(next.y).toBeLessThan(0);
  });

  it('groups a card number in fours', () => {
    expect(groupPan('5399123412344821')).toBe('5399 1234 1234 4821');
  });
});

describe('BankCard', () => {
  it('describes the card and flips on tap', async () => {
    const onFlip = jest.fn();
    await renderThemed(<BankCard {...CARD} onFlip={onFlip} />);
    const card = screen.getByRole('button', {
      name: 'Virtual Visa card ending 4821, Ada Lovelace, expires 09/29',
    });
    expect(card).not.toBeExpanded();
    await fireEvent.press(card);
    expect(onFlip).toHaveBeenCalledWith(true);
    expect(card).toBeExpanded();
  });

  it('announces a frozen card', async () => {
    await renderThemed(<BankCard {...CARD} kind="physical" frozen />);
    expect(screen.getByRole('button', { name: /Physical Visa .*, frozen$/ })).toBeOnTheScreen();
  });

  it('masks the back until details are revealed', async () => {
    const { rerender } = await renderThemed(<BankCard {...CARD} flipped />);
    expect(screen.getByText('•••', { includeHiddenElements: true })).toBeOnTheScreen();
    await rerender(
      <ThemeProvider initialPreference="light">
        <BankCard {...CARD} flipped revealed={{ number: '4111222233334821', cvv: '123' }} />
      </ThemeProvider>,
    );
    expect(
      screen.getByText('4111 2222 3333 4821', { includeHiddenElements: true }),
    ).toBeOnTheScreen();
  });

  it('listens to motion only when tilt is allowed', async () => {
    await renderThemed(<BankCard {...CARD} />);
    await act(async () => undefined);
    expect(Accelerometer.addListener).toHaveBeenCalledTimes(1);
  });

  it('never tilts with reduce motion or tilt off', async () => {
    jest.mocked(useReducedMotion).mockReturnValue(true);
    await renderThemed(<BankCard {...CARD} />);
    jest.mocked(useReducedMotion).mockReturnValue(false);
    await renderThemed(<BankCard {...CARD} tilt={false} />);
    await act(async () => undefined);
    expect(Accelerometer.isAvailableAsync).not.toHaveBeenCalled();
  });
});
