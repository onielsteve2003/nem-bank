import type { Schema } from '@nem/contracts';
import * as ImagePicker from 'expo-image-picker';

type User = Schema<'User'>;

/** The largest profile photo the bank keeps, as a data URI (1 MB). */
export const AVATAR_MAX_LENGTH = 1_048_576;

const dayFormat = new Intl.DateTimeFormat('en-NG', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

/** When the @nemtag can next change, or null when it can change now. */
export function nemtagLockedUntil(user: User, now: Date): Date | null {
  const at = user.nemtag_changeable_at;
  return at && new Date(at) > now ? new Date(at) : null;
}

/** The @nemtag change rule as it applies to you today. */
export function nemtagRuleText(user: User, now: Date): string {
  const until = nemtagLockedUntil(user, now);
  return until
    ? `You can change it again on ${dayFormat.format(until)}`
    : 'You can change it once every 30 days';
}

export type PhotoSource = 'camera' | 'library';
export type PickedPhoto =
  | { kind: 'photo'; uri: string }
  | { kind: 'cancelled' }
  | { kind: 'denied' }
  | { kind: 'too_large' };

/**
 * A square, compressed profile photo from the camera or library, as the data
 * URI the bank stores. The library picker needs no permission on iOS; the
 * camera does.
 */
export async function pickProfilePhoto(source: PhotoSource): Promise<PickedPhoto> {
  if (source === 'camera') {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) return { kind: 'denied' };
  }
  const options: ImagePicker.ImagePickerOptions = {
    mediaTypes: ['images'],
    allowsEditing: true,
    aspect: [1, 1],
    quality: 0.4,
    base64: true,
  };
  const result =
    source === 'camera'
      ? await ImagePicker.launchCameraAsync({
          ...options,
          cameraType: ImagePicker.CameraType.front,
        })
      : await ImagePicker.launchImageLibraryAsync(options);
  const asset = result.canceled ? undefined : result.assets[0];
  if (!asset?.base64) return { kind: 'cancelled' };
  const type = asset.mimeType === 'image/png' ? 'png' : 'jpeg';
  const uri = `data:image/${type};base64,${asset.base64}`;
  return uri.length > AVATAR_MAX_LENGTH ? { kind: 'too_large' } : { kind: 'photo', uri };
}
