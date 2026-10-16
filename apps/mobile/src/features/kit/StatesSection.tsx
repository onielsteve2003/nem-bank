import { Inbox } from 'lucide-react-native';
import { useState } from 'react';

import {
  Card,
  EmptyState,
  ErrorState,
  ListItem,
  Skeleton,
  SkeletonGroup,
  SkeletonListItem,
  useToast,
} from '@/components';

import { KitSection } from './KitSection';

type Phase = 'loading' | 'error' | 'success';

export function StatesSection() {
  const toast = useToast();
  const [phase, setPhase] = useState<Phase>('loading');

  // Simulates a flaky request: the first retry fails, the second succeeds.
  const [attempts, setAttempts] = useState(0);
  const retry = () =>
    new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        setAttempts((n) => n + 1);
        if (attempts === 0) {
          toast.show({ message: 'Still failing. Try once more.', tone: 'error' });
          reject(new Error('flaky'));
        } else {
          setPhase('success');
          resolve();
        }
      }, 900);
    });

  return (
    <KitSection title="Loading, empty and error">
      <Card padded={false}>
        {phase === 'loading' && (
          <SkeletonGroup accessibilityLabel="Loading transactions">
            <SkeletonListItem />
            <SkeletonListItem />
            <SkeletonListItem />
          </SkeletonGroup>
        )}
        {phase === 'error' && <ErrorState onRetry={retry} />}
        {phase === 'success' && <ListItem title="Loaded" subtitle="Retry worked" trailing="✓" />}
      </Card>
      <ListItem
        title={phase === 'loading' ? 'Fail the load' : 'Reset to loading'}
        onPress={() => {
          setAttempts(0);
          setPhase(phase === 'loading' ? 'error' : 'loading');
        }}
      />
      <SkeletonGroup>
        <Skeleton width="70%" height={28} />
        <Skeleton height={120} />
      </SkeletonGroup>
      <Card>
        <EmptyState
          icon={Inbox}
          title="No transactions yet"
          message="Money you send and receive shows up here."
          actionLabel="Add money"
          onAction={() => toast.show({ message: 'Add money opens in M7' })}
        />
      </Card>
      <Card>
        <ErrorState kind="offline" onRetry={() => new Promise((r) => setTimeout(r, 900))} />
      </Card>
    </KitSection>
  );
}
