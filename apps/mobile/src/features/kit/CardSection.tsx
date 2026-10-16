import { useState } from 'react';
import { View } from 'react-native';

import { BankCard, Switch, Text } from '@/components';
import { useTheme } from '@/theme';

import { KitSection } from './KitSection';

export function CardSection() {
  const { spacing } = useTheme();
  const [frozen, setFrozen] = useState(false);
  const [revealed, setRevealed] = useState(false);

  return (
    <KitSection title="Bank card">
      <Text variant="bodySmall" color="textMuted">
        Tap to flip. Tilt the phone to see it move (off with reduce motion).
      </Text>
      <BankCard
        holder="Ada Lovelace"
        last4="4821"
        expiry="09/29"
        network="verve"
        frozen={frozen}
        revealed={revealed ? { number: '5061 2345 6789 4821', cvv: '713' } : undefined}
      />
      <View style={{ gap: spacing[2] }}>
        <Switch label="Freeze card" value={frozen} onValueChange={setFrozen} />
        <Switch label="Reveal details on the back" value={revealed} onValueChange={setRevealed} />
      </View>
    </KitSection>
  );
}
