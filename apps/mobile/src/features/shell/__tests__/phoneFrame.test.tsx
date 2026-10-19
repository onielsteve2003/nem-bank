import { render, screen } from '@testing-library/react-native';
import { useContext } from 'react';

import { Text } from '@/components';
import { FrameRectContext } from '@/components/modalFrame';
import { ThemeProvider } from '@/theme';

import { frameLayout, PHONE_SCREEN } from '../frameLayout';
import { PhoneFrameLayout } from '../PhoneFrame.web';

jest.mock('@/lib/camera', () => ({ getCameraSupport: () => Promise.resolve('none') }));

describe('frameLayout', () => {
  it('fills phones, small tablets and short windows', () => {
    expect(frameLayout(390, 844)).toEqual({ mode: 'fill' });
    expect(frameLayout(719, 1000)).toEqual({ mode: 'fill' });
    expect(frameLayout(1440, 500)).toEqual({ mode: 'fill' });
  });

  it('frames wide screens, shrinking the height to fit and adding the panel when there is room', () => {
    expect(frameLayout(900, 1000)).toEqual({
      mode: 'frame',
      width: PHONE_SCREEN.width,
      height: PHONE_SCREEN.height,
      panel: false,
    });
    expect(frameLayout(1440, 800)).toEqual({ mode: 'frame', width: 390, height: 732, panel: true });
  });
});

function RectProbe() {
  const rect = useContext(FrameRectContext);
  return <Text>{rect ? 'framed' : 'unframed'}</Text>;
}

describe('PhoneFrameLayout', () => {
  const renderFrame = (width: number, height: number) =>
    render(
      <ThemeProvider initialPreference="dark">
        <PhoneFrameLayout layout={frameLayout(width, height)}>
          <RectProbe />
        </PhoneFrameLayout>
      </ThemeProvider>,
    );

  it('shows the demo panel beside the phone on a laptop', async () => {
    await renderFrame(1440, 900);
    expect(screen.getByText('Web demo')).toBeOnTheScreen();
    expect(screen.getByText(/the app unlocks with your PIN/)).toBeOnTheScreen();
    expect(await screen.findByText(/No camera found/)).toBeOnTheScreen();
  });

  it('renders the app alone on a phone browser, with no frame for modals to follow', async () => {
    await renderFrame(390, 844);
    expect(screen.queryByText('Web demo')).toBeNull();
    expect(screen.getByText('unframed')).toBeOnTheScreen();
  });
});
