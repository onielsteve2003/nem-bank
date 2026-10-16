import { fireEvent, render, screen } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ToastProvider } from '@/components';
import { ThemeProvider } from '@/theme';

import { GALLERY_SECTIONS, KitScreen } from './KitScreen';

jest.mock('@/lib/haptics', () => ({ haptic: jest.fn() }));
jest.mock('expo-router', () => ({ useRouter: () => ({ back: jest.fn() }) }));

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const renderGallery = () =>
  render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <ThemeProvider initialPreference="dark">
        <ToastProvider>
          <KitScreen />
        </ToastProvider>
      </ThemeProvider>
    </SafeAreaProvider>,
  );

// Sheets from the bottom-sheet mock render inline with a modal flag, so the
// screen's own controls are queried with hidden elements included.
const chip = (name: string) =>
  screen.getByRole('togglebutton', { name, includeHiddenElements: true });

describe('Design system gallery', () => {
  it('lists each section once', () => {
    const keys = GALLERY_SECTIONS.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('filters to one section and shows it in both themes', async () => {
    await renderGallery();
    await fireEvent.press(chip('Foundations'));
    expect(
      screen.queryByText('Sheets, dialogs and toasts', { includeHiddenElements: true }),
    ).toBeNull();

    await fireEvent.press(chip('Both'));
    expect(screen.getByText('Dark theme', { includeHiddenElements: true })).toBeOnTheScreen();
    expect(screen.getByText('Light theme', { includeHiddenElements: true })).toBeOnTheScreen();
    expect(screen.getAllByText('Foundations', { includeHiddenElements: true })).toHaveLength(3);
  });
});
