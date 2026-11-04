import { Camera, ImagePlus, X } from '@/components/icons';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Image, Linking, StyleSheet, View } from 'react-native';

import { Button, IconButton, Text } from '@/components';
import { useTheme } from '@/theme';

import { MAX_EVIDENCE, pickEvidence } from '../disputes';

type Props = {
  photos: string[];
  onChange: (photos: string[]) => void;
  /** Photos already on the case, counted towards the limit. */
  existing?: number;
  disabled?: boolean;
};

/** Up to five photos of a receipt, a chat or a screen, from the camera or library (DSP-1). */
export function EvidencePicker({ photos, onChange, existing = 0, disabled = false }: Props) {
  const { radius, spacing } = useTheme();
  const { t } = useTranslation();
  const [error, setError] = useState<string>();
  const [cameraDenied, setCameraDenied] = useState(false);
  const full = existing + photos.length >= MAX_EVIDENCE;

  const pick = async (source: 'camera' | 'library') => {
    setError(undefined);
    const picked = await pickEvidence(source);
    if (picked.kind === 'photo') onChange([...photos, picked.uri]);
    else if (picked.kind === 'denied') setCameraDenied(true);
    else if (picked.kind === 'too_large') setError(t('common.photoTooBig'));
  };

  return (
    <View style={{ gap: spacing[3] }}>
      {photos.length > 0 && (
        <View style={[styles.wrap, { gap: spacing[2] }]}>
          {photos.map((uri, i) => (
            <View key={`${i}-${uri.length}`}>
              <Image
                source={{ uri }}
                style={[styles.thumb, { borderRadius: radius.md }]}
                accessibilityLabel={t('disputes.evidence.label', { n: i + 1 })}
              />
              <View style={styles.remove}>
                <IconButton
                  icon={X}
                  size="sm"
                  accessibilityLabel={t('common.removePhotoN', { n: i + 1 })}
                  disabled={disabled}
                  onPress={() => onChange(photos.filter((_, j) => j !== i))}
                />
              </View>
            </View>
          ))}
        </View>
      )}
      <View style={[styles.row, { gap: spacing[2] }]}>
        <View style={styles.flex}>
          <Button
            label={t('common.takePhoto')}
            icon={Camera}
            variant="secondary"
            size="sm"
            fullWidth
            disabled={full || disabled}
            onPress={() => void pick('camera')}
          />
        </View>
        <View style={styles.flex}>
          <Button
            label={t('common.choosePhoto')}
            icon={ImagePlus}
            variant="secondary"
            size="sm"
            fullWidth
            disabled={full || disabled}
            onPress={() => void pick('library')}
          />
        </View>
      </View>
      <Text variant="caption" color="textMuted">
        {full ? t('disputes.evidence.full', { max: MAX_EVIDENCE }) : t('disputes.evidence.help')}
      </Text>
      {error && (
        <Text variant="bodySmall" color="danger">
          {error}
        </Text>
      )}
      {cameraDenied && (
        <View style={{ gap: spacing[2] }}>
          <Text variant="bodySmall" color="warning">
            {t('disputes.evidence.cameraDenied')}
          </Text>
          <Button
            label={t('common.openSettings')}
            variant="ghost"
            size="sm"
            onPress={() => void Linking.openSettings()}
          />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', flexWrap: 'wrap' },
  row: { flexDirection: 'row' },
  flex: { flex: 1 },
  thumb: { width: 72, height: 72 },
  remove: { position: 'absolute', top: -8, right: -8 },
});
