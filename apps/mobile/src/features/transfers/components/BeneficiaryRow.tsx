import type { Schema } from '@nem/contracts';
import { Star } from 'lucide-react-native';
import { memo } from 'react';

import { Avatar, Icon, ListItem } from '@/components';

type Beneficiary = Schema<'Beneficiary'>;

/** "@amaka_o · Nem" or "GTBank · ••6789": enough to tell two Chidis apart. */
export function beneficiarySubtitle(b: Beneficiary): string {
  if (b.kind === 'nem' && b.nemtag) return `@${b.nemtag} · Nem`;
  return `${b.bank_name} · ••${b.account_number.slice(-4)}`;
}

export const BeneficiaryRow = memo(function BeneficiaryRow({
  beneficiary: b,
  onPress,
}: {
  beneficiary: Beneficiary;
  onPress: (b: Beneficiary) => void;
}) {
  const title = b.nickname ? `${b.nickname} (${b.name})` : b.name;
  const subtitle = beneficiarySubtitle(b);
  return (
    <ListItem
      leading={<Avatar name={b.name} size="md" ring={b.kind === 'nem'} />}
      title={title}
      subtitle={subtitle}
      trailing={b.favourite ? <Icon icon={Star} size="sm" color="primaryText" /> : undefined}
      showChevron
      onPress={() => onPress(b)}
      accessibilityLabel={`Pay ${title}, ${subtitle}${b.favourite ? ', favourite' : ''}`}
    />
  );
});
