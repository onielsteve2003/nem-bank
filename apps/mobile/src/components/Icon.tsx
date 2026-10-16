import type { ColorTokens } from '@nem/shared';
import type { LucideIcon } from 'lucide-react-native';

import { useTheme } from '@/theme';

export const ICON_SIZE = { sm: 16, md: 20, lg: 24, xl: 32 } as const;

export type Props = {
  /** A lucide icon component, e.g. `ArrowUpRight`. Passing the component keeps unused icons out of the bundle. */
  icon: LucideIcon;
  size?: keyof typeof ICON_SIZE;
  color?: keyof ColorTokens;
  strokeWidth?: number;
  /** Set it when the icon carries meaning on its own; without it the icon is decorative and hidden from screen readers. */
  accessibilityLabel?: string;
};

export function Icon({
  icon: Glyph,
  size = 'md',
  color = 'text',
  strokeWidth = 2,
  accessibilityLabel,
}: Props) {
  const { colors } = useTheme();
  const labelled = accessibilityLabel !== undefined;

  // lucide marks an icon aria-hidden unless it receives an aria-* prop, so the
  // label goes through aria-label (accessibilityLabel alone stays hidden on web).
  return (
    <Glyph
      size={ICON_SIZE[size]}
      color={colors[color]}
      strokeWidth={strokeWidth}
      accessible={labelled}
      role={labelled ? 'img' : undefined}
      aria-label={accessibilityLabel}
      aria-hidden={!labelled}
      importantForAccessibility={labelled ? 'yes' : 'no-hide-descendants'}
    />
  );
}
