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
import { useTranslation } from 'react-i18next';

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
  const { t } = useTranslation();
  // The list hardly ever changes, so one fetch serves the whole session.
  const banks = useRepoQuery('payees', 'listBanks', undefined, { staleTime: Infinity });
  const shown = banks.data ? searchBanks(banks.data.data, search) : [];

  const close = () => {
    setSearch('');
    onClose();
  };

  return (
    <BottomSheet
      open={open}
      onClose={close}
      title={t('transfers.banks.title')}
      snapPoints={['90%']}
    >
      <TextField
        label={t('transfers.banks.search')}
        placeholder={t('transfers.banks.searchPlaceholder')}
        leadingIcon={Search}
        value={search}
        onChangeText={setSearch}
        autoCorrect={false}
      />
      {banks.data ? (
        shown.length === 0 ? (
          <EmptyState
            icon={Landmark}
            title={t('transfers.banks.none')}
            message={t('transfers.banks.noneMessage')}
          />
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
                accessibilityLabel={`${b.name}${b.code === selected ? t('common.selected') : ''}`}
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
        <ErrorState title={t('transfers.banks.failed')} onRetry={() => banks.refetch()} />
      ) : (
        <SkeletonGroup accessibilityLabel={t('transfers.banks.loading')}>
          <SkeletonListItem />
          <SkeletonListItem />
          <SkeletonListItem />
        </SkeletonGroup>
      )}
    </BottomSheet>
  );
}
