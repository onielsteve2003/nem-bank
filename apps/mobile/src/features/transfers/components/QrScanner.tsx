import { CameraView, useCameraPermissions } from 'expo-camera';
import { Camera, CameraOff, Settings } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { Linking, StyleSheet, View } from 'react-native';

import { Button, EmptyState, Text, TextField } from '@/components';
import { getCameraSupport, type CameraSupport } from '@/lib/camera';
import { useTheme } from '@/theme';

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
        title="No camera here"
        message="Paste the code or pay link below instead."
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
        title="Scan to pay"
        message="Nem needs your camera to read QR codes. Nothing is recorded."
        actionLabel="Allow camera"
        onAction={() => void requestPermission()}
      />
    ) : (
      <View style={{ gap: spacing[3] }}>
        <EmptyState
          icon={CameraOff}
          title="Camera is off for Nem"
          message="Turn it on in Settings to scan, or paste the code below."
        />
        <Button
          label="Open Settings"
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
        accessibilityLabel="Camera. Point it at a Nem QR code."
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
          Point your camera at a Nem QR code.
        </Text>
      )}
      <View style={{ gap: spacing[2] }}>
        <TextField
          label="Or paste a code"
          placeholder="Nem QR code or pay link"
          value={pasted}
          onChangeText={setPasted}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Button
          label="Check code"
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
