import type { Schema } from '@nem/contracts';
import { Clock, Star } from 'lucide-react-native';
import { memo } from 'react';
import { StyleSheet, View } from 'react-native';

import { Avatar, Icon, ListItem } from '@/components';
import { useTheme } from '@/theme';

import { beneficiaryTitle, coolingOffUntil, formatUntil } from '../beneficiaries';

type Beneficiary = Schema<'Beneficiary'>;

/** "@amaka_o · Nem" or "GTBank · ••6789": enough to tell two Chidis apart. */
export function beneficiarySubtitle(b: Beneficiary): string {
  if (b.kind === 'nem' && b.nemtag) return `@${b.nemtag} · Nem`;
  return `${b.bank_name} · ••${b.account_number.slice(-4)}`;
}

/**
 * A saved person: favourite star, and a clock while the new-beneficiary
 * cooling-off applies (TRF-8). `verb` says what a tap does ("Pay", "Manage").
 */
export const BeneficiaryRow = memo(function BeneficiaryRow({
  beneficiary: b,
  onPress,
  verb = 'Pay',
}: {
  beneficiary: Beneficiary;
  onPress: (b: Beneficiary) => void;
  verb?: string;
}) {
  const { spacing } = useTheme();
  const title = beneficiaryTitle(b);
  const until = coolingOffUntil(b);
  const subtitle = until ? `New · ${beneficiarySubtitle(b)}` : beneficiarySubtitle(b);
  const spoken = [
    `${verb} ${title}, ${beneficiarySubtitle(b)}`,
    b.favourite ? 'favourite' : null,
    until ? `new, large payments need an extra check until ${formatUntil(until)}` : null,
  ]
    .filter(Boolean)
    .join(', ');
  return (
    <ListItem
      leading={<Avatar name={b.name} size="md" ring={b.kind === 'nem'} />}
      title={title}
      subtitle={subtitle}
      trailing={
        until || b.favourite ? (
          <View style={[styles.row, { gap: spacing[2] }]}>
            {until && <Icon icon={Clock} size="sm" color="warning" />}
            {b.favourite && <Icon icon={Star} size="sm" color="primaryText" />}
          </View>
        ) : undefined
      }
      showChevron
      onPress={() => onPress(b)}
      accessibilityLabel={spoken}
    />
  );
});

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
});
