import { usePreferencesStore } from '@/stores/preferences';

// Low-data mode (SET-3): charts and photos from the network wait for a tap,
// and paged lists fetch fewer rows at a time. Status polling still runs, since
// it is what tells a customer their money arrived.

/** Rows per page in low-data mode. */
export const LOW_DATA_PAGE_SIZE = 15;

export const useLowData = () => usePreferencesStore((s) => s.lowDataMode);

/** `size` normally; at most LOW_DATA_PAGE_SIZE in low-data mode. */
export function usePageSize(size: number): number {
  return useLowData() ? Math.min(size, LOW_DATA_PAGE_SIZE) : size;
}
