import type { Schema } from '@nem/contracts';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Camera, CameraOff, CircleAlert, CircleCheck, Image, Settings } from '@/components/icons';
import { useEffect, useRef, useState, type ComponentRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Linking, StyleSheet, View } from 'react-native';

import { Button, EmptyState, Icon, Text } from '@/components';
import { isApiError } from '@/data';
import { getCameraSupport, type CameraSupport } from '@/lib/camera';
import { useRepoMutation } from '@/lib/query';
import { useTheme } from '@/theme';

import { photoProblem, SAMPLE_PHOTO } from '../kyc';

type Kind = Extract<Schema<'KycDocumentKind'>, 'id_front' | 'selfie'>;

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
  const { t } = useTranslation();
  const [permission, requestPermission] = useCameraPermissions();
  const [support, setSupport] = useState<CameraSupport | null>(null);
  const [retaking, setRetaking] = useState(false);
  const [error, setError] = useState<string>();
  const camera = useRef<ComponentRef<typeof CameraView>>(null);
  const upload = useRepoMutation('kyc', 'uploadDocument', { invalidates: [] });
  const copy = {
    guide: t(`kyc.photo.${kind}.guide`),
    take: t(`kyc.photo.${kind}.take`),
    sample: t(`kyc.photo.${kind}.sample`),
    added: t(`kyc.photo.${kind}.added`),
  };
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
            isApiError(e) ? (e.problem.detail ?? e.problem.title) : t('kyc.photo.uploadFailed'),
          ),
      },
    );
  };

  const take = async () => {
    try {
      const photo = await camera.current?.takePictureAsync({ base64: true, quality: 0.5 });
      if (photo?.base64) send(`data:image/jpeg;base64,${photo.base64}`);
    } catch {
      setError(t('kyc.photo.cameraFailed'));
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
            accessibilityLabel={t(problem ? 'common.problem' : 'common.done')}
          />
          <Text variant="bodyStrong" style={styles.flex}>
            {problem ?? copy.added}
          </Text>
        </View>
        <Button
          label={t(problem ? 'common.tryAgain' : 'kyc.photo.retake')}
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
        title={t('kyc.photo.noCamera')}
        message={t('kyc.photo.noCameraMessage')}
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
        title={t(selfie ? 'kyc.photo.takeSelfie' : 'kyc.photo.photographId')}
        message={t('kyc.photo.cameraWhy')}
        actionLabel={t('kyc.photo.allowCamera')}
        onAction={() => void requestPermission()}
      />
    ) : (
      <View style={{ gap: spacing[3] }}>
        <EmptyState
          icon={CameraOff}
          title={t('kyc.photo.cameraOff')}
          message={t('kyc.photo.cameraOffMessage')}
        />
        <Button
          label={t('common.openSettings')}
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
          accessibilityLabel={t('kyc.photo.cameraLabel', { guide: copy.guide })}
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
        <Button label={t('kyc.photo.keep')} variant="ghost" onPress={() => setRetaking(false)} />
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
