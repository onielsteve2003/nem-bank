import { MIN_TOUCH_TARGET } from '@nem/shared';
import { render, screen, within, type RenderResult } from '@testing-library/react-native';
import { Bell } from 'lucide-react-native';
import { StyleSheet, type Insets } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ThemeProvider } from '@/theme';

import { AIBadge } from './AIBadge';
import { Button } from './Button';
import { Card } from './Card';
import { Checkbox } from './Checkbox';
import { Chip } from './Chip';
import { Dialog } from './Dialog';
import { IconButton } from './IconButton';
import { ListItem } from './ListItem';
import { NumericKeypad } from './NumericKeypad';
import { SelectSheet } from './SelectSheet';
import { Switch } from './Switch';
import { Text } from './Text';
import { TextField } from './TextField';

// T2.15 accessibility pass: every interactive primitive exposes a role and a
// name, and is at least 44 pt tall once its hit slop is counted (code-standards §7).

jest.mock('@/lib/haptics', () => ({ haptic: jest.fn() }));

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const renderThemed = (ui: React.ReactElement): Promise<RenderResult> =>
  render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <ThemeProvider initialPreference="dark">{ui}</ThemeProvider>
    </SafeAreaProvider>,
  );

type Element = ReturnType<typeof screen.getByRole>;

const ROLES = ['button', 'togglebutton', 'checkbox', 'switch', 'radio'] as const;

function interactive(): Element[] {
  return ROLES.flatMap((role) => screen.queryAllByRole(role));
}

/** Height of the touchable area: the drawn height plus any hit slop above and below. */
function touchHeight(el: Element): number {
  const style = StyleSheet.flatten(el.props.style) ?? {};
  const slop: Insets =
    typeof el.props.hitSlop === 'number'
      ? { top: el.props.hitSlop, bottom: el.props.hitSlop }
      : (el.props.hitSlop ?? {});
  const drawn = Math.max(Number(style.height ?? 0), Number(style.minHeight ?? 0));
  return drawn + (slop.top ?? 0) + (slop.bottom ?? 0);
}

function accessibleName(el: Element): string {
  const label = el.props.accessibilityLabel ?? el.props['aria-label'];
  if (label) return String(label);
  return within(el)
    .queryAllByText(/.+/, { includeHiddenElements: true })
    .map((t) => t.props.children)
    .join(' ');
}

function Primitives() {
  return (
    <>
      <Button label="Small button" size="sm" onPress={jest.fn()} />
      <IconButton icon={Bell} accessibilityLabel="Notifications" size="sm" onPress={jest.fn()} />
      <Chip label="Food" onPress={jest.fn()} onRemove={jest.fn()} />
      <Checkbox label="I agree" checked={false} onChange={jest.fn()} />
      <Switch label="Biometrics" value onValueChange={jest.fn()} />
      <ListItem title="Statements" onPress={jest.fn()} />
      <TextField label="Password" secureTextEntry value="" onChangeText={jest.fn()} />
      <SelectSheet
        label="Currency"
        options={[{ value: 'NGN', label: 'Naira' }]}
        value="NGN"
        onChange={jest.fn()}
      />
      <NumericKeypad decimal onKey={jest.fn()} />
    </>
  );
}

describe('interactive primitives', () => {
  it('each has a role and a spoken name', async () => {
    await renderThemed(<Primitives />);
    const elements = interactive();
    // 1 button, 1 icon button, chip + remove, checkbox, switch, row, reveal, select, 12 keys.
    expect(elements.length).toBeGreaterThanOrEqual(20);
    for (const el of elements) expect(accessibleName(el).trim()).not.toBe('');
  });

  it(`each is at least ${MIN_TOUCH_TARGET} pt tall to touch`, async () => {
    await renderThemed(<Primitives />);
    const small = interactive()
      .filter((el) => touchHeight(el) < MIN_TOUCH_TARGET)
      .map((el) => `${accessibleName(el)} (${touchHeight(el)} pt)`);
    expect(small).toEqual([]);
  });

  it('the AI badge is a labelled, full-size target', async () => {
    await renderThemed(<AIBadge feature="Insights" explanation="x" fallback="y" />);
    const badge = screen.getByRole('button', { name: 'AI: Insights', includeHiddenElements: true });
    expect(touchHeight(badge)).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET);
  });

  // Cards are sized by their content, so only their state is checked here.
  it('a disabled pressable card says it is disabled', async () => {
    await renderThemed(
      <Card onPress={jest.fn()} disabled>
        <Text>Locked</Text>
      </Card>,
    );
    expect(screen.getByRole('button', { name: 'Locked' })).toBeDisabled();
  });
});

describe('Dialog focus order', () => {
  it('starts at the title and offers exactly confirm then cancel', async () => {
    await renderThemed(
      <Dialog
        open
        title="Freeze this card?"
        confirmLabel="Freeze card"
        onConfirm={jest.fn()}
        onCancel={jest.fn()}
      />,
    );
    expect(screen.getByRole('header', { name: 'Freeze this card?' })).toBeOnTheScreen();
    // The backdrop is a tap shortcut only; it must not be a second "Cancel" stop.
    expect(screen.getAllByRole('button').map(accessibleName)).toEqual(['Freeze card', 'Cancel']);
  });
});
