import { render, screen } from '@testing-library/react-native';
import { ShieldCheck } from 'lucide-react-native';

import { ThemeProvider } from '@/theme';

import { Icon } from './Icon';

describe('Icon', () => {
  it('exposes a labelled icon to screen readers as an image', async () => {
    await render(
      <ThemeProvider>
        <Icon icon={ShieldCheck} accessibilityLabel="Verified" />
      </ThemeProvider>,
    );
    expect(screen.getByRole('image', { name: 'Verified' })).toBeOnTheScreen();
  });

  it('hides decorative icons from screen readers', async () => {
    await render(
      <ThemeProvider>
        <Icon icon={ShieldCheck} />
      </ThemeProvider>,
    );
    expect(screen.queryByRole('image')).not.toBeOnTheScreen();
  });
});
