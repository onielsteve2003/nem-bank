import { formatMoney } from '@nem/shared';

import {
  ErrorState,
  ListItem,
  Screen,
  SectionHeader,
  Skeleton,
  SkeletonGroup,
  Text,
} from '@/components';
import { isApiError } from '@/data';
import { SendHeader } from '@/features/transfers/components/SendHeader';
import { fromApiMoney } from '@/lib/money';
import { useRepoQuery } from '@/lib/query';

import { categoryMeta, type BillCategory } from '../bills';

/** The billers for one kind of bill, as the biller rail lists them (BILL-4). */
export function BillersScreen({ category }: { category: BillCategory }) {
  const meta = categoryMeta(category);
  const billers = useRepoQuery('bills', 'listBillers', { query: { category } });

  return (
    <Screen header={<SendHeader title={meta.label} />} edges={['top', 'bottom']}>
      {billers.isError ? (
        <ErrorState
          kind={
            isApiError(billers.error) && billers.error.problem.code === 'offline'
              ? 'offline'
              : 'error'
          }
          title="We couldn't load the billers"
          onRetry={() => billers.refetch()}
        />
      ) : !billers.data ? (
        <SkeletonGroup accessibilityLabel="Loading billers">
          <Skeleton height={56} />
          <Skeleton height={56} />
          <Skeleton height={56} />
        </SkeletonGroup>
      ) : (
        <>
          <SectionHeader title="Choose a provider" />
          {billers.data.data.map((b) => (
            <ListItem
              key={b.id}
              leading={meta.icon}
              title={b.name}
              subtitle={
                b.min_amount
                  ? `From ${formatMoney(fromApiMoney(b.min_amount), { trimZeroMinor: true })}`
                  : b.has_products
                    ? 'Choose a plan'
                    : undefined
              }
            />
          ))}
          <Text variant="caption" color="textMuted">
            Billers are simulated: payments complete instantly and no real provider is charged.
          </Text>
        </>
      )}
    </Screen>
  );
}
