import { Sparkles } from '@/components/icons';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';

import { useTheme } from '@/theme';

import { BottomSheet } from './BottomSheet';
import { Button, touchSlop } from './Button';
import { Icon } from './Icon';
import { Text } from './Text';

const HEIGHT = 24;

export type Props = {
  /** What the AI does here, e.g. "Spending insights". */
  feature: string;
  /** Plain-language explanation shown in the sheet: what data it uses and how it decides. */
  explanation: string;
  /** The non-AI behaviour used when the feature is off or the model is unavailable. */
  fallback: string;
  /** Opens the settings toggle for this feature; the button is hidden without it. */
  onManage?: () => void;
};

/**
 * Marks AI-made content (code-standards: every AI feature carries one). Tapping
 * it explains the feature, its non-AI fallback and where to turn it off.
 */
export function AIBadge({ feature, explanation, fallback, onManage }: Props) {
  const { colors, radius, spacing } = useTheme();
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('components.aiBadge.label', { feature })}
        accessibilityHint={t('components.aiBadge.hint')}
        hitSlop={touchSlop(HEIGHT)}
        onPress={() => setOpen(true)}
        style={({ pressed }) => [
          styles.pill,
          {
            gap: spacing[1],
            paddingHorizontal: spacing[2],
            borderRadius: radius.pill,
            borderColor: colors.primaryText,
            backgroundColor: pressed ? colors.raised : 'transparent',
          },
        ]}
      >
        <Icon icon={Sparkles} size="sm" color="primaryText" />
        <Text variant="caption" color="primaryText" maxFontSizeMultiplier={1.4}>
          AI
        </Text>
      </Pressable>

      <BottomSheet open={open} onClose={() => setOpen(false)} title={feature}>
        <Section heading={t('components.aiBadge.how')} body={explanation} />
        <Section heading={t('components.aiBadge.without')} body={fallback} />
        <Text variant="bodySmall" color="textMuted">
          {t('components.aiBadge.note')}
        </Text>
        {onManage && (
          <Button
            label={t('components.aiBadge.manage')}
            variant="secondary"
            fullWidth
            onPress={() => {
              setOpen(false);
              onManage();
            }}
          />
        )}
      </BottomSheet>
    </>
  );
}

function Section({ heading, body }: { heading: string; body: string }) {
  const { spacing } = useTheme();
  return (
    <View style={{ gap: spacing[1] }}>
      <Text variant="label" color="textMuted">
        {heading}
      </Text>
      <Text variant="body">{body}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    minHeight: HEIGHT,
    borderWidth: 1,
  },
});
