import { formatMoney } from '@nem/shared';
import { useRouter } from 'expo-router';
import type { Schema } from '@nem/contracts';
import { CalendarClock, Receipt, Trash2 } from 'lucide-react-native';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  Card,
  Dialog,
  EmptyState,
  ErrorState,
  Icon,
  IconButton,
  ListItem,
  PressableScale,
  Screen,
  SectionHeader,
  Skeleton,
  SkeletonGroup,
  StatusPill,
  Text,
} from '@/components';
import { SendHeader } from '@/features/transfers/components/SendHeader';
import { fromApiMoney } from '@/lib/money';
import { useRepoMutation, useRepoQuery } from '@/lib/query';
import { useTheme } from '@/theme';

import { BILL_CATEGORIES, categoryMeta, CUSTOMER_LABEL, shortDate } from '../bills';

const RECENT = 5;

/**
 * Bills hub (FR-BILL): airtime, data, electricity and cable TV, the billers the
 * customer saved, and their latest bill payments with how each went.
 */
export function BillsHubScreen() {
  const router = useRouter();
  const { colors, radius, spacing } = useTheme();
  const saved = useRepoQuery('bills', 'listSaved');
  const payments = useRepoQuery('bills', 'listPayments', { query: { limit: RECENT } });
  const recent = payments.data?.data.slice(0, RECENT) ?? [];
  const schedules = useRepoQuery('bills', 'listSchedules');
  const upcoming = schedules.data?.data.filter((s) => s.status === 'active').length ?? 0;
  const [removing, setRemoving] = useState<Schema<'SavedBiller'> | null>(null);
  const remove = useRepoMutation('bills', 'removeSaved', { invalidates: [['bills']] });

  return (
    <Screen
      header={<SendHeader title="Pay bills" first />}
      edges={['top', 'bottom']}
      onRefresh={() => void Promise.all([saved.refetch(), payments.refetch()])}
      refreshing={saved.isRefetching || payments.isRefetching}
    >
      <View accessibilityRole="list" style={[styles.grid, { gap: spacing[3] }]}>
        {BILL_CATEGORIES.map((c) => (
          <PressableScale
            key={c.value}
            accessibilityRole="button"
            accessibilityLabel={`${c.label}. ${c.description}`}
            onPress={() => router.push(`/bills/${c.value}`)}
            style={[
              styles.tile,
              { backgroundColor: colors.surface, borderRadius: radius.lg, padding: spacing[4] },
            ]}
          >
            <View
              style={[styles.icon, { backgroundColor: colors.raised, borderRadius: radius.pill }]}
            >
              <Icon icon={c.icon} color="primary" />
            </View>
            <Text variant="bodyStrong">{c.label}</Text>
            <Text variant="caption" color="textMuted">
              {c.description}
            </Text>
          </PressableScale>
        ))}
      </View>

      {saved.data && saved.data.data.length > 0 && (
        <View>
          <SectionHeader title="Saved billers" />
          {saved.data.data.map((s) => (
            <ListItem
              key={s.id}
              leading={categoryMeta(s.category).icon}
              title={s.nickname}
              subtitle={`${s.biller_name} · ${s.customer_id}`}
              accessibilityHint="Pay this bill with the details filled in"
              onPress={() =>
                router.push({
                  pathname: '/bills/[category]',
                  params: { category: s.category, biller: s.biller_id, customer: s.customer_id },
                })
              }
              trailing={
                <IconButton
                  icon={Trash2}
                  variant="ghost"
                  accessibilityLabel={`Remove ${s.nickname}`}
                  onPress={() => setRemoving(s)}
                />
              }
            />
          ))}
        </View>
      )}

      <Card padded={false}>
        <ListItem
          leading={CalendarClock}
          title="Scheduled bills"
          subtitle={
            upcoming > 0 ? `${upcoming} coming up` : 'Pay a bill later, or every day, week or month'
          }
          onPress={() => router.push('/bills/scheduled')}
        />
      </Card>

      <View>
        <SectionHeader title="Recent bills" />
        {payments.isError ? (
          <ErrorState title="We couldn't load your bills" onRetry={() => payments.refetch()} />
        ) : !payments.data ? (
          <SkeletonGroup accessibilityLabel="Loading bills">
            <Skeleton height={56} />
            <Skeleton height={56} />
          </SkeletonGroup>
        ) : recent.length === 0 ? (
          <EmptyState
            icon={Receipt}
            title="No bills yet"
            message="Airtime, data, power and TV you pay for show up here."
          />
        ) : (
          recent.map((p) => (
            <ListItem
              key={p.id}
              leading={categoryMeta(p.category).icon}
              title={p.product_name ? `${p.biller_name} · ${p.product_name}` : p.biller_name}
              subtitle={`${CUSTOMER_LABEL[p.category]} ${p.customer_id} · ${shortDate(p.created_at)}`}
              trailing={
                <View style={[styles.end, { gap: spacing[1] }]}>
                  <Text variant="bodyStrong">{formatMoney(fromApiMoney(p.amount))}</Text>
                  {p.status !== 'completed' && <StatusPill status={p.status} />}
                </View>
              }
            />
          ))
        )}
      </View>

      <Dialog
        open={removing !== null}
        title={`Remove ${removing?.nickname ?? 'this biller'}?`}
        message="You can save it again the next time you pay it."
        confirmLabel="Remove"
        destructive
        loading={remove.isPending}
        onCancel={() => setRemoving(null)}
        onConfirm={() =>
          removing &&
          remove.mutate(
            { path: { saved_biller_id: removing.id } },
            { onSettled: () => setRemoving(null) },
          )
        }
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  tile: { flexBasis: '47%', flexGrow: 1, gap: 6, minHeight: 120 },
  icon: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center', marginBottom: 4 },
  end: { alignItems: 'flex-end' },
});
