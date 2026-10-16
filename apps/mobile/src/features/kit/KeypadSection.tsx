import { CURRENCIES, parseMajor, type CurrencyCode } from '@nem/shared';
import { ScanFace } from 'lucide-react-native';
import { useState } from 'react';
import { Alert } from 'react-native';

import { AmountInput, OtpInput, PinPad, SelectSheet, Text } from '@/components';

import { KitSection } from './KitSection';

// Demo only: the real PIN check is server-side with Argon2id (PRD AUTH-4).
const DEMO_PIN = '2580';
const DEMO_MAX_MAJOR = 50_000n;

export function KeypadSection() {
  const [currency, setCurrency] = useState<CurrencyCode>('NGN');
  const [amount, setAmount] = useState('');
  const [otp, setOtp] = useState('');
  const [pinError, setPinError] = useState<string>();

  const minor = amount === '' ? 0n : parseMajor(amount, currency).amount;
  const overLimit = minor > DEMO_MAX_MAJOR * 100n;

  return (
    <>
      <KitSection title="Amount">
        <SelectSheet
          label="Currency"
          value={currency}
          onChange={(c) => {
            setCurrency(c);
            setAmount('');
          }}
          options={Object.values(CURRENCIES).map((c) => ({ value: c.code, label: c.name }))}
        />
        <AmountInput
          currency={currency}
          value={amount}
          onChangeValue={setAmount}
          error={overLimit ? 'Above your demo limit of 50,000' : undefined}
          help="Try a third decimal or a second point"
        />
      </KitSection>
      <KitSection title="PIN">
        <PinPad
          title="Enter your PIN"
          subtitle={`Demo PIN is ${DEMO_PIN}`}
          error={pinError}
          accessory={{
            icon: ScanFace,
            accessibilityLabel: 'Use Face ID',
            onPress: () => Alert.alert('Face ID', 'Biometrics arrive with sign-in (M5).'),
          }}
          onComplete={(pin) => {
            const ok = pin === DEMO_PIN;
            setPinError(ok ? undefined : 'Wrong PIN. Try 2580');
            return ok;
          }}
        />
      </KitSection>
      <KitSection title="One-time code">
        <OtpInput
          value={otp}
          onChangeText={setOtp}
          help="Paste a message like “Your code is 482 913”"
        />
        {otp.length === 6 && <Text color="success">Code complete: {otp}</Text>}
      </KitSection>
    </>
  );
}
