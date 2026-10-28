import type { Schema } from '@nem/contracts';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Camera, CameraOff, CircleAlert, CircleCheck, Image, Settings } from 'lucide-react-native';
import { useEffect, useRef, useState, type ComponentRef } from 'react';
import { Linking, StyleSheet, View } from 'react-native';

import { Button, EmptyState, Icon, Text } from '@/components';
import { isApiError } from '@/data';
import { getCameraSupport, type CameraSupport } from '@/lib/camera';
import { useRepoMutation } from '@/lib/query';
import { useTheme } from '@/theme';

import { photoProblem, SAMPLE_PHOTO } from '../kyc';

type Kind = Extract<Schema<'KycDocumentKind'>, 'id_front' | 'selfie'>;

const COPY: Record<Kind, { guide: string; take: string; sample: string; added: string }> = {
  id_front: {
    guide: 'Fit the front of your ID inside the frame, flat and in good light.',
    take: 'Take photo',
    sample: 'Use a sample ID',
    added: 'ID photo added',
  },
  selfie: {
    guide: 'Fit your face inside the oval. Take off glasses and hats.',
    take: 'Take selfie',
    sample: 'Use a sample selfie',
    added: 'Selfie added',
  },
};

interface Props {
  kind: Kind;
  document: Schema<'KycDocument'> | undefined;
  onUploaded: (document: Schema<'KycDocument'>) => void;
}

/**
 * A KYC photo (KYC-3): the camera with a guide for an ID card or a face, then
 * the bank's quality check. The demo also accepts a sample, so it works
 * without a camera and never needs a real ID.
 */
export function PhotoCapture({ kind, document, onUploaded }: Props) {
  const { colors, spacing, radius } = useTheme();
  const [permission, requestPermission] = useCameraPermissions();
  const [support, setSupport] = useState<CameraSupport | null>(null);
  const [retaking, setRetaking] = useState(false);
  const [error, setError] = useState<string>();
  const camera = useRef<ComponentRef<typeof CameraView>>(null);
  const upload = useRepoMutation('kyc', 'uploadDocument', { invalidates: [] });
  const copy = COPY[kind];
  const selfie = kind === 'selfie';

  useEffect(() => {
    void getCameraSupport().then(setSupport);
  }, []);

  const send = (file: string) => {
    setError(undefined);
    upload.mutate(
      { body: { kind, file } },
      {
        onSuccess: (doc) => {
          setRetaking(false);
          onUploaded(doc);
        },
        onError: (e) =>
          setError(
            isApiError(e)
              ? (e.problem.detail ?? e.problem.title)
              : 'That didn’t upload. Try again.',
          ),
      },
    );
  };

  const take = async () => {
    try {
      const photo = await camera.current?.takePictureAsync({ base64: true, quality: 0.5 });
      if (photo?.base64) send(`data:image/jpeg;base64,${photo.base64}`);
    } catch {
      setError('The camera couldn’t take that. Try again.');
    }
  };

  const problem = document && photoProblem(document);
  if (document && !retaking) {
    return (
      <View style={{ gap: spacing[3] }} accessibilityLiveRegion="polite">
        <View style={[styles.row, { gap: spacing[2] }]}>
          <Icon
            icon={problem ? CircleAlert : CircleCheck}
            color={problem ? 'danger' : 'success'}
            accessibilityLabel={problem ? 'Problem' : 'Done'}
          />
          <Text variant="bodyStrong" style={styles.flex}>
            {problem ?? copy.added}
          </Text>
        </View>
        <Button
          label={problem ? 'Try again' : 'Retake'}
          variant="secondary"
          onPress={() => setRetaking(true)}
        />
      </View>
    );
  }

  let view;
  if (support === 'none') {
    view = (
      <EmptyState
        icon={CameraOff}
        title="No camera here"
        message="Use the sample below to carry on."
      />
    );
  } else if (!permission || support === null) {
    view = (
      <View style={[styles.frame, { borderRadius: radius.xl, backgroundColor: colors.raised }]} />
    );
  } else if (!permission.granted) {
    view = permission.canAskAgain ? (
      <EmptyState
        icon={Camera}
        title={selfie ? 'Take a selfie' : 'Photograph your ID'}
        message="Nem needs your camera for this. The photo only goes to our review team."
        actionLabel="Allow camera"
        onAction={() => void requestPermission()}
      />
    ) : (
      <View style={{ gap: spacing[3] }}>
        <EmptyState
          icon={CameraOff}
          title="Camera is off for Nem"
          message="Turn it on in Settings, or use the sample below."
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
    view = (
      <View style={{ gap: spacing[3] }}>
        <View
          style={[styles.frame, { borderRadius: radius.xl, overflow: 'hidden' }]}
          accessibilityLabel={`Camera. ${copy.guide}`}
        >
          <CameraView
            ref={camera}
            style={StyleSheet.absoluteFill}
            facing={selfie ? 'front' : 'back'}
          />
          <View
            pointerEvents="none"
            style={[
              selfie ? styles.oval : styles.card,
              { borderColor: colors.onPrimary, borderRadius: selfie ? 999 : radius.lg },
            ]}
          />
        </View>
        <Button
          label={copy.take}
          icon={Camera}
          loading={upload.isPending}
          onPress={() => void take()}
        />
      </View>
    );
  }

  return (
    <View style={{ gap: spacing[3] }}>
      <Text color="textMuted">{copy.guide}</Text>
      {view}
      {error && (
        <Text variant="bodySmall" color="danger" accessibilityLiveRegion="assertive">
          {error}
        </Text>
      )}
      <Button
        label={copy.sample}
        icon={Image}
        variant="ghost"
        disabled={upload.isPending}
        onPress={() => send(SAMPLE_PHOTO)}
      />
      {retaking && (
        <Button label="Keep the one I added" variant="ghost" onPress={() => setRetaking(false)} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
  frame: { width: '100%', aspectRatio: 3 / 4, alignItems: 'center', justifyContent: 'center' },
  // An ID-1 card (85.6 × 54 mm) across most of the frame.
  card: { width: '86%', aspectRatio: 85.6 / 54, borderWidth: 3, borderStyle: 'dashed' },
  oval: { width: '62%', aspectRatio: 3 / 4, borderWidth: 3, borderStyle: 'dashed' },
});
