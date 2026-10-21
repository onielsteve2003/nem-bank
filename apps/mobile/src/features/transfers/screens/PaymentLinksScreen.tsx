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

type PaymentLink = Schema<'PaymentLink'>;

/** A friend's link the demo bank knows, so paying through a link can be tried. */
const DEMO_FRIEND_LINK = 'https://nem-bank-fodx.vercel.app/pay/emeka-birthday';

function LinkRow({ link, onPress }: { link: PaymentLink; onPress: (l: PaymentLink) => void }) {
  const subtitle = linkSubtitle(link);
  const status = LINK_STATUS[link.status];
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
      accessibilityHint="Shows the link to copy or share"
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
      setPasteError("That isn't a Nem pay link.");
      return;
    }
    setPasteError(undefined);
    setPasted('');
    openLink(value);
  };

  const list = links.data?.data;

  return (
    <Screen
      header={<SendHeader title="Payment links" />}
      edges={['top', 'bottom']}
      footer={
        <Button label="Create a link" icon={Plus} onPress={() => router.push('/send/links/new')} />
      }
    >
      {list ? (
        list.length === 0 ? (
          <EmptyState
            icon={Link2}
            title="No links yet"
            message="Make a link for a party contribution, a sale or rent. Anyone with it can pay you."
          />
        ) : (
          <Card padded={false}>
            {list.map((l) => (
              <LinkRow key={l.id} link={l} onPress={setChosen} />
            ))}
          </Card>
        )
      ) : links.isError ? (
        <ErrorState title="We couldn't load your links" onRetry={() => links.refetch()} />
      ) : (
        <SkeletonGroup accessibilityLabel="Loading payment links">
          <View style={{ gap: spacing[2] }}>
            <SkeletonListItem />
            <SkeletonListItem />
          </View>
        </SkeletonGroup>
      )}

      <View style={{ gap: spacing[2] }}>
        <Text variant="label" color="textMuted">
          Got a link from someone?
        </Text>
        <TextField
          label="Pay link"
          placeholder="Paste a Nem pay link"
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
          label="Open link"
          variant="secondary"
          disabled={!pasted.trim()}
          onPress={() => open(pasted)}
        />
        {isDemo && (
          <View style={[styles.row, { gap: spacing[2] }]}>
            <Text variant="bodySmall" color="textMuted" style={styles.flex}>
              Demo: try a friend&apos;s link.
            </Text>
            <Chip label="Emeka's birthday" icon={Link2} onPress={() => open(DEMO_FRIEND_LINK)} />
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
