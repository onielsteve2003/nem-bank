import type { Schema } from '@nem/contracts';
import { configure, fireEvent, render, screen } from '@testing-library/react-native';
import * as Clipboard from 'expo-clipboard';
import { Share } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ToastProvider } from '@/components';
import { ThemeProvider } from '@/theme';

import { AccountDetailsSheet } from '../AccountDetailsSheet';
import { detailRows, formatIban, formatSortCode, shareMessage } from '../receivingDetails';

jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true) }));
jest.mock('@/lib/haptics', () => ({ haptic: jest.fn() }));

// The bottom-sheet mock renders the sheet inline as a modal view.
configure({ defaultIncludeHiddenElements: true });

const metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const NUBAN: Schema<'ReceivingDetails'> = {
  scheme: 'nuban',
  bank_name: 'Nem Bank (demo)',
  bank_code: '090999',
  account_number: '0123456789',
  account_name: 'Tolulope Adebayo',
  demo: true,
};

const account = (receiving_details: Schema<'ReceivingDetails'>, currency = 'NGN') =>
  ({ id: 'a1', currency, receiving_details }) as unknown as Schema<'Account'>;

describe('receiving details', () => {
  it('groups for reading but copies digits only', () => {
    expect(formatSortCode('040000')).toBe('04-00-00');
    expect(formatIban('de00500000 0123456789')).toBe('DE00 5000 0001 2345 6789');
    const uk = detailRows({
      scheme: 'uk_fps',
      bank_name: 'Partner',
      sort_code: '04-00-00',
      account_number: '23456789',
      account_name: 'Tolu',
      demo: true,
    });
    expect(uk[0]).toEqual({ label: 'Sort code', value: '04-00-00', copy: '040000' });
    const eu = detailRows({
      scheme: 'iban',
      bank_name: 'Partner',
      iban: 'DE00500000 0123456789',
      bic: 'NEMSDEFFXXX',
      account_name: 'Tolu',
      demo: true,
    });
    expect(eu[0]!.copy).toBe('DE005000000123456789');
  });

  it('lists the US routing number and account type', () => {
    const us = detailRows({
      scheme: 'us_ach',
      bank_name: 'Partner',
      account_number: '0123456789',
      routing_number: '021000000',
      account_type: 'checking',
      account_name: 'Tolu',
      demo: true,
    });
    expect(us.map((r) => r.label)).toEqual([
      'Account number',
      'Routing number (ACH)',
      'Account type',
      'Bank',
      'Account name',
    ]);
  });

  it('shares every detail and says when they are demo details', () => {
    const message = shareMessage(NUBAN, 'Nigerian Naira');
    expect(message).toContain('Account number: 0123456789');
    expect(message).toContain('Bank: Nem Bank (demo)');
    expect(message).toMatch(/demo details/);
    expect(shareMessage({ ...NUBAN, demo: false }, 'Nigerian Naira')).not.toMatch(/demo details/);
  });
});

describe('AccountDetailsSheet', () => {
  async function renderSheet(props: Partial<Parameters<typeof AccountDetailsSheet>[0]> = {}) {
    await render(
      <SafeAreaProvider initialMetrics={metrics}>
        <ThemeProvider initialPreference="dark">
          <ToastProvider>
            <AccountDetailsSheet account={account(NUBAN)} onClose={jest.fn()} {...props} />
          </ToastProvider>
        </ThemeProvider>
      </SafeAreaProvider>,
    );
  }

  it('copies one detail at a time and confirms it', async () => {
    await renderSheet();
    expect(screen.getByText('Demo details')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Copy account number' }));
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith('0123456789');
    expect(await screen.findByText('Account number copied')).toBeOnTheScreen();
  });

  it('shares all the details in one message', async () => {
    const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });
    await renderSheet();
    await fireEvent.press(screen.getByRole('button', { name: 'Share details' }));
    expect(share).toHaveBeenCalledWith({ message: shareMessage(NUBAN, 'Nigerian Naira') });
  });

  it('offers demo money only when the demo bank can give it', async () => {
    const onAddDemoMoney = jest.fn();
    await renderSheet({ onAddDemoMoney });
    await fireEvent.press(screen.getByRole('button', { name: 'Add demo money now' }));
    expect(onAddDemoMoney).toHaveBeenCalled();
  });

  it('shows nothing while no account is chosen', async () => {
    await renderSheet({ account: null });
    expect(screen.queryByRole('button', { name: 'Share details' })).toBeNull();
  });
});
