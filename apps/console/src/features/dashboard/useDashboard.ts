import { keepPreviousData, useQuery } from '@tanstack/react-query';

import { useRepositories } from '@/data/provider';
import { lagosDate, shiftDate } from '@/lib/dates';

export const PERIODS = [
  { days: 7, label: 'Last 7 days' },
  { days: 30, label: 'Last 30 days' },
  { days: 90, label: 'Last 90 days' },
] as const;

export type PeriodDays = (typeof PERIODS)[number]['days'];

/** Inclusive Lagos calendar dates ending today. */
export function periodRange(days: PeriodDays, nowMs = Date.now()) {
  const to = lagosDate(nowMs);
  return { from: shiftDate(to, -(days - 1)), to };
}

export function useDashboard(days: PeriodDays) {
  const { dashboard } = useRepositories();
  const query = periodRange(days);
  return useQuery({
    queryKey: ['dashboard', query],
    queryFn: ({ signal }) => dashboard.get({ query }, { signal }),
    // Keep the old figures on screen while a new period loads, instead of a skeleton flash.
    placeholderData: keepPreviousData,
  });
}
