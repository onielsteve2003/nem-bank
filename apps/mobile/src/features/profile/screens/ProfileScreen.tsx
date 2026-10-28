import { useRouter } from 'expo-router';
import { AtSign, BadgeCheck, Camera, ImagePlus, Trash2 } from 'lucide-react-native';
import { useState } from 'react';
import { Linking, Platform, StyleSheet, View } from 'react-native';

import {
  Avatar,
  Button,
  Card,
  Divider,
  ErrorState,
  ListItem,
  Screen,
  SectionHeader,
  Skeleton,
  SkeletonGroup,
  Text,
  TextField,
  useToast,
} from '@/components';
import { isApiError } from '@/data';
import { displayDate } from '@/features/kyc/kyc';
import { SendHeader } from '@/features/transfers/components/SendHeader';
import { queryKeys, useRepoMutation, useRepoQuery } from '@/lib/query';
import { useTheme } from '@/theme';

import { nemtagRuleText, pickProfilePhoto, type PhotoSource } from '../profile';

const PREFERRED_NAME_MAX = 50;

const message = (e: unknown) =>
  isApiError(e)
    ? e.problem.code === 'offline'
      ? "You're offline. Reconnect and try again."
      : (e.problem.detail ?? e.problem.title)
    : 'We couldn’t save that. Try again.';

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.between} accessible accessibilityLabel={`${label}: ${value}`}>
      <Text variant="bodySmall" color="textMuted">
        {label}
      </Text>
      <Text variant="bodySmall" style={styles.value}>
        {value}
      </Text>
    </View>
  );
}

/**
 * Your profile: photo, the name people see, your @nemtag and the details the
 * bank holds. Legal names come from your ID, so only display fields change here.
 */
