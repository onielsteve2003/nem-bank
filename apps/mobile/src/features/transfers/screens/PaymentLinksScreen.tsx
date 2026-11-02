import type { Schema } from '@nem/contracts';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Link2, Plus } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  Badge,
  Button,
  Card,
  Chip,
  EmptyState,
  ErrorState,
  Icon,
  ListItem,
  Screen,
  SkeletonGroup,
  SkeletonListItem,
  Text,
  TextField,
} from '@/components';
import { useOpenLink } from '@/features/shell/linking';
import { resolveDeepLink } from '@/lib/deepLinks';
import { useRepoQuery } from '@/lib/query';
import { useSessionStore } from '@/stores';
import { useTheme } from '@/theme';

import { LinkSheet } from '../components/LinkSheet';
import { SendHeader } from '../components/SendHeader';
import { LINK_STATUS, linkSubtitle } from '../paymentLinks';
import { useTranslation } from 'react-i18next';

type PaymentLink = Schema<'PaymentLink'>;

/** A friend's link the demo bank knows, so paying through a link can be tried. */
const DEMO_FRIEND_LINK = 'https://nem-bank-fodx.vercel.app/pay/emeka-birthday';

function LinkRow({ link, onPress }: { link: PaymentLink; onPress: (l: PaymentLink) => void }) {
  const subtitle = linkSubtitle(link);
  const status = LINK_STATUS[link.status];
  const { t } = useTranslation();
  return (
    <ListItem
      leading={<Icon icon={Link2} color={link.status === 'active' ? 'primary' : 'textMuted'} />}
      title={link.title}
      subtitle={subtitle}
      trailing={
        link.status !== 'active' ? <Badge label={status.label} tone={status.tone} /> : undefined
      }
      onPress={() => onPress(link)}
      accessibilityLabel={`${link.title}, ${subtitle}, ${status.label}`}
      accessibilityHint={t('transfers.linksScreen.showHint')}
    />
  );
}

/**
 * Payment links (TRF-12): a link (and its QR) anyone can open to pay the
 * customer, for a fixed amount or whatever the payer chooses. A pasted link
 * from someone else opens its pay page.
 */
export function PaymentLinksScreen() {
  const router = useRouter();
  const openLink = useOpenLink();
  const params = useLocalSearchParams<{ created?: string }>();
  const { spacing } = useTheme();
  const isDemo = useSessionStore((s) => s.session?.isDemo ?? false);
  const links = useRepoQuery('paymentLinks', 'list', { query: { limit: 50 } });
  const [chosen, setChosen] = useState<PaymentLink | null>(null);
  const [pasted, setPasted] = useState('');
  const [pasteError, setPasteError] = useState<string>();
  const { t } = useTranslation();

  // A link just made opens straight away, ready to share; once, not on every refetch.
  const shownCreated = useRef(false);
  const created = params.created
    ? links.data?.data.find((l) => l.id === params.created)
    : undefined;
  useEffect(() => {
    if (!created || shownCreated.current) return;
    shownCreated.current = true;
    setChosen(created);
  }, [created]);

  const open = (value: string) => {
    const { href } = resolveDeepLink(value);
    const isPayLink = typeof href === 'object' && href.pathname === '/pay/[slug]';
    if (!isPayLink) {
      setPasteError(t('transfers.linksScreen.notPayLink'));
      return;
    }
    setPasteError(undefined);
    setPasted('');
    openLink(value);
  };

  const list = links.data?.data;

  return (
    <Screen
      header={<SendHeader title={t('transfers.linksScreen.title')} />}
      edges={['top', 'bottom']}
      footer={
        <Button
          label={t('transfers.linksScreen.create')}
          icon={Plus}
          onPress={() => router.push('/send/links/new')}
        />
      }
    >
      {list ? (
        list.length === 0 ? (
          <EmptyState
            icon={Link2}
            title={t('transfers.linksScreen.none')}
            message={t('transfers.linksScreen.noneMessage')}
          />
        ) : (
          <Card padded={false}>
            {list.map((l) => (
              <LinkRow key={l.id} link={l} onPress={setChosen} />
            ))}
          </Card>
        )
      ) : links.isError ? (
        <ErrorState title={t('transfers.linksScreen.failed')} onRetry={() => links.refetch()} />
      ) : (
        <SkeletonGroup accessibilityLabel={t('transfers.linksScreen.loading')}>
          <View style={{ gap: spacing[2] }}>
            <SkeletonListItem />
            <SkeletonListItem />
          </View>
        </SkeletonGroup>
      )}

      <View style={{ gap: spacing[2] }}>
        <Text variant="label" color="textMuted">
          {t('transfers.linksScreen.gotOne')}
        </Text>
        <TextField
          label={t('transfers.linksScreen.payLink')}
          placeholder={t('transfers.linksScreen.pastePlaceholder')}
          value={pasted}
          onChangeText={(v) => {
            setPasted(v);
            setPasteError(undefined);
          }}
          autoCapitalize="none"
          autoCorrect={false}
          error={pasteError}
          onSubmitEditing={() => pasted.trim() && open(pasted)}
        />
        <Button
          label={t('transfers.linksScreen.open')}
          variant="secondary"
          disabled={!pasted.trim()}
          onPress={() => open(pasted)}
        />
        {isDemo && (
          <View style={[styles.row, { gap: spacing[2] }]}>
            <Text variant="bodySmall" color="textMuted" style={styles.flex}>
              {t('transfers.linksScreen.demo')}
            </Text>
            <Chip
              label={t('transfers.linksScreen.emeka')}
              icon={Link2}
              onPress={() => open(DEMO_FRIEND_LINK)}
            />
          </View>
        )}
      </View>

      {chosen && <LinkSheet key={chosen.id} link={chosen} onClose={() => setChosen(null)} />}
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
});
