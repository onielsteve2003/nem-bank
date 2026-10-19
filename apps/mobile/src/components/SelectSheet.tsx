import { Check, ChevronDown, X, type LucideIcon } from 'lucide-react-native';
import { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import Animated, { SlideInDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { haptic } from '@/lib/haptics';
import { useTheme } from '@/theme';

import { FormField } from './FormField';
import { Icon } from './Icon';
import { IconButton } from './IconButton';
import { useModalFrameStyle } from './modalFrame';
import { Text } from './Text';

export type SelectOption<T extends string> = {
  value: T;
  label: string;
  description?: string;
  icon?: LucideIcon;
};

export type Props<T extends string> = {
  label: string;
  options: readonly SelectOption<T>[];
  value: T | null | undefined;
  onChange: (value: T) => void;
  onBlur?: () => void;
  placeholder?: string;
  help?: string;
  error?: string;
  optional?: boolean;
  disabled?: boolean;
  /** Sheet heading; defaults to the field label. */
  title?: string;
};

/**
 * A field that opens a sheet of options. Built on the core Modal so it works
 * before the shared BottomSheet exists (T2.8); the API stays the same if it moves.
 */
export function SelectSheet<T extends string>({
  label,
  options,
  value,
  onChange,
  onBlur,
  placeholder = 'Select',
  help,
  error,
  optional,
  disabled = false,
  title = label,
}: Props<T>) {
  const { colors, radius, spacing, motion } = useTheme();
  const insets = useSafeAreaInsets();
  const frameStyle = useModalFrameStyle();
  const [open, setOpen] = useState(false);
  const selected = options.find((o) => o.value === value);

  const close = () => {
    setOpen(false);
    onBlur?.();
  };

  const choose = (option: SelectOption<T>) => {
    haptic('selection');
    onChange(option.value);
    close();
  };

  return (
    <FormField label={label} optional={optional} error={error} help={help}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label}, ${selected?.label ?? 'not selected'}`}
        accessibilityHint={error ?? 'Opens a list of options'}
        accessibilityState={{ disabled, expanded: open }}
        disabled={disabled}
        onPress={() => setOpen(true)}
        style={[
          styles.trigger,
          {
            borderRadius: radius.md,
            borderColor: error ? colors.danger : colors.border,
            backgroundColor: colors.raised,
            paddingHorizontal: spacing[4],
            gap: spacing[2],
          },
          error && styles.emphasis,
          disabled && styles.disabled,
        ]}
      >
        {selected?.icon && <Icon icon={selected.icon} color="textMuted" />}
        <Text color={selected ? 'text' : 'textMuted'} style={styles.flex} numberOfLines={1}>
          {selected?.label ?? placeholder}
        </Text>
        <Icon icon={ChevronDown} color="textMuted" />
      </Pressable>

      <Modal visible={open} transparent animationType="fade" onRequestClose={close}>
        <View style={[styles.backdrop, { backgroundColor: colors.overlay }, frameStyle]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close"
            style={StyleSheet.absoluteFill}
            onPress={close}
          />
          <Animated.View
            entering={SlideInDown.duration(motion.duration.base)}
            accessibilityViewIsModal
            style={[
              styles.sheet,
              {
                backgroundColor: colors.surface,
                borderTopLeftRadius: radius.xl,
                borderTopRightRadius: radius.xl,
                paddingBottom: insets.bottom + spacing[4],
              },
            ]}
          >
            <View style={[styles.header, { padding: spacing[4] }]}>
              <Text variant="h3">{title}</Text>
              <IconButton icon={X} accessibilityLabel="Close" variant="ghost" onPress={close} />
            </View>
            <ScrollView contentContainerStyle={{ paddingHorizontal: spacing[2] }}>
              {options.map((option) => {
                const isSelected = option.value === value;
                return (
                  <Pressable
                    key={option.value}
                    accessibilityRole="radio"
                    accessibilityLabel={option.label}
                    accessibilityHint={option.description}
                    accessibilityState={{ checked: isSelected }}
                    onPress={() => choose(option)}
                    style={({ pressed }) => [
                      styles.option,
                      {
                        padding: spacing[3],
                        gap: spacing[3],
                        borderRadius: radius.md,
                        backgroundColor: pressed || isSelected ? colors.raised : 'transparent',
                      },
                    ]}
                  >
                    {option.icon && <Icon icon={option.icon} color="textMuted" />}
                    <View style={styles.flex}>
                      <Text variant={isSelected ? 'bodyStrong' : 'body'}>{option.label}</Text>
                      {option.description && (
                        <Text variant="bodySmall" color="textMuted">
                          {option.description}
                        </Text>
                      )}
                    </View>
                    {isSelected && <Icon icon={Check} color="primaryText" />}
                  </Pressable>
                );
              })}
            </ScrollView>
          </Animated.View>
        </View>
      </Modal>
    </FormField>
  );
}

const styles = StyleSheet.create({
  trigger: { flexDirection: 'row', alignItems: 'center', minHeight: 52, borderWidth: 1 },
  emphasis: { borderWidth: 2 },
  disabled: { opacity: 0.5 },
  flex: { flex: 1 },
  backdrop: { flex: 1, justifyContent: 'flex-end' },
  sheet: { maxHeight: '80%' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  option: { flexDirection: 'row', alignItems: 'center', minHeight: 52 },
});
