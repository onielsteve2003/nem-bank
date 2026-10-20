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
    <Screen header={<SendHeader title="Beneficiaries" />} edges={['top', 'bottom']}>
      {(list?.length ?? 0) > 0 || searching ? (
        <TextField
          label="Search beneficiaries"
          placeholder="Name, nickname, bank or account"
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
            title={searching ? 'No one matches that' : 'No beneficiaries yet'}
            message={
              searching
                ? 'Try part of a name, a bank or the last digits of an account.'
                : 'Turn on "Save for next time" when you review a payment.'
            }
          />
        ) : (
          <>
            <Card padded={false}>
              {list.map((b) => (
                <BeneficiaryRow key={b.id} beneficiary={b} onPress={setChosen} verb="Manage" />
              ))}
            </Card>
            <Text variant="caption" color="textMuted">
              Someone new gets a short safety wait: large first payments to them need an extra
              check.
            </Text>
          </>
        )
      ) : beneficiaries.isError ? (
        <ErrorState
          title="We couldn't load your beneficiaries"
          onRetry={() => beneficiaries.refetch()}
        />
      ) : (
        <SkeletonGroup accessibilityLabel="Loading beneficiaries">
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
