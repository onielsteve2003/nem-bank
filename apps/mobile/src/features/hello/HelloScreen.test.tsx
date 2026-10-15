import { render, screen } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { HelloScreen } from './HelloScreen';

// Jest has no native safe-area module, so give the provider fixed metrics.
const metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

describe('HelloScreen', () => {
  it('shows the brand name and tagline', async () => {
    await render(
      <SafeAreaProvider initialMetrics={metrics}>
        <HelloScreen />
      </SafeAreaProvider>,
    );

    expect(screen.getByText('Nem Bank')).toBeOnTheScreen();
    expect(screen.getByText(/Simulated money, real engineering/)).toBeOnTheScreen();
  });
});
