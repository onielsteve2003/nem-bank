import { StyleSheet, View } from 'react-native';

import { Text } from '@/components';
import { formatDateTime } from '@/features/transactions/format';
import { useTheme } from '@/theme';

import type { AssistantBlock, AssistantMessage } from '../assistant';
import { ActionCard } from './ActionCard';
import { ChartBlock } from './ChartBlock';
import { StreamingText } from './StreamingText';
import { TransactionsBlock } from './TransactionsBlock';

/** A tool result inside a reply: a chart, a list, or a payment waiting for you. */
function ToolBlock({ block }: { block: Exclude<AssistantBlock, { type: 'text' }> }) {
  switch (block.type) {
    case 'chart':
      return <ChartBlock block={block} />;
    case 'transactions':
      return <TransactionsBlock block={block} />;
    case 'prepared_action':
      return <ActionCard action={block.action} />;
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
          message.blocks.some((b) => b.type !== 'text') && styles.wide,
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
          return <ToolBlock key={i} block={b} />;
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
  // Cards and charts need the room; a short text reply still hugs its words.
  wide: { width: '85%' },
});
