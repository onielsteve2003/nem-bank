import type { Schema } from '@nem/contracts';
import * as ImagePicker from 'expo-image-picker';

import i18n, { withLabel } from '@/lib/i18n';

export type Reason = Schema<'DisputeReason'>;
export type Status = Schema<'DisputeStatus'>;

/** Reasons in the order people reach for them, in their words (DSP-1). */
export const REASONS = (
  [
    'failed_but_debited',
    'duplicate_charge',
    'wrong_amount',
    'not_received',
    'goods_not_received',
    'unauthorised',
    'other',
  ] as const satisfies readonly Reason[]
).map((value) => ({
  value,
  get label() {
    return i18n.t(`disputes.reasons.${value}.label`);
  },
  get hint() {
    return i18n.t(`disputes.reasons.${value}.hint`);
  },
}));

export const reasonLabel = (r: Reason) => REASONS.find((x) => x.value === r)?.label ?? r;

export const DISPUTE_STATUS: Record<
  Status,
  { label: string; tone: 'info' | 'warning' | 'success' | 'danger' | 'neutral' }
> = {
  submitted: withLabel('disputes.status.submitted', { tone: 'info' }),
  under_review: withLabel('disputes.status.under_review', { tone: 'info' }),
  awaiting_customer: withLabel('disputes.status.awaiting_customer', { tone: 'warning' }),
  resolved_refunded: withLabel('disputes.status.resolved_refunded', { tone: 'success' }),
  resolved_declined: withLabel('disputes.status.resolved_declined', { tone: 'danger' }),
  withdrawn: withLabel('disputes.status.withdrawn', { tone: 'neutral' }),
};

export const isOpen = (d: Pick<Schema<'Dispute'>, 'status' | 'resolved_at'>) =>
  !d.resolved_at && d.status !== 'withdrawn';

export const DESCRIPTION_MIN = 10;
export const DESCRIPTION_MAX = 1000;
export const MAX_EVIDENCE = 5;
/** Base64 is a third bigger than the file, so a 5 MB file is about 6.9M characters. */
const MAX_DATA_URI = Math.ceil((5 * 1024 * 1024 * 4) / 3) + 32;

/** Why a description can't be sent yet, or undefined. */
export function descriptionProblem(text: string): string | undefined {
  const n = text.trim().length;
  if (n < DESCRIPTION_MIN)
    return i18n.t('disputes.descriptionShort', { count: DESCRIPTION_MIN - n });
  if (n > DESCRIPTION_MAX) return i18n.t('disputes.descriptionLong', { max: DESCRIPTION_MAX });
  return undefined;
}

/** What the customer should expect next, by status. */
export function nextStep(d: Schema<'Dispute'>): string | undefined {
  switch (d.status) {
    case 'submitted':
    case 'under_review':
    case 'awaiting_customer':
      return i18n.t(`disputes.next.${d.status}`);
    default:
      return undefined;
  }
}

export type PickedEvidence =
  | { kind: 'photo'; uri: string }
  | { kind: 'denied' }
  | { kind: 'cancelled' }
  | { kind: 'too_large' };

/** A photo of a receipt or screen as a data URI, from the camera or the library. */
export async function pickEvidence(source: 'camera' | 'library'): Promise<PickedEvidence> {
  if (source === 'camera') {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) return { kind: 'denied' };
  }
  const options: ImagePicker.ImagePickerOptions = {
    mediaTypes: ['images'],
    quality: 0.6,
    base64: true,
  };
  const result =
    source === 'camera'
      ? await ImagePicker.launchCameraAsync(options)
      : await ImagePicker.launchImageLibraryAsync(options);
  const asset = result.canceled ? undefined : result.assets[0];
  if (!asset?.base64) return { kind: 'cancelled' };
  const type = asset.mimeType === 'image/png' ? 'png' : 'jpeg';
  const uri = `data:image/${type};base64,${asset.base64}`;
  return uri.length > MAX_DATA_URI ? { kind: 'too_large' } : { kind: 'photo', uri };
}
