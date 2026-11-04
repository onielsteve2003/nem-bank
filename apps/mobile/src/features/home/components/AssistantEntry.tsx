import { ChevronRight, Sparkles } from '@/components/icons';
import { StyleSheet, View } from 'react-native';

import { AIBadge, Card, Icon, Text } from '@/components';
import { useTheme } from '@/theme';
import { useTranslation } from 'react-i18next';

/**
 * The way into Nem Assistant (AI-6). It answers questions about your money and
 * can *prepare* a payment, which you then confirm with your PIN. Hidden when
 * the assistant is turned off in AI settings; everything it does can also be
 * done by hand.
 */
export function AssistantEntry({ onOpen, onManage }: { onOpen: () => void; onManage: () => void }) {
  const { colors, spacing, radius } = useTheme();
  const { t } = useTranslation();
  return (
    <View style={{ gap: spacing[2], marginHorizontal: spacing[4] }}>
      <Card
        variant="surface"
        onPress={onOpen}
        accessibilityLabel={t('home.assistant.label')}
        accessibilityHint={t('home.assistant.hint')}
      >
        <View style={[styles.row, { gap: spacing[3] }]}>
          <View style={[styles.icon, { backgroundColor: colors.raised, borderRadius: radius.md }]}>
            <Icon icon={Sparkles} size="md" color="primaryText" />
          </View>
          <View style={[styles.flex, { gap: spacing[1] }]}>
            <Text variant="bodyStrong">{t('home.assistant.title')}</Text>
            <Text variant="caption" color="textMuted">
              {t('home.assistant.example')}
            </Text>
          </View>
          <Icon icon={ChevronRight} size="sm" color="textMuted" />
        </View>
      </Card>
      <View style={styles.badge}>
        <AIBadge
          feature={t('home.assistant.feature')}
          explanation={t('home.assistant.explanation')}
          fallback={t('home.assistant.fallback')}
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
