import { CameraView, useCameraPermissions } from 'expo-camera';
import { Camera, CameraOff, Settings } from '@/components/icons';
import { useEffect, useRef, useState } from 'react';
import { Linking, StyleSheet, View } from 'react-native';

import { Button, EmptyState, Text, TextField } from '@/components';
import { getCameraSupport, type CameraSupport } from '@/lib/camera';
import { useTheme } from '@/theme';
import { useTranslation } from 'react-i18next';

interface Props {
  /** Called once per code; the scanner stays quiet until `paused` goes false again. */
  onScan: (text: string) => void;
  paused: boolean;
}

/**
 * The camera, asking for permission first (TRF-13). Without a camera, or with
 * it refused, a code can still be pasted, so nobody is stuck.
 */
export function QrScanner({ onScan, paused }: Props) {
  const { colors, spacing, radius } = useTheme();
  const [permission, requestPermission] = useCameraPermissions();
  const [support, setSupport] = useState<CameraSupport | null>(null);
  const [pasted, setPasted] = useState('');
  const { t } = useTranslation();
  // A code in view fires many times a second; only the first one counts.
  const handled = useRef(false);

  useEffect(() => {
    void getCameraSupport().then(setSupport);
  }, []);
  useEffect(() => {
    if (!paused) handled.current = false;
  }, [paused]);

  const scanned = (text: string) => {
    if (handled.current || paused) return;
    handled.current = true;
    onScan(text);
  };

  let camera;
  if (support === 'none') {
    camera = (
      <EmptyState
        icon={CameraOff}
        title={t('transfers.scanner.noCamera')}
        message={t('transfers.scanner.noCameraMessage')}
      />
    );
  } else if (!permission || support === null) {
    camera = (
      <View
        style={[
          styles.frame,
          { borderRadius: radius.xl, backgroundColor: colors.raised, borderColor: colors.raised },
        ]}
      />
    );
  } else if (!permission.granted) {
    camera = permission.canAskAgain ? (
      <EmptyState
        icon={Camera}
        title={t('transfers.scanner.scanToPay')}
        message={t('transfers.scanner.needCamera')}
        actionLabel={t('transfers.scanner.allowCamera')}
        onAction={() => void requestPermission()}
      />
    ) : (
      <View style={{ gap: spacing[3] }}>
        <EmptyState
          icon={CameraOff}
          title={t('transfers.scanner.cameraOff')}
          message={t('transfers.scanner.cameraOffMessage')}
        />
        <Button
          label={t('transfers.scanner.openSettings')}
          icon={Settings}
          variant="secondary"
          onPress={() => void Linking.openSettings()}
        />
      </View>
    );
  } else {
    camera = (
      <View
        style={[styles.frame, { borderRadius: radius.xl, borderColor: colors.primary }]}
        accessibilityLabel={t('transfers.scanner.cameraLabel')}
      >
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={paused ? undefined : ({ data }) => scanned(data)}
        />
      </View>
    );
  }

  return (
    <View style={{ gap: spacing[4] }}>
      {camera}
      {permission?.granted && support !== 'none' && (
        <Text color="textMuted" align="center">
          {t('transfers.scanner.point')}
        </Text>
      )}
      <View style={{ gap: spacing[2] }}>
        <TextField
          label={t('transfers.scanner.paste')}
          placeholder={t('transfers.scanner.pastePlaceholder')}
          value={pasted}
          onChangeText={setPasted}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Button
          label={t('transfers.scanner.check')}
          variant="secondary"
          disabled={!pasted.trim() || paused}
          onPress={() => {
            handled.current = false;
            scanned(pasted);
            setPasted('');
          }}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { width: '100%', aspectRatio: 1, overflow: 'hidden', borderWidth: 2 },
});
