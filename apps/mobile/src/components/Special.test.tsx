import { fireEvent, render, screen } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ThemeProvider } from '@/theme';

import { AIBadge } from './AIBadge';
import { DemoMoneyBadge } from './DemoMoneyBadge';
import { PAID_FEATURES, PaidFeatureNotice } from './PaidFeatureNotice';
import { RiskReasonList, sortReasons, type RiskReason } from './RiskReasonList';

jest.mock('@/lib/haptics', () => ({ haptic: jest.fn() }));

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const renderThemed = (ui: React.ReactElement) =>
  render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <ThemeProvider initialPreference="dark">{ui}</ThemeProvider>
    </SafeAreaProvider>,
  );

describe('PaidFeatureNotice', () => {
  it('shows the PRD §11 copy for the feature and closes on Got it', async () => {
    const onClose = jest.fn();
    await renderThemed(<PaidFeatureNotice open onClose={onClose} feature="physicalCard" />);
    expect(screen.getByText('This feature needs a paid partner service')).toBeOnTheScreen();
    expect(screen.getByText(/Physical cards requires a card issuer/)).toBeOnTheScreen();
    expect(screen.getByText(/fully designed but switched off/)).toBeOnTheScreen();

    await fireEvent.press(screen.getByRole('button', { name: 'Got it' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('switches to the explainer and back', async () => {
    await renderThemed(<PaidFeatureNotice open onClose={jest.fn()} feature="ussd" />);
    await fireEvent.press(screen.getByRole('button', { name: 'See how it would work' }));
    expect(screen.getByText('How it would work')).toBeOnTheScreen();
    for (const step of PAID_FEATURES.ussd.steps) expect(screen.getByText(step)).toBeOnTheScreen();

    await fireEvent.press(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByText('This feature needs a paid partner service')).toBeOnTheScreen();
  });
});

describe('AIBadge', () => {
  it('opens an explainer with the fallback and a settings link', async () => {
    const onManage = jest.fn();
    await renderThemed(
      <AIBadge
        feature="Smart categories"
        explanation="A model reads merchant names."
        fallback="Fixed rules are used."
        onManage={onManage}
      />,
    );
    // The bottom-sheet mock renders the closed sheet inline, and its modal flag
    // hides the badge from default queries.
    await fireEvent.press(
      screen.getByRole('button', { name: 'AI: Smart categories', includeHiddenElements: true }),
    );
    expect(screen.getByText('A model reads merchant names.')).toBeOnTheScreen();
    expect(screen.getByText('Fixed rules are used.')).toBeOnTheScreen();

    await fireEvent.press(screen.getByRole('button', { name: 'Manage in Settings' }));
    expect(onManage).toHaveBeenCalledTimes(1);
  });
});

describe('DemoMoneyBadge', () => {
  it('tells screen readers the money is simulated', async () => {
    await renderThemed(<DemoMoneyBadge />);
    expect(screen.getByLabelText('Demo money. These balances are simulated.')).toBeOnTheScreen();
  });
});

describe('RiskReasonList', () => {
  const reasons: RiskReason[] = [
    { code: 'A', label: 'Late at night', severity: 'low' },
    { code: 'B', label: 'Large amount', severity: 'high' },
    { code: 'C', label: 'New payee', severity: 'medium' },
  ];

  it('sorts the most severe reason first', () => {
    expect(sortReasons(reasons).map((r) => r.code)).toEqual(['B', 'C', 'A']);
  });

  it('labels each reason with its severity in words', async () => {
    await renderThemed(<RiskReasonList reasons={reasons} />);
    expect(screen.getByLabelText('High risk: Large amount')).toBeOnTheScreen();
    expect(screen.getByLabelText('Low risk: Late at night')).toBeOnTheScreen();
  });

  it('says so when there are no reasons', async () => {
    await renderThemed(<RiskReasonList reasons={[]} />);
    expect(screen.getByText('No risk signals found.')).toBeOnTheScreen();
  });
});
