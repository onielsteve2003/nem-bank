import { ChevronRight, Sparkles } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';

import { AIBadge, Card, Icon, Text } from '@/components';
import { useTheme } from '@/theme';

/**
 * The way into Nem Assistant (AI-6). It answers questions about your money and
 * can *prepare* a payment, which you then confirm with your PIN. Hidden when
 * the assistant is turned off in AI settings; everything it does can also be
 * done by hand.
 */
export function AssistantEntry({ onOpen, onManage }: { onOpen: () => void; onManage: () => void }) {
  const { colors, spacing, radius } = useTheme();
  return (
    <View style={{ gap: spacing[2], marginHorizontal: spacing[4] }}>
      <Card
        variant="surface"
        onPress={onOpen}
        accessibilityLabel="Ask Nem Assistant. For example, how much did I spend on food in September?"
        accessibilityHint="Opens the assistant"
      >
        <View style={[styles.row, { gap: spacing[3] }]}>
          <View style={[styles.icon, { backgroundColor: colors.raised, borderRadius: radius.md }]}>
            <Icon icon={Sparkles} size="md" color="primaryText" />
          </View>
          <View style={[styles.flex, { gap: spacing[1] }]}>
            <Text variant="bodyStrong">Ask Nem Assistant</Text>
            <Text variant="caption" color="textMuted">
              “How much did I spend on food in September?”
            </Text>
          </View>
          <Icon icon={ChevronRight} size="sm" color="textMuted" />
        </View>
      </Card>
      <View style={styles.badge}>
        <AIBadge
          feature="Nem Assistant"
          explanation="Answers questions about your accounts and can prepare a payment for you to check. It never moves money by itself: you confirm every payment with your PIN or Face ID. Names and account numbers are removed before anything reaches the AI model."
          fallback="Everything the assistant does can be done from the app’s own screens."
          onManage={onManage}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  icon: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  flex: { flex: 1 },
  badge: { alignSelf: 'flex-start' },
});
