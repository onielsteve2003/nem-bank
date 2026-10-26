import type { Schema } from '@nem/contracts';
import { formatMoney } from '@nem/shared';
import { useRouter, type Href } from 'expo-router';
import {
  ArrowUpRight,
  CalendarClock,
  HandCoins,
  Link2,
  Receipt,
  ScanLine,
  Split,
  type LucideIcon,
} from 'lucide-react-native';
import { ScrollView, StyleSheet, View } from 'react-native';

import {
  Avatar,
  Card,
  Icon,
  ListItem,
  PressableScale,
  Screen,
  SectionHeader,
  Text,
} from '@/components';
import { haptic } from '@/lib/haptics';
import { fromApiMoney } from '@/lib/money';
import { useRepoQuery } from '@/lib/query';
import { useTheme } from '@/theme';

import { beneficiaryTitle } from '../beneficiaries';
import { counterpartOf, requestSubtitle, sortRequests } from '../requests';
import { isLive, scheduleSubtitle, sortSchedules } from '../schedule';
import { recipientFromBeneficiary, useSendDraft } from '../sendDraft';

type Beneficiary = Schema<'Beneficiary'>;

const ACTIONS: readonly { label: string; icon: LucideIcon; href: Href }[] = [
  { label: 'Send', icon: ArrowUpRight, href: '/send' },
  { label: 'Scan QR', icon: ScanLine, href: '/qr' },
  { label: 'Request', icon: HandCoins, href: '/send/request' },
  { label: 'Split', icon: Split, href: '/send/splits' },
  { label: 'Links', icon: Link2, href: '/send/links' },
  { label: 'Scheduled', icon: CalendarClock, href: '/send/scheduled' },
];

const RECENT_PEOPLE = 8;
const PREVIEW = 3;

/** Saved people, the most recently paid first. */
export const recentRecipients = (list: Beneficiary[] | undefined, max = RECENT_PEOPLE) =>
  [...(list ?? [])]
    .sort((a, b) => (b.last_paid_at ?? '').localeCompare(a.last_paid_at ?? ''))
    .slice(0, max);

/**
 * The Pay tab (PRD §8): every way to move money one tap away, bills, the
 * people paid lately, requests waiting on the customer and what goes out next.
 */
export function PayScreen() {
  const router = useRouter();
  const { colors, spacing } = useTheme();
  const setRecipient = useSendDraft((s) => s.setRecipient);

  const beneficiaries = useRepoQuery('beneficiaries', 'list', { query: { limit: 50 } });
  const incoming = useRepoQuery('moneyRequests', 'list', {
    query: { direction: 'incoming', status: 'pending', limit: 50 },
  });
  const schedules = useRepoQuery('transfers', 'listScheduled', { query: { limit: 100 } });

  const people = recentRecipients(beneficiaries.data?.data);
  const requests = sortRequests(incoming.data?.data ?? []);
  const upcoming = sortSchedules(schedules.data?.data ?? []).filter(isLive);

  const pay = (b: Beneficiary) => {
    setRecipient(recipientFromBeneficiary(b));
    router.push('/send/amount');
  };

  const header = (
    <View style={{ paddingHorizontal: spacing[4] }}>
      <Text variant="title" accessibilityRole="header">
        Pay
      </Text>
    </View>
  );

  return (
    <Screen
      header={header}
      edges={['top']}
      onRefresh={() =>
        void Promise.all([beneficiaries.refetch(), incoming.refetch(), schedules.refetch()])
      }
      refreshing={beneficiaries.isRefetching || incoming.isRefetching || schedules.isRefetching}
    >
      <View accessibilityRole="list" style={[styles.grid, { rowGap: spacing[4] }]}>
        {ACTIONS.map((a, i) => (
          <PressableScale
            key={a.label}
            accessibilityRole="button"
            accessibilityLabel={a.label}
            onPress={() => {
              haptic('tap');
              router.push(a.href);
            }}
            style={[styles.action, { gap: spacing[1] }]}
          >
            <View
              style={[
                styles.circle,
                {
                  backgroundColor: i === 0 ? colors.primary : colors.raised,
                  borderColor: colors.border,
                  borderWidth: i === 0 ? 0 : StyleSheet.hairlineWidth,
                },
              ]}
            >
              <Icon icon={a.icon} size="md" color={i === 0 ? 'onPrimary' : 'text'} />
            </View>
            <Text variant="caption" color="textMuted" numberOfLines={1}>
              {a.label}
            </Text>
          </PressableScale>
        ))}
      </View>

      <Card padded={false}>
        <ListItem
          leading={Receipt}
          title="Pay bills"
          subtitle="Airtime, data, electricity and cable TV"
          showChevron
          onPress={() => router.push('/bills')}
        />
      </Card>

      {people.length > 0 && (
        <View>
          <SectionHeader
            title="Recent"
            actionLabel="All"
            onAction={() => router.push('/send/beneficiaries')}
          />
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: spacing[4] }}
          >
            {people.map((b) => {
              const name = beneficiaryTitle(b);
              return (
                <PressableScale
                  key={b.id}
                  accessibilityRole="button"
                  accessibilityLabel={`Pay ${name}`}
                  onPress={() => pay(b)}
                  style={[styles.person, { gap: spacing[1] }]}
                >
                  <Avatar name={name} size="lg" ring={b.kind === 'nem'} />
                  <Text variant="caption" numberOfLines={1}>
                    {name.split(' ')[0]}
                  </Text>
                </PressableScale>
              );
            })}
          </ScrollView>
        </View>
      )}

      {requests.length > 0 && (
        <View>
          <SectionHeader
            title="Waiting for you"
            actionLabel={requests.length > PREVIEW ? `All ${requests.length}` : undefined}
            onAction={() => router.push('/send/requests')}
          />
          <Card padded={false}>
            {requests.slice(0, PREVIEW).map((r) => {
              const other = counterpartOf(r);
              return (
                <ListItem
                  key={r.id}
                  leading={<Avatar name={other.name} size="md" ring />}
                  title={other.name}
                  subtitle={requestSubtitle(r)}
                  trailing={<Text variant="bodyStrong">{formatMoney(fromApiMoney(r.amount))}</Text>}
                  onPress={() => router.push('/send/requests')}
                />
              );
            })}
          </Card>
        </View>
      )}

      {upcoming.length > 0 && (
        <View>
          <SectionHeader
            title="Coming up"
            actionLabel="All"
            onAction={() => router.push('/send/scheduled')}
          />
          <Card padded={false}>
            {upcoming.slice(0, PREVIEW).map((s) => (
              <ListItem
                key={s.id}
                leading={
                  <Avatar name={s.recipient.name} size="md" ring={Boolean(s.recipient.nemtag)} />
                }
                title={s.recipient.name}
                subtitle={scheduleSubtitle(s)}
                trailing={<Text variant="bodyStrong">{formatMoney(fromApiMoney(s.amount))}</Text>}
                onPress={() => router.push('/send/scheduled')}
              />
            ))}
          </Card>
        </View>
      )}
    </Screen>
  );
}

const BUTTON = 52;

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  action: { alignItems: 'center', width: '33.33%' },
  circle: {
    width: BUTTON,
    height: BUTTON,
    borderRadius: BUTTON / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  person: { alignItems: 'center', width: 64 },
});
