import type { Schema } from '@nem/contracts';
import { BellRing, Trash2 } from 'lucide-react-native';
import { useState } from 'react';
import { View } from 'react-native';

import {
  Badge,
  Dialog,
  EmptyState,
  ErrorState,
  IconButton,
  ListItem,
  Skeleton,
  SkeletonGroup,
  useToast,
} from '@/components';
import { formatDateTime } from '@/features/transactions/format';
import { useRepoMutation, useRepoQuery } from '@/lib/query';
import { useTheme } from '@/theme';

import { alertTitle } from '../rates';

type Alert = Schema<'FxAlert'>;

export type Props = {
  onCreate: () => void;
};

/** The customer's rate alerts: waiting ones first, then the ones that fired. */
export function AlertList({ onCreate }: Props) {
  const { spacing } = useTheme();
  const toast = useToast();
  const alerts = useRepoQuery('fx', 'listAlerts');
  const remove = useRepoMutation('fx', 'deleteAlert', { invalidates: [['fx', 'listAlerts']] });
  const [deleting, setDeleting] = useState<Alert | null>(null);

  if (alerts.isError) {
    return <ErrorState title="We couldn't load your alerts" onRetry={() => alerts.refetch()} />;
  }
  if (!alerts.data) {
    return (
      <SkeletonGroup accessibilityLabel="Loading your alerts">
        <Skeleton height={56} />
        <Skeleton height={56} />
      </SkeletonGroup>
    );
  }
  if (alerts.data.data.length === 0) {
    return (
      <EmptyState
        icon={BellRing}
        title="No rate alerts yet"
        message="Get a notification when a rate goes above or below a number you pick."
        actionLabel="Create an alert"
        onAction={onCreate}
      />
    );
  }

  const sorted = [...alerts.data.data].sort(
    (a, b) => Number(b.status === 'active') - Number(a.status === 'active'),
  );

  const confirmDelete = async () => {
    if (!deleting) return;
    try {
      await remove.mutateAsync({ path: { alert_id: deleting.id } });
      toast.show({ message: 'Alert deleted', tone: 'success' });
    } catch {
      toast.show({ message: "We couldn't delete it. Try again.", tone: 'error' });
    }
    setDeleting(null);
  };

  return (
    <View style={{ gap: spacing[1] }}>
      {sorted.map((alert) => (
        <ListItem
          key={alert.id}
          leading={BellRing}
          title={alertTitle(alert)}
          subtitle={
            alert.status === 'triggered' && alert.triggered_at
              ? `Reached ${formatDateTime(alert.triggered_at)}`
              : `Set ${formatDateTime(alert.created_at)}`
          }
          trailing={
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing[1] }}>
              {alert.status === 'active' ? (
                <Badge label="Watching" tone="info" />
              ) : (
                <Badge label="Reached" tone="success" />
              )}
              <IconButton
                icon={Trash2}
                variant="ghost"
                accessibilityLabel={`Delete alert: ${alertTitle(alert)}`}
                onPress={() => setDeleting(alert)}
              />
            </View>
          }
        />
      ))}
      <Dialog
        open={deleting !== null}
        title="Delete this alert?"
        message={deleting ? alertTitle(deleting) : undefined}
        confirmLabel="Delete"
        destructive
        loading={remove.isPending}
        onConfirm={confirmDelete}
        onCancel={() => setDeleting(null)}
      />
    </View>
  );
}
