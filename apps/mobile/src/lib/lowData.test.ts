import { act, renderHook } from '@testing-library/react-native';
import { useReducedMotion } from 'react-native-reanimated';

import { toQuery, NO_FILTERS, PAGE_SIZE } from '@/features/transactions/filters';
import { DEFAULT_PREFERENCES, usePreferencesStore } from '@/stores';

import { LOW_DATA_PAGE_SIZE, usePageSize } from './lowData';
import { useReduceMotion } from './motion';

jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  ...jest.requireActual('react-native-reanimated'),
  useReducedMotion: jest.fn(() => false),
}));

afterEach(() => {
  usePreferencesStore.setState({ ...DEFAULT_PREFERENCES, reduceMotion: 'system' });
});

describe('usePageSize', () => {
  it('fetches fewer rows per page in low-data mode, never more than asked', async () => {
    const { result, rerender } = await renderHook(
      ({ size }: { size: number }) => usePageSize(size),
      {
        initialProps: { size: PAGE_SIZE },
      },
    );
    expect(result.current).toBe(PAGE_SIZE);
    await act(() => usePreferencesStore.setState({ lowDataMode: true }));
    expect(result.current).toBe(LOW_DATA_PAGE_SIZE);
    await rerender({ size: 5 });
    expect(result.current).toBe(5);
  });

  it('passes the page size into the transactions query', () => {
    expect(toQuery(NO_FILTERS, new Date(), LOW_DATA_PAGE_SIZE)).toEqual({ limit: 15 });
  });
});

describe('useReduceMotion', () => {
  it("follows the phone, and Always reduce wins over the phone's setting", async () => {
    const { result } = await renderHook(() => useReduceMotion());
    expect(result.current).toBe(false);
    await act(() => usePreferencesStore.setState({ reduceMotion: 'always' }));
    expect(result.current).toBe(true);

    jest.mocked(useReducedMotion).mockReturnValue(true);
    await act(() => usePreferencesStore.setState({ reduceMotion: 'system' }));
    expect(result.current).toBe(true);
  });
});
