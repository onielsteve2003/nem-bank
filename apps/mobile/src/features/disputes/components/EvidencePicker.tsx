import { Camera, ImagePlus, X } from 'lucide-react-native';
import { useState } from 'react';
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
  const [error, setError] = useState<string>();
  const [cameraDenied, setCameraDenied] = useState(false);
  const full = existing + photos.length >= MAX_EVIDENCE;

  const pick = async (source: 'camera' | 'library') => {
    setError(undefined);
    const picked = await pickEvidence(source);
    if (picked.kind === 'photo') onChange([...photos, picked.uri]);
    else if (picked.kind === 'denied') setCameraDenied(true);
    else if (picked.kind === 'too_large') setError('That photo is over 5 MB. Try another.');
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
                accessibilityLabel={`Evidence photo ${i + 1}`}
              />
              <View style={styles.remove}>
                <IconButton
                  icon={X}
                  size="sm"
                  accessibilityLabel={`Remove photo ${i + 1}`}
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
            label="Take photo"
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
            label="Choose photo"
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
        {full
          ? `That’s the most you can add (${MAX_EVIDENCE}).`
          : 'Receipts, chats or screenshots help. Up to 5 photos, 5 MB each.'}
      </Text>
      {error && (
        <Text variant="bodySmall" color="danger">
          {error}
        </Text>
      )}
      {cameraDenied && (
        <View style={{ gap: spacing[2] }}>
          <Text variant="bodySmall" color="warning">
            Nem can’t use the camera. Allow it in Settings, or choose a photo instead.
          </Text>
          <Button
            label="Open Settings"
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
