import { fireEvent, render, screen } from '@testing-library/react-native';
import { Wallet } from 'lucide-react-native';

import { haptic } from '@/lib/haptics';
import { ThemeProvider } from '@/theme';

import { Avatar } from './Avatar';
import { avatarInitials } from './avatarInitials';
import { Badge, badgeCountLabel } from './Badge';
import { Card } from './Card';
import { Chip } from './Chip';
import { ListItem } from './ListItem';
import { SectionHeader } from './SectionHeader';
import { Text } from './Text';

jest.mock('@/lib/haptics', () => ({ haptic: jest.fn() }));

const renderThemed = (ui: React.ReactElement) =>
  render(<ThemeProvider initialPreference="dark">{ui}</ThemeProvider>);

beforeEach(() => jest.clearAllMocks());

describe('avatarInitials', () => {
  it.each([
    ['Ada Lovelace', 'AL'],
    ['  chidi   emeka  okafor ', 'CO'],
    ['Ngozi', 'N'],
    ['', '?'],
    ['élodie durand', 'ÉD'],
  ])('%j → %s', (name, initials) => {
    expect(avatarInitials(name)).toBe(initials);
  });
});

describe('Avatar', () => {
  it('shows initials and is announced by name when there is no photo', async () => {
    await renderThemed(<Avatar name="Ada Lovelace" />);
    expect(screen.getByRole('image', { name: 'Ada Lovelace' })).toBeOnTheScreen();
    expect(screen.getByText('AL')).toBeOnTheScreen();
  });

  it('falls back to initials when the photo fails', async () => {
    await renderThemed(<Avatar name="Tunde Bakare" uri="https://example.com/x.png" />);
    await fireEvent(screen.getByTestId('avatar-image'), 'error', {
      nativeEvent: { error: 'boom' },
    });
    expect(screen.getByText('TB')).toBeOnTheScreen();
  });
});

describe('Badge', () => {
  it('caps counts at 99+', () => {
    expect(badgeCountLabel(5)).toBe('5');
    expect(badgeCountLabel(99)).toBe('99');
    expect(badgeCountLabel(100)).toBe('99+');
  });

  it('renders nothing for a zero count', async () => {
    await renderThemed(<Badge count={0} />);
    expect(screen.queryByText('0')).toBeNull();
  });

  it('announces a count as new items', async () => {
    await renderThemed(<Badge count={3} tone="danger" />);
    expect(screen.getByLabelText('3 new')).toBeOnTheScreen();
  });
});

describe('Chip', () => {
  it('toggles with a selection haptic and announces its state', async () => {
    const onPress = jest.fn();
    await renderThemed(<Chip label="Bills" selected onPress={onPress} />);
    const chip = screen.getByRole('togglebutton', { name: 'Bills' });
    expect(chip).toBeSelected();
    await fireEvent.press(chip);
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(haptic).toHaveBeenCalledWith('selection');
  });

  it('has a separately labelled remove button', async () => {
    const onRemove = jest.fn();
    await renderThemed(<Chip label="This month" onRemove={onRemove} />);
    await fireEvent.press(screen.getByRole('button', { name: 'Remove This month' }));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});

describe('ListItem', () => {
  it('reads title and subtitle as one button', async () => {
    const onPress = jest.fn();
    await renderThemed(
      <ListItem title="Wallets" subtitle="NGN, USD" leading={Wallet} onPress={onPress} />,
    );
    await fireEvent.press(screen.getByRole('button', { name: 'Wallets, NGN, USD' }));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('is not a button without onPress', async () => {
    await renderThemed(<ListItem title="Static row" trailing="₦0.00" />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('₦0.00')).toBeOnTheScreen();
  });
});

describe('Card and SectionHeader', () => {
  it('makes a card pressable only when it has onPress', async () => {
    const onPress = jest.fn();
    await renderThemed(
      <Card onPress={onPress} accessibilityLabel="Open savings">
        <Text>Savings</Text>
      </Card>,
    );
    await fireEvent.press(screen.getByRole('button', { name: 'Open savings' }));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('announces the action with its section', async () => {
    const onAction = jest.fn();
    await renderThemed(
      <SectionHeader title="Transactions" actionLabel="See all" onAction={onAction} />,
    );
    expect(screen.getByRole('header', { name: 'Transactions' })).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'See all, Transactions' }));
    expect(onAction).toHaveBeenCalledTimes(1);
  });
});
