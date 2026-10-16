import { CURRENCIES, CURRENCY_CODES, type CurrencyCode } from '@nem/shared';
import { AtSign, Search } from 'lucide-react-native';
import { useState } from 'react';

import { Checkbox, SelectSheet, Switch, TextField } from '@/components';

import { KitSection } from './KitSection';

const CURRENCY_OPTIONS = CURRENCY_CODES.map((code) => ({
  value: code,
  label: `${CURRENCIES[code].flag}  ${CURRENCIES[code].name}`,
  description: code,
}));

export function FormsSection() {
  const [email, setEmail] = useState('');
  const [currency, setCurrency] = useState<CurrencyCode | null>(null);
  const [hideBalances, setHideBalances] = useState(false);
  const [terms, setTerms] = useState(false);

  const emailError = email.length > 0 && !email.includes('@') ? 'Enter a valid email' : undefined;

  return (
    <KitSection title="Forms">
      <TextField
        label="Email"
        placeholder="you@example.com"
        keyboardType="email-address"
        autoCapitalize="none"
        autoComplete="email"
        value={email}
        onChangeText={setEmail}
        error={emailError}
        help="We send your sign-in code here"
      />
      <TextField label="Password" secureTextEntry autoComplete="password" />
      <TextField label="Nem tag" leadingIcon={AtSign} placeholder="ada" optional />
      <TextField label="Search" leadingIcon={Search} placeholder="Banks, people" editable={false} />
      <SelectSheet
        label="Wallet currency"
        placeholder="Choose a currency"
        options={CURRENCY_OPTIONS}
        value={currency}
        onChange={setCurrency}
      />
      <Switch
        label="Hide balances"
        description="Mask amounts on the home screen"
        value={hideBalances}
        onValueChange={setHideBalances}
      />
      <Checkbox
        label="I accept the terms and privacy notice"
        checked={terms}
        onChange={setTerms}
        error={terms ? undefined : 'Accept to continue'}
      />
    </KitSection>
  );
}
