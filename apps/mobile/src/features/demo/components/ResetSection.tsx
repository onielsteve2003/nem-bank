import { useQueryClient } from '@tanstack/react-query';
import { Trash2 } from '@/components/icons';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button, Dialog, useToast } from '@/components';
import { useRepositories } from '@/data';
import { useRestartDemo } from '@/features/auth/hooks/useSessionActions';
import { env } from '@/lib/env';

import { DemoSection } from './DemoSection';

/** Starts the demo persona over: six months of history, fresh balances, the clock back to today. */
export function ResetSection() {
  const repos = useRepositories();
  const restartDemo = useRestartDemo();
  const client = useQueryClient();
  const toast = useToast();
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const [resetting, setResetting] = useState(false);

  const reset = async () => {
    setResetting(true);
    try {
      // The real bank cannot rewind a ledger: it starts a fresh customer instead.
      if (env.apiMode === 'http') await restartDemo();
      else await repos.demo.reset();
      // Every cached read describes the old world.
      await client.resetQueries();
      setConfirming(false);
      toast.show({ message: t('demo.reset.done'), tone: 'success' });
    } catch {
      toast.show({ message: t('demo.reset.failed'), tone: 'error' });
    } finally {
      setResetting(false);
    }
  };

  return (
    <DemoSection title={t('demo.reset.title')} description={t('demo.reset.description')}>
      <Button
        label={t('demo.reset.button')}
        icon={Trash2}
        variant="danger"
        onPress={() => setConfirming(true)}
      />
      <Dialog
        open={confirming}
        title={t('demo.reset.confirmTitle')}
        message={t('demo.reset.confirmMessage')}
        confirmLabel={t('common.reset')}
        destructive
        loading={resetting}
        onConfirm={() => void reset()}
        onCancel={() => setConfirming(false)}
      />
    </DemoSection>
  );
}
