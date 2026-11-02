import type { Schema } from '@nem/contracts';
import * as ImagePicker from 'expo-image-picker';

export type Reason = Schema<'DisputeReason'>;
export type Status = Schema<'DisputeStatus'>;

/** Reasons in the order people reach for them, in their words (DSP-1). */
export const REASONS: { value: Reason; label: string; hint: string }[] = [
  {
    value: 'failed_but_debited',
    label: 'It failed but I was charged',
    hint: 'The payment didn’t go through',
  },
  {
    value: 'duplicate_charge',
    label: 'I was charged twice',
    hint: 'The same payment shows more than once',
  },
  { value: 'wrong_amount', label: 'Wrong amount', hint: 'I was charged more than I agreed' },
  {
    value: 'not_received',
    label: 'They didn’t get the money',
    hint: 'The person or business says nothing arrived',
  },
  {
    value: 'goods_not_received',
    label: 'I didn’t get what I paid for',
    hint: 'Goods or a service never came',
  },
  {
    value: 'unauthorised',
    label: 'I didn’t make this payment',
    hint: 'Someone else may have used my account',
  },
  { value: 'other', label: 'Something else', hint: 'Tell us in your own words' },
];

export const reasonLabel = (r: Reason) => REASONS.find((x) => x.value === r)?.label ?? r;

export const DISPUTE_STATUS: Record<
  Status,
  { label: string; tone: 'info' | 'warning' | 'success' | 'danger' | 'neutral' }
> = {
  submitted: { label: 'Received', tone: 'info' },
  under_review: { label: 'Under review', tone: 'info' },
  awaiting_customer: { label: 'Needs you', tone: 'warning' },
  resolved_refunded: { label: 'Refunded', tone: 'success' },
  resolved_declined: { label: 'Declined', tone: 'danger' },
  withdrawn: { label: 'Withdrawn', tone: 'neutral' },
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
  if (n < DESCRIPTION_MIN) return `Tell us a little more (${DESCRIPTION_MIN - n} more characters)`;
  if (n > DESCRIPTION_MAX) return `Keep it under ${DESCRIPTION_MAX} characters`;
  return undefined;
}

/** What the customer should expect next, by status. */
export function nextStep(d: Schema<'Dispute'>): string | undefined {
  switch (d.status) {
    case 'submitted':
      return 'A specialist will pick it up shortly';
    case 'under_review':
      return 'We’ll tell you as soon as we decide, usually within 10 working days';
    case 'awaiting_customer':
      return 'Add the evidence we asked for to keep it moving';
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
