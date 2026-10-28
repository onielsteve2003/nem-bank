import type { Schema } from '@nem/contracts';
import type { KycTier } from '@nem/shared';
import type { Href } from 'expo-router';

type Overview = Schema<'KycOverview'>;
type Unlock = NonNullable<Schema<'TierInfo'>['unlocks']>[number];

/** What a tier unlocks, in words. */
export const UNLOCK_LABELS: Record<Unlock, string> = {
  fx_wallets: 'Dollar, pound and euro wallets',
  usd_cards: 'Dollar cards',
  credit: 'Loans',
  higher_limits: 'Higher limits',
};

/** Where you stand, in one sentence. */
export function kycStatusText(overview: Overview): string {
  switch (overview.status) {
    case 'pending_review':
      return 'Your documents are being reviewed. This usually takes a few minutes.';
    case 'rejected':
      return 'Your last upgrade wasn’t approved.';
    case 'resubmit':
      return 'We need some documents again.';
    default:
      return overview.tier === 3
        ? 'You’re fully verified.'
        : 'Verify a little more to raise your limits.';
  }
}

/** The tier above yours, or null at the top. */
export const nextTier = (tier: KycTier): KycTier | null =>
  tier < 3 ? ((tier + 1) as KycTier) : null;

/** The flow that reaches each tier. A tier without one is not built yet. */
const UPGRADE_ROUTES: Partial<Record<KycTier, Href>> = {
  2: '/kyc/identity',
  3: '/kyc/documents',
};

/**
 * The screen that takes you to the next tier. `null` means there is nothing to
 * start: you are at the top, your documents are with a reviewer, or the flow
 * is not built yet.
 */
export function upgradeHref(overview: Overview): Href | null {
  const next = nextTier(overview.tier);
  if (!next || overview.status === 'pending_review') return null;
  return UPGRADE_ROUTES[next] ?? null;
}

export type IdType = Schema<'IdentityNumberRequest'>['type'];

/** BVN and NIN, and how to find yours. */
export const ID_TYPES: Record<IdType, { label: string; name: string; find: string }> = {
  bvn: {
    label: 'BVN',
    name: 'Bank Verification Number',
    find: 'Dial *565*0# from the phone number linked to your bank account.',
  },
  nin: {
    label: 'NIN',
    name: 'National Identification Number',
    find: 'Dial *346# from the phone number you registered with NIMC.',
  },
};

/** Why a BVN or NIN check failed, in words, or undefined when it passed. */
export function identityProblem(result: Schema<'IdentityVerification'>): string | undefined {
  if (result.verified) return undefined;
  const { label } = ID_TYPES[result.type];
  if (result.date_of_birth_match === false)
    return `That date of birth doesn’t match your ${label} record. Use the one you registered with.`;
  return `We couldn’t find that ${label}. Check the 11 digits and try again.`;
}

/** An ISO date as the DD/MM/YYYY people type. */
export const displayDate = (iso: string) => iso.split('-').reverse().join('/');

type QualityIssue = NonNullable<Schema<'KycDocument'>['quality_issues']>[number];

const QUALITY_ISSUES: Record<QualityIssue, string> = {
  blurry: 'That photo is blurry. Hold still and try again.',
  glare: 'There’s glare on your ID. Tilt it away from the light.',
  cropped: 'Part of your ID is cut off. Fit it all inside the frame.',
  face_not_found: 'We couldn’t see your face. Face the camera in good light.',
};

/** Why the bank turned a photo away, in words, or undefined when it is fine. */
export function photoProblem(doc: Schema<'KycDocument'>): string | undefined {
  if (doc.status !== 'rejected') return undefined;
  const issue = doc.quality_issues?.[0];
  return issue ? QUALITY_ISSUES[issue] : 'We couldn’t use that photo. Try another.';
}

/**
 * A stand-in photo for the demo, so nobody uploads a real ID (KYC-4). It is
 * large enough for the mock's quality check, which turns tiny images away.
 */
