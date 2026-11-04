import type { Schema } from '@nem/contracts';
import { keepPreviousData } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import {
  AtSign,
  CalendarClock,
  Globe,
  HandCoins,
  Landmark,
  Link2,
  Receipt,
  Search,
  Users,
} from '@/components/icons';
import { useCallback, useState } from 'react';
import { View } from 'react-native';

import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  ListItem,
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
import { openCount } from '../requests';
import { SendHeader } from '../components/SendHeader';
import { recipientFromBeneficiary, useSendDraft, type SendMode } from '../sendDraft';
import { useTranslation } from 'react-i18next';

const SEARCH_DELAY_MS = 300;

/**
 * Where every payment starts (T7.1): pick the rail (Nem user, another bank or
 * abroad) or tap a saved beneficiary to go straight to the amount.
 */
export function SendHubScreen() {
  const router = useRouter();
  const { spacing } = useTheme();
  const setRecipient = useSendDraft((s) => s.setRecipient);
  const [search, setSearch] = useState('');
  const { t } = useTranslation();
  const q = useDebounced(search.trim(), SEARCH_DELAY_MS);

  const beneficiaries = useRepoQuery(
    'beneficiaries',
    'list',
    { query: { q: q || undefined, limit: 50 } },
    // Keeps the last results on screen while a new search runs, so the list never blinks.
    { placeholderData: keepPreviousData },
  );

  const incoming = useRepoQuery('moneyRequests', 'list', {
    query: { direction: 'incoming', status: 'pending', limit: 50 },
  });
  const toPay = openCount(incoming.data?.data);

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
    <Screen
      header={<SendHeader title={t('transfers.hub.title')} first />}
      edges={['top', 'bottom']}
    >
      <Card padded={false}>
        <ListItem
          leading={AtSign}
          title={t('transfers.hub.nem')}
          subtitle={t('transfers.hub.nemHint')}
          showChevron
          onPress={() => startNew('nem')}
        />
        <ListItem
          leading={Landmark}
          title={t('transfers.hub.bank')}
          subtitle={t('transfers.hub.bankHint')}
          showChevron
          onPress={() => startNew('bank')}
        />
        <ListItem
          leading={Globe}
          title={t('transfers.hub.abroad')}
          subtitle={t('transfers.hub.abroadHint')}
          trailing={<Badge label={t('transfers.abroadScreen.partnerNeeded')} tone="warning" />}
          showChevron
          onPress={() => router.push('/send/abroad')}
        />
      </Card>

      <Card padded={false}>
        <ListItem
          leading={HandCoins}
          title={t('transfers.hub.requests')}
          subtitle={
            toPay > 0
              ? t('transfers.hub.waiting', { count: toPay })
              : t('transfers.hub.requestsHint')
          }
          trailing={
            toPay > 0 ? (
              <Badge
                count={toPay}
                tone="primary"
                accessibilityLabel={t('transfers.hub.toPay', { count: toPay })}
              />
            ) : undefined
          }
          showChevron
          onPress={() => router.push('/send/requests')}
        />
        <ListItem
          leading={Receipt}
          title={t('transfers.hub.split')}
          subtitle={t('transfers.hub.splitHint')}
          showChevron
          onPress={() => router.push('/send/splits')}
        />
        <ListItem
          leading={Link2}
          title={t('transfers.hub.links')}
          subtitle={t('transfers.hub.linksHint')}
          showChevron
          onPress={() => router.push('/send/links')}
        />
        <ListItem
          leading={CalendarClock}
          title={t('transfers.hub.scheduled')}
          subtitle={t('transfers.hub.scheduledHint')}
          showChevron
          onPress={() => router.push('/send/scheduled')}
        />
      </Card>

      <SectionHeader
        title={t('transfers.hub.beneficiaries')}
        actionLabel={t('transfers.hub.manage')}
        onAction={() => router.push('/send/beneficiaries')}
      />
      {(list?.length ?? 0) > 0 || searching ? (
        <TextField
          label={t('transfers.beneficiariesScreen.search')}
          placeholder={t('transfers.hub.searchPlaceholder')}
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
                : t('transfers.hub.noneMessage')
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
    </Screen>
  );
}
