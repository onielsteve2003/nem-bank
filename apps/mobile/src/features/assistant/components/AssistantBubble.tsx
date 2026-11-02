import { StyleSheet, View } from 'react-native';

import { Text } from '@/components';
import { formatDateTime } from '@/features/transactions/format';
import { useTheme } from '@/theme';

import type { AssistantBlock, AssistantMessage } from '../assistant';
import { StreamingText } from './StreamingText';

/** A one-line stand-in for a block that is not text (charts, lists, prepared payments). */
export function blockLine(b: AssistantBlock): string | null {
  switch (b.type) {
    case 'text':
      return null;
    case 'chart':
      return b.title;
    case 'transactions':
      return b.transactions.length === 1
        ? '1 transaction'
        : `${b.transactions.length} transactions`;
    case 'prepared_action':
      return b.action.summary;
  }
}

type Props = {
  message: AssistantMessage;
  /** Types the reply out; only the reply that just arrived streams. */
  stream?: boolean;
};

/** One message in the assistant chat. */
export function AssistantBubble({ message, stream = false }: Props) {
  const { colors, radius, spacing } = useTheme();
  const mine = message.role === 'user';
  const fg = mine ? { color: colors.onPrimary } : undefined;

  return (
    <View style={[styles.row, mine && styles.mine]}>
      <View
        style={[
          styles.bubble,
          {
            backgroundColor: mine ? colors.primary : colors.raised,
            borderRadius: radius.lg,
            padding: spacing[3],
            gap: spacing[2],
          },
        ]}
      >
        {!mine && (
          <Text variant="caption" color="textMuted">
            Nem Assistant
          </Text>
        )}
        {message.blocks.map((b, i) => {
          if (b.type === 'text') {
            return stream && !mine ? (
              <StreamingText key={i} text={b.text} />
            ) : (
              <Text key={i} variant="body" style={fg} selectable>
                {b.text}
              </Text>
            );
          }
          return (
            <View
              key={i}
              style={[
                styles.block,
                { borderColor: colors.border, borderRadius: radius.md, padding: spacing[2] },
              ]}
            >
              <Text variant="bodySmall">{blockLine(b)}</Text>
            </View>
          );
        })}
        <Text
          variant="caption"
          style={{ color: mine ? colors.onPrimary : colors.textMuted, opacity: mine ? 0.7 : 1 }}
        >
          {formatDateTime(message.created_at)}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row' },
  mine: { justifyContent: 'flex-end' },
  bubble: { maxWidth: '85%' },
  block: { borderWidth: StyleSheet.hairlineWidth },
});