export const SAMPLE_PHOTO = `data:image/jpeg;base64,${'/9j/'.padEnd(4_000, 'A')}`;

export type IdDocument = Schema<'KycSubmissionRequest'>['id_type'];

/** The government IDs accepted for Tier 3, and the shape of each number. */
export const ID_DOCUMENTS: Record<IdDocument, { label: string; pattern: RegExp; hint: string }> = {
  national_id: { label: 'National ID', pattern: /^\d{11}$/, hint: 'Your 11-digit NIN' },
  drivers_licence: {
    label: 'Driver’s licence',
    pattern: /^[A-Z]{3}[A-Z0-9]{8,9}$/,
    hint: 'Like ABC12345AA01',
  },
  international_passport: {
    label: 'International passport',
    pattern: /^[A-Z]\d{8}$/,
    hint: 'A letter and 8 digits, like A01234567',
  },
  voters_card: {
    label: 'Voter’s card',
    pattern: /^[A-Z0-9]{19}$/,
    hint: 'The 19 characters on your PVC',
  },
};

/** Why an ID number can't be used, or undefined. Empty is just incomplete. */
export function idNumberProblem(type: IdDocument, number: string): string | undefined {
  const n = number.trim().toUpperCase();
  if (!n || ID_DOCUMENTS[type].pattern.test(n)) return undefined;
  return `That doesn’t look like a ${ID_DOCUMENTS[type].label.toLowerCase()} number. ${ID_DOCUMENTS[type].hint}.`;
}

/** Why an ID expiry date can't be used, or undefined. An ID must not have expired. */
export function expiryProblem(iso: string | null, typed: string, today: Date): string | undefined {
  if (!typed) return undefined;
  if (!iso) return typed.length === 10 ? 'Enter a real date as DD/MM/YYYY' : undefined;
  return iso <= today.toISOString().slice(0, 10)
    ? 'This ID has expired. Use one that hasn’t.'
    : undefined;
}

type Submission = Schema<'KycSubmission'>;

const DOCUMENT_NAMES: Record<Schema<'KycDocumentKind'>, string> = {
  id_front: 'a new photo of your ID',
  id_back: 'a photo of the back of your ID',
  selfie: 'a new selfie',
  proof_of_address: 'proof of your address',
};

/** The documents a reviewer asked for again, as one phrase ("a new selfie"). */
export function resubmitWhat(submission: Submission): string {
  const kinds = submission.resubmit_documents ?? [];
  if (!kinds.length) return 'your documents again';
  const names = kinds.map((k) => DOCUMENT_NAMES[k]);
  return names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/**
 * What a reviewer decided and what to do next (KYC-5), or null when there is
 * nothing to say: no submission yet, or it was approved.
 */
export function reviewState(
  submission: Submission | null | undefined,
): {
  status: 'pending' | 'rejected' | 'resubmit';
  title: string;
  message: string;
  action?: string;
} | null {
  switch (submission?.status) {
    case 'pending_review':
      return {
        status: 'pending',
        title: 'We’re checking your documents',
        message: 'This usually takes a few minutes. We’ll tell you when it’s done.',
      };
    case 'rejected':
      return {
        status: 'rejected',
        title: 'Not approved',
        message: submission.rejection_reason ?? 'We couldn’t approve these documents.',
        action: 'Try again',
      };
    case 'resubmit':
      return {
        status: 'resubmit',
        title: `We need ${resubmitWhat(submission)}`,
        message: submission.rejection_reason ?? 'One of your photos couldn’t be used.',
        action: 'Send again',
      };
    default:
      return null;
  }
}

/** The Tier 3 steps a reviewer's finding points at, so the flow can flag them. */
export function stepsToFix(submission: Submission | null | undefined): number[] {
  if (submission?.status === 'rejected') return [0, 2];
  if (submission?.status !== 'resubmit') return [];
  const kinds = submission.resubmit_documents ?? [];
  return kinds.map((k) => (k === 'selfie' ? 1 : k === 'proof_of_address' ? 3 : 0));
}
