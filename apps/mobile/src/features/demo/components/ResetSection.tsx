import { useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react-native';
import { useState } from 'react';

import { Button, Dialog, useToast } from '@/components';
import { useRepositories } from '@/data';

import { DemoSection } from './DemoSection';

/** Starts the demo persona over: six months of history, fresh balances, the clock back to today. */
export function ResetSection() {
  const repos = useRepositories();
  const client = useQueryClient();
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const [resetting, setResetting] = useState(false);

  const reset = async () => {
    setResetting(true);
    try {
      await repos.demo.reset();
      // Every cached read describes the old world.
      await client.resetQueries();
      setConfirming(false);
      toast.show({ message: 'Demo data reset', tone: 'success' });
    } catch {
      toast.show({ message: 'Could not reset the demo. Try again.', tone: 'error' });
    } finally {
      setResetting(false);
    }
  };

  return (
    <DemoSection
      title="Start over"
      description="Re-creates the demo account with its original history and balances."
    >
      <Button
        label="Reset demo data"
        icon={Trash2}
        variant="danger"
        onPress={() => setConfirming(true)}
      />
      <Dialog
        open={confirming}
        title="Reset the demo?"
        message="Everything you did in the demo is wiped: transfers, cards, savings and ajo groups."
        confirmLabel="Reset"
        destructive
        loading={resetting}
        onConfirm={() => void reset()}
        onCancel={() => setConfirming(false)}
      />
    </DemoSection>
  );
}
