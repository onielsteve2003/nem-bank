import type { Schema } from '@nem/contracts';
import { Check, Landmark, Search } from 'lucide-react-native';
import { useState } from 'react';

import {
  BottomSheet,
  Card,
  EmptyState,
  ErrorState,
  Icon,
  ListItem,
  SkeletonGroup,
  SkeletonListItem,
  TextField,
} from '@/components';
import { haptic } from '@/lib/haptics';
import { useRepoQuery } from '@/lib/query';

import { searchBanks } from '../recipient';

type Bank = Schema<'Bank'>;

/** Every Nigerian bank by CBN code (TRF-2), searchable by name, short name or code. */
export function BankPickerSheet({
  open,
  selected,
  onClose,
  onSelect,
}: {
  open: boolean;
  selected: string | null;
  onClose: () => void;
  onSelect: (bank: Bank) => void;
}) {
  const [search, setSearch] = useState('');
  // The list hardly ever changes, so one fetch serves the whole session.
  const banks = useRepoQuery('payees', 'listBanks', undefined, { staleTime: Infinity });
  const shown = banks.data ? searchBanks(banks.data.data, search) : [];

  const close = () => {
    setSearch('');
    onClose();
  };

  return (
    <BottomSheet open={open} onClose={close} title="Choose a bank" snapPoints={['90%']}>
      <TextField
        label="Search banks"
        placeholder="Name or bank code"
        leadingIcon={Search}
        value={search}
        onChangeText={setSearch}
        autoCorrect={false}
      />
      {banks.data ? (
        shown.length === 0 ? (
          <EmptyState icon={Landmark} title="No bank matches that" message="Try its short name." />
        ) : (
          <Card padded={false}>
            {shown.map((b) => (
              <ListItem
                key={b.code}
                leading={Landmark}
                title={b.name}
                subtitle={b.short_name && b.short_name !== b.name ? b.short_name : undefined}
                trailing={
                  b.code === selected ? <Icon icon={Check} color="primaryText" /> : undefined
                }
                showChevron={false}
                accessibilityLabel={`${b.name}${b.code === selected ? ', selected' : ''}`}
                onPress={() => {
                  haptic('selection');
                  setSearch('');
                  onSelect(b);
                }}
              />
            ))}
          </Card>
        )
      ) : banks.isError ? (
        <ErrorState title="We couldn't load the bank list" onRetry={() => banks.refetch()} />
      ) : (
        <SkeletonGroup accessibilityLabel="Loading banks">
          <SkeletonListItem />
          <SkeletonListItem />
          <SkeletonListItem />
        </SkeletonGroup>
      )}
    </BottomSheet>
  );
}
