import type { Schema } from '@nem/contracts';
import { keepPreviousData } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { AtSign, Globe, Landmark, Search, Users } from 'lucide-react-native';
import { useCallback, useState } from 'react';
import { View } from 'react-native';

import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  ListItem,
  PaidFeatureNotice,
  Screen,
  SectionHeader,
  SkeletonGroup,
  SkeletonListItem,
  TextField,
} from '@/components';
import { useRepoQuery } from '@/lib/query';
import { useDebounced } from '@/lib/useDebounced';
import { useTheme } from '@/theme';

import { BeneficiaryRow } from '../components/BeneficiaryRow';
import { SendHeader } from '../components/SendHeader';
import { recipientFromBeneficiary, useSendDraft, type SendMode } from '../sendDraft';

const SEARCH_DELAY_MS = 300;

/**
 * Where every payment starts (T7.1): pick the rail (Nem user, another bank or
 * abroad) or tap a saved beneficiary to go straight to the amount.
 */
export function SendHubScreen() {
  const router = useRouter();
  const { spacing } = useTheme();
  const setRecipient = useSendDraft((s) => s.setRecipient);
  const [abroadOpen, setAbroadOpen] = useState(false);
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim(), SEARCH_DELAY_MS);

  const beneficiaries = useRepoQuery(
    'beneficiaries',
    'list',
    { query: { q: q || undefined, limit: 50 } },
    // Keeps the last results on screen while a new search runs, so the list never blinks.
    { placeholderData: keepPreviousData },
  );

  const startNew = (mode: SendMode) =>
    router.push({ pathname: '/send/recipient', params: { mode } });

  const pay = useCallback(
    (b: Schema<'Beneficiary'>) => {
      setRecipient(recipientFromBeneficiary(b));
      router.push('/send/amount');
    },
    [router, setRecipient],
  );

  const list = beneficiaries.data?.data;
  const searching = q !== '';

  return (
    <Screen header={<SendHeader title="Send money" first />} edges={['top', 'bottom']}>
      <Card padded={false}>
        <ListItem
          leading={AtSign}
          title="To a Nem user"
          subtitle="By @nemtag, phone or account number. Instant and free."
          showChevron
          onPress={() => startNew('nem')}
        />
        <ListItem
          leading={Landmark}
          title="To another bank"
          subtitle="Any Nigerian bank. ₦10 to ₦50 fee."
          showChevron
          onPress={() => startNew('bank')}
        />
        <ListItem
          leading={Globe}
          title="Send abroad"
          subtitle="International transfer"
          trailing={<Badge label="Partner needed" tone="warning" />}
          onPress={() => setAbroadOpen(true)}
          accessibilityHint="Explains what sending abroad needs"
        />
      </Card>

      <SectionHeader
        title="Beneficiaries"
        actionLabel="Manage"
        onAction={() => router.push('/send/beneficiaries')}
      />
      {(list?.length ?? 0) > 0 || searching ? (
        <TextField
          label="Search beneficiaries"
          placeholder="Name, @nemtag, bank or account"
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
                : 'People you save after paying them appear here, ready for next time.'
            }
          />
        ) : (
          <Card padded={false}>
            {list.map((b) => (
              <BeneficiaryRow key={b.id} beneficiary={b} onPress={pay} />
            ))}
          </Card>
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

      <PaidFeatureNotice
        open={abroadOpen}
        onClose={() => setAbroadOpen(false)}
        feature="internationalTransfer"
      />
    </Screen>
  );
}
