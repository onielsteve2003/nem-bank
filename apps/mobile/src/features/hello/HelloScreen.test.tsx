import { QueryClient } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { repositoriesFromDispatcher, RepositoryProvider } from '@/data';
import { QueryProvider } from '@/lib/query';
import { ThemeProvider } from '@/theme';

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
        <RepositoryProvider repositories={repositoriesFromDispatcher(async () => undefined)}>
          <QueryProvider client={new QueryClient()}>
            <ThemeProvider>
              <HelloScreen />
            </ThemeProvider>
          </QueryProvider>
        </RepositoryProvider>
      </SafeAreaProvider>,
    );

    expect(screen.getByText('Nem Bank')).toBeOnTheScreen();
    expect(screen.getByText(/Simulated money, real engineering/)).toBeOnTheScreen();
    expect(screen.getByText('Data: mock bank (on device)')).toBeOnTheScreen();
  });
});