export function ProfileScreen() {
  const router = useRouter();
  const toast = useToast();
  const { spacing } = useTheme();
  const me = useRepoQuery('users', 'getMe');
  const update = useRepoMutation('users', 'updateMe', {
    invalidates: [queryKeys.domain('users')],
  });
  const [preferred, setPreferred] = useState<string>();
  const [photoError, setPhotoError] = useState<string>();
  const [cameraDenied, setCameraDenied] = useState(false);
  const user = me.data;

  const header = <SendHeader title="Profile" first />;
  if (!user) {
    return (
      <Screen header={header} edges={['top', 'bottom']}>
        {me.isError ? (
          <ErrorState title="We couldn't load your profile" onRetry={() => me.refetch()} />
        ) : (
          <SkeletonGroup accessibilityLabel="Loading your profile">
            <Skeleton height={140} />
            <Skeleton height={120} />
            <Skeleton height={160} />
          </SkeletonGroup>
        )}
      </Screen>
    );
  }

  const legalName = `${user.first_name} ${user.last_name}`;
  const shown = user.preferred_name ?? legalName;
  // Until you type, the field shows the saved name.
  const field = preferred ?? user.preferred_name ?? '';
  const typed = field.trim();
  const nameChanged = typed !== (user.preferred_name ?? '');

  const savePhoto = (avatar_url: string | null) =>
    update.mutate(
      { body: { avatar_url } },
      {
        onSuccess: () =>
          toast.show({ message: avatar_url ? 'Photo updated' : 'Photo removed', tone: 'success' }),
        onError: (e) => setPhotoError(message(e)),
      },
    );

  const choosePhoto = async (source: PhotoSource) => {
    setPhotoError(undefined);
    setCameraDenied(false);
    const picked = await pickProfilePhoto(source);
    if (picked.kind === 'photo') savePhoto(picked.uri);
    else if (picked.kind === 'denied') setCameraDenied(true);
    else if (picked.kind === 'too_large') setPhotoError('That photo is too large. Try another.');
  };

  const saveName = () =>
    update.mutate(
      { body: { preferred_name: typed || null } },
      {
        onSuccess: () => toast.show({ message: 'Name saved', tone: 'success' }),
        onError: (e) => toast.show({ message: message(e), tone: 'error' }),
      },
    );

  return (
    <Screen
      header={header}
      edges={['top', 'bottom']}
      onRefresh={() => void me.refetch()}
      refreshing={me.isRefetching}
    >
      <Card>
        <View style={[styles.center, { gap: spacing[3] }]}>
          <Avatar name={shown} uri={user.avatar_url ?? undefined} size="xl" ring />
          <View style={[styles.center, { gap: spacing[1] }]}>
            <Text variant="h3">{shown}</Text>
            {user.nemtag && <Text variant="bodySmall" color="textMuted">{`@${user.nemtag}`}</Text>}
          </View>
          <View style={[styles.actions, { gap: spacing[2] }]}>
            {Platform.OS !== 'web' && (
              <Button
                label="Take a photo"
                icon={Camera}
                variant="secondary"
                size="sm"
                disabled={update.isPending}
                onPress={() => void choosePhoto('camera')}
              />
            )}
            <Button
              label="Choose a photo"
              icon={ImagePlus}
              variant="secondary"
              size="sm"
              disabled={update.isPending}
              onPress={() => void choosePhoto('library')}
            />
            {user.avatar_url && (
              <Button
                label="Remove photo"
                icon={Trash2}
                variant="ghost"
                size="sm"
                disabled={update.isPending}
                onPress={() => savePhoto(null)}
              />
            )}
          </View>
          {photoError && (
            <Text variant="bodySmall" color="danger" accessibilityLiveRegion="assertive">
              {photoError}
            </Text>
          )}
          {cameraDenied && (
            <View style={[styles.center, { gap: spacing[1] }]}>
              <Text variant="bodySmall" color="textMuted" style={styles.centerText}>
                Nem needs the camera to take your photo. You can choose one instead.
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
      </Card>

      <View style={{ gap: spacing[2] }}>
        <SectionHeader title="The name people see" />
        <Card>
          <View style={{ gap: spacing[3] }}>
            <TextField
              label="Preferred name"
              optional
              help={`Shown in the app and to people you pay. Leave it empty to use ${user.first_name}.`}
              value={field}
              onChangeText={setPreferred}
              maxLength={PREFERRED_NAME_MAX}
              autoCapitalize="words"
              autoComplete="given-name"
              returnKeyType="done"
              onSubmitEditing={() => nameChanged && saveName()}
            />
            <Button
              label="Save name"
              disabled={!nameChanged}
              loading={update.isPending && nameChanged}
              onPress={saveName}
            />
          </View>
        </Card>
      </View>

      <View style={{ gap: spacing[2] }}>
        <SectionHeader title="@nemtag" />
        <Card padded={false}>
          <ListItem
            title={user.nemtag ? `@${user.nemtag}` : 'Choose a @nemtag'}
            subtitle={nemtagRuleText(user, new Date())}
            leading={AtSign}
            onPress={() => router.push('/profile/nemtag')}
          />
        </Card>
      </View>

      <View style={{ gap: spacing[2] }}>
        <SectionHeader title="Details the bank holds" />
        <Card>
          <View style={{ gap: spacing[2] }}>
            <Detail label="Legal name" value={legalName} />
            <Detail label="Date of birth" value={displayDate(user.date_of_birth)} />
            <Divider />
            <Detail label="Email" value={user.email} />
            <Detail label="Phone" value={user.phone} />
          </View>
        </Card>
        <Text variant="caption" color="textMuted">
          Your legal name and date of birth come from your ID, so they change only through identity
          verification.
        </Text>
        <Card padded={false}>
          <ListItem
            title="Verify your identity"
            subtitle={`KYC Tier ${user.kyc_tier}`}
            leading={BadgeCheck}
            onPress={() => router.push('/kyc')}
          />
        </Card>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center' },
  centerText: { textAlign: 'center' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center' },
  between: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  value: { flexShrink: 1, textAlign: 'right' },
});
