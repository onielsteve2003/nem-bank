import { Image } from 'expo-image';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useTheme } from '@/theme';

import { avatarInitials } from './avatarInitials';
import { Text } from './Text';

export type AvatarSize = 'sm' | 'md' | 'lg' | 'xl';

const DIAMETER: Record<AvatarSize, number> = { sm: 32, md: 40, lg: 56, xl: 80 };
const INITIALS_VARIANT = { sm: 'caption', md: 'label', lg: 'title', xl: 'h2' } as const;

export type Props = {
  /** Used for the initials fallback and the accessibility label. */
  name: string;
  uri?: string;
  size?: AvatarSize;
  /** Draws a brand ring, e.g. around a verified Nem user. */
  ring?: boolean;
};

/** A round photo with an initials fallback when there is no photo or it fails to load. */
export function Avatar({ name, uri, size = 'md', ring = false }: Props) {
  const { colors, radius } = useTheme();
  const [failed, setFailed] = useState(false);
  const diameter = DIAMETER[size];

  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={name}
      style={[
        styles.base,
        {
          width: diameter,
          height: diameter,
          borderRadius: radius.pill,
          backgroundColor: colors.raised,
          borderColor: ring ? colors.primary : 'transparent',
        },
      ]}
    >
      {uri && !failed ? (
        <Image
          testID="avatar-image"
          source={{ uri }}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          cachePolicy="memory-disk"
          transition={150}
          onError={() => setFailed(true)}
        />
      ) : (
        // Capped so initials never overflow the fixed circle at the largest text sizes.
        <Text variant={INITIALS_VARIANT[size]} color="primaryText" maxFontSizeMultiplier={1.2}>
          {avatarInitials(name)}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  base: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden', borderWidth: 2 },
});
