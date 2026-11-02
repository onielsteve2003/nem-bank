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
import { useTranslation } from 'react-i18next';

type Alert = Schema<'FxAlert'>;

export type Props = {
  onCreate: () => void;
};

/** The customer's rate alerts: waiting ones first, then the ones that fired. */
export function AlertList({ onCreate }: Props) {
  const { spacing } = useTheme();
  const toast = useToast();
  const { t } = useTranslation();
  const alerts = useRepoQuery('fx', 'listAlerts');
  const remove = useRepoMutation('fx', 'deleteAlert', { invalidates: [['fx', 'listAlerts']] });
  const [deleting, setDeleting] = useState<Alert | null>(null);

  if (alerts.isError) {
    return <ErrorState title={t('fx.alerts.failed')} onRetry={() => alerts.refetch()} />;
  }
  if (!alerts.data) {
    return (
      <SkeletonGroup accessibilityLabel={t('fx.alerts.loading')}>
        <Skeleton height={56} />
        <Skeleton height={56} />
      </SkeletonGroup>
    );
  }
  if (alerts.data.data.length === 0) {
    return (
      <EmptyState
        icon={BellRing}
        title={t('fx.alerts.none')}
        message={t('fx.alerts.noneMessage')}
        actionLabel={t('fx.alerts.create')}
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
      toast.show({ message: t('fx.alerts.deleted'), tone: 'success' });
    } catch {
      toast.show({ message: t('common.deleteFailed'), tone: 'error' });
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
              ? t('fx.alerts.reached', { time: formatDateTime(alert.triggered_at) })
              : t('fx.alerts.set', { time: formatDateTime(alert.created_at) })
          }
          trailing={
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing[1] }}>
              {alert.status === 'active' ? (
                <Badge label={t('fx.alerts.watching')} tone="info" />
              ) : (
                <Badge label={t('fx.alerts.reachedBadge')} tone="success" />
              )}
              <IconButton
                icon={Trash2}
                variant="ghost"
                accessibilityLabel={t('fx.alerts.deleteLabel', { alert: alertTitle(alert) })}
                onPress={() => setDeleting(alert)}
              />
            </View>
          }
        />
      ))}
      <Dialog
        open={deleting !== null}
        title={t('fx.alerts.deleteTitle')}
        message={deleting ? alertTitle(deleting) : undefined}
        confirmLabel={t('common.delete')}
        destructive
        loading={remove.isPending}
        onConfirm={confirmDelete}
        onCancel={() => setDeleting(null)}
      />
    </View>
  );
}
