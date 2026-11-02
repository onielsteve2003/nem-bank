import type { Schema } from '@nem/contracts';
import { keepPreviousData } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { Search, Users } from 'lucide-react-native';
import { useCallback, useState } from 'react';
import { View } from 'react-native';

import {
  Card,
  EmptyState,
  ErrorState,
  Screen,
  SkeletonGroup,
  SkeletonListItem,
  Text,
  TextField,
} from '@/components';
import { useRepoQuery } from '@/lib/query';
import { useDebounced } from '@/lib/useDebounced';
import { useTheme } from '@/theme';

import { BeneficiaryRow } from '../components/BeneficiaryRow';
import { BeneficiarySheet } from '../components/BeneficiarySheet';
import { SendHeader } from '../components/SendHeader';
import { recipientFromBeneficiary, useSendDraft } from '../sendDraft';
import { useTranslation } from 'react-i18next';

type Beneficiary = Schema<'Beneficiary'>;

const SEARCH_DELAY_MS = 300;

/**
 * Everyone the customer has saved (TRF-8): favourites first, a clock on anyone
 * still in the new-beneficiary cooling-off. Tap one to pay, favourite, nickname
 * or delete them.
 */
export function BeneficiariesScreen() {
  const router = useRouter();
  const { spacing } = useTheme();
  const { t } = useTranslation();
  const setRecipient = useSendDraft((s) => s.setRecipient);
  const [search, setSearch] = useState('');
  const [chosen, setChosen] = useState<Beneficiary | null>(null);
  const q = useDebounced(search.trim(), SEARCH_DELAY_MS);

  const beneficiaries = useRepoQuery(
    'beneficiaries',
    'list',
    { query: { q: q || undefined, limit: 100 } },
    { placeholderData: keepPreviousData },
  );

  const pay = useCallback(
    (b: Beneficiary) => {
      setChosen(null);
      setRecipient(recipientFromBeneficiary(b));
      router.push('/send/amount');
    },
    [router, setRecipient],
  );

  const list = beneficiaries.data?.data;
  const searching = q !== '';

  return (
    <Screen
      header={<SendHeader title={t('transfers.beneficiariesScreen.title')} />}
      edges={['top', 'bottom']}
    >
      {(list?.length ?? 0) > 0 || searching ? (
        <TextField
          label={t('transfers.beneficiariesScreen.search')}
          placeholder={t('transfers.beneficiariesScreen.searchPlaceholder')}
          leadingIcon={Search}
          value={search}
          onChangeText={setSearch}
          autoCorrect={false}
          returnKeyType="search"
        />
      ) : null}
      {list ? (
        list.length === 0 ? (
          <EmptyState
            icon={Users}
            title={
              searching
                ? t('transfers.beneficiariesScreen.noMatch')
                : t('transfers.beneficiariesScreen.none')
            }
            message={
              searching
                ? t('transfers.beneficiariesScreen.noMatchMessage')
                : t('transfers.beneficiariesScreen.noneMessage')
            }
          />
        ) : (
          <>
            <Card padded={false}>
              {list.map((b) => (
                <BeneficiaryRow key={b.id} beneficiary={b} onPress={setChosen} verb="manage" />
              ))}
            </Card>
            <Text variant="caption" color="textMuted">
              {t('transfers.beneficiariesScreen.safetyNote')}
            </Text>
          </>
        )
      ) : beneficiaries.isError ? (
        <ErrorState
          title={t('transfers.beneficiariesScreen.failed')}
          onRetry={() => beneficiaries.refetch()}
        />
      ) : (
        <SkeletonGroup accessibilityLabel={t('transfers.beneficiariesScreen.loading')}>
          <View style={{ gap: spacing[2] }}>
            <SkeletonListItem />
            <SkeletonListItem />
            <SkeletonListItem />
          </View>
        </SkeletonGroup>
      )}

      {chosen && (
        <BeneficiarySheet
          key={chosen.id}
          beneficiary={chosen}
          onClose={() => setChosen(null)}
          onPay={pay}
        />
      )}
    </Screen>
  );
}
