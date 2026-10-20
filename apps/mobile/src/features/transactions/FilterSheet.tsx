import { CURRENCY_CODES } from '@nem/shared';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { BottomSheet, Button, Chip, Text } from '@/components';
import { useTheme } from '@/theme';

import {
  DATE_RANGES,
  NO_FILTERS,
  STATUS_LABELS,
  TYPE_GROUPS,
  type DateRange,
  type TransactionFilters,
  type TransactionStatus,
  type TypeGroup,
} from './filters';

const entries = <K extends string, V>(o: Record<K, V>) => Object.entries(o) as [K, V][];

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  const { spacing } = useTheme();
  return (
    <View style={{ gap: spacing[2] }}>
      <Text variant="label" color="textMuted">
        {title}
      </Text>
      <View style={[styles.wrap, { gap: spacing[2] }]}>{children}</View>
    </View>
  );
}

/**
 * Type, currency, status and date filters (ACC-5). Choices are drafted here and
 * applied together with "Show results", so the list does not reload per tap.
 */
export function FilterSheet({
  open,
  value,
  onApply,
  onClose,
}: {
  open: boolean;
  value: TransactionFilters;
  onApply: (filters: TransactionFilters) => void;
  onClose: () => void;
}) {
  const { spacing } = useTheme();
  const [draft, setDraft] = useState(value);
  const set = (patch: Partial<TransactionFilters>) => setDraft((d) => ({ ...d, ...patch }));
  const toggleType = (g: TypeGroup) =>
    set({
      types: draft.types.includes(g) ? draft.types.filter((t) => t !== g) : [...draft.types, g],
    });

  return (
    <BottomSheet open={open} onClose={onClose} title="Filter transactions">
      <View style={{ gap: spacing[5] }}>
        <Group title="Type">
          {entries(TYPE_GROUPS).map(([key, group]) => (
            <Chip
              key={key}
              label={group.label}
              selected={draft.types.includes(key)}
              onPress={() => toggleType(key)}
            />
          ))}
        </Group>
        <Group title="Currency">
          {CURRENCY_CODES.map((code) => (
            <Chip
              key={code}
              label={code}
              selected={draft.currency === code}
              onPress={() => set({ currency: draft.currency === code ? null : code })}
            />
          ))}
        </Group>
        <Group title="Status">
          {entries(STATUS_LABELS).map(([status, label]) => (
            <Chip
              key={status}
              label={label}
              selected={draft.status === status}
              onPress={() =>
                set({ status: draft.status === status ? null : (status as TransactionStatus) })
              }
            />
          ))}
        </Group>
        <Group title="Date">
          {entries(DATE_RANGES).map(([range, label]) => (
            <Chip
              key={range}
              label={label}
              selected={draft.range === range}
              onPress={() => set({ range: draft.range === range ? null : (range as DateRange) })}
            />
          ))}
        </Group>
        <View style={[styles.row, { gap: spacing[3] }]}>
          <Button
            label="Clear all"
            variant="secondary"
            style={styles.flex}
            onPress={() => setDraft({ ...NO_FILTERS, search: draft.search })}
          />
          <Button label="Show results" style={styles.flex} onPress={() => onApply(draft)} />
        </View>
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', flexWrap: 'wrap' },
  row: { flexDirection: 'row' },
  flex: { flex: 1 },
});
