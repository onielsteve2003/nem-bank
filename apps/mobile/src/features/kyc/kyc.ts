import type { Schema } from '@nem/contracts';
import type { KycTier } from '@nem/shared';
import type { Href } from 'expo-router';

import i18n, { localized } from '@/lib/i18n';

type Overview = Schema<'KycOverview'>;
type Unlock = NonNullable<Schema<'TierInfo'>['unlocks']>[number];

/** What a tier unlocks, in words. */
export const UNLOCK_LABELS = localized<Unlock>({
  fx_wallets: 'kyc.unlocks.fx_wallets',
  usd_cards: 'kyc.unlocks.usd_cards',
  credit: 'kyc.unlocks.credit',
  higher_limits: 'kyc.unlocks.higher_limits',
});

/** Where you stand, in one sentence. */
export function kycStatusText(overview: Overview): string {
  switch (overview.status) {
    case 'pending_review':
      return i18n.t('kyc.status.pending');
    case 'rejected':
      return i18n.t('kyc.status.rejected');
    case 'resubmit':
      return i18n.t('kyc.status.resubmit');
    default:
      return i18n.t(overview.tier === 3 ? 'kyc.status.full' : 'kyc.status.more');
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
const idType = (type: IdType) => ({
  get label() {
    return i18n.t(`kyc.idTypes.${type}.label`);
  },
  get name() {
    return i18n.t(`kyc.idTypes.${type}.name`);
  },
  get find() {
    return i18n.t(`kyc.idTypes.${type}.find`);
  },
});

/** Words are read in the current language on access. */
export const ID_TYPES: Record<
  IdType,
  { readonly label: string; readonly name: string; readonly find: string }
> = { bvn: idType('bvn'), nin: idType('nin') };

/** Why a BVN or NIN check failed, in words, or undefined when it passed. */
export function identityProblem(result: Schema<'IdentityVerification'>): string | undefined {
  if (result.verified) return undefined;
  const { label } = ID_TYPES[result.type];
  if (result.date_of_birth_match === false) return i18n.t('kyc.identityProblem.dob', { label });
  return i18n.t('kyc.identityProblem.notFound', { label });
}

/** An ISO date as the DD/MM/YYYY people type. */
export const displayDate = (iso: string) => iso.split('-').reverse().join('/');

type QualityIssue = NonNullable<Schema<'KycDocument'>['quality_issues']>[number];

const QUALITY_ISSUES = localized<QualityIssue>({
  blurry: 'kyc.quality.blurry',
  glare: 'kyc.quality.glare',
  cropped: 'kyc.quality.cropped',
  face_not_found: 'kyc.quality.face_not_found',
});

/** Why the bank turned a photo away, in words, or undefined when it is fine. */
export function photoProblem(doc: Schema<'KycDocument'>): string | undefined {
  if (doc.status !== 'rejected') return undefined;
  const issue = doc.quality_issues?.[0];
  return issue ? QUALITY_ISSUES[issue] : i18n.t('kyc.quality.other');
}

/**
 * A stand-in photo for the demo, so nobody uploads a real ID (KYC-4). It is
 * large enough for the mock's quality check, which turns tiny images away.
 */
export const SAMPLE_PHOTO = `data:image/jpeg;base64,${'/9j/'.padEnd(4_000, 'A')}`;

export type IdDocument = Schema<'KycSubmissionRequest'>['id_type'];

/** The government IDs accepted for Tier 3, and the shape of each number. */
const idDocument = (type: IdDocument, pattern: RegExp) => ({
  pattern,
  get label() {
    return i18n.t(`kyc.documents.${type}.label`);
  },
  get hint() {
    return i18n.t(`kyc.documents.${type}.hint`);
  },
});

/** Words are read in the current language on access. */
export const ID_DOCUMENTS: Record<
  IdDocument,
  { readonly label: string; readonly pattern: RegExp; readonly hint: string }
> = {
  national_id: idDocument('national_id', /^\d{11}$/),
  drivers_licence: idDocument('drivers_licence', /^[A-Z]{3}[A-Z0-9]{8,9}$/),
  international_passport: idDocument('international_passport', /^[A-Z]\d{8}$/),
  voters_card: idDocument('voters_card', /^[A-Z0-9]{19}$/),
};

/** Why an ID number can't be used, or undefined. Empty is just incomplete. */
export function idNumberProblem(type: IdDocument, number: string): string | undefined {
  const n = number.trim().toUpperCase();
  if (!n || ID_DOCUMENTS[type].pattern.test(n)) return undefined;
  return i18n.t('kyc.idNumberProblem', {
    type: ID_DOCUMENTS[type].label.toLowerCase(),
    hint: ID_DOCUMENTS[type].hint,
  });
}

/** Why an ID expiry date can't be used, or undefined. An ID must not have expired. */
export function expiryProblem(iso: string | null, typed: string, today: Date): string | undefined {
  if (!typed) return undefined;
  if (!iso) return typed.length === 10 ? i18n.t('common.dateInvalid') : undefined;
  return iso <= today.toISOString().slice(0, 10) ? i18n.t('kyc.expired') : undefined;
}

type Submission = Schema<'KycSubmission'>;

const DOCUMENT_NAMES = localized<Schema<'KycDocumentKind'>>({
  id_front: 'kyc.documentNames.id_front',
  id_back: 'kyc.documentNames.id_back',
  selfie: 'kyc.documentNames.selfie',
  proof_of_address: 'kyc.documentNames.proof_of_address',
});

/** The documents a reviewer asked for again, as one phrase ("a new selfie"). */
export function resubmitWhat(submission: Submission): string {
  const kinds = submission.resubmit_documents ?? [];
  if (!kinds.length) return i18n.t('kyc.documentsAgain');
  const names = kinds.map((k) => DOCUMENT_NAMES[k]);
  return names.length === 1
    ? names[0]!
    : i18n.t('kyc.listAnd', { list: names.slice(0, -1).join(', '), last: names.at(-1) });
}

/**
 * What a reviewer decided and what to do next (KYC-5), or null when there is
 * nothing to say: no submission yet, or it was approved.
 */
export function reviewState(submission: Submission | null | undefined): {
  status: 'pending' | 'rejected' | 'resubmit';
  title: string;
  message: string;
  action?: string;
} | null {
  switch (submission?.status) {
    case 'pending_review':
      return {
        status: 'pending',
        title: i18n.t('kyc.review.pendingTitle'),
        message: i18n.t('kyc.review.pendingMessage'),
      };
    case 'rejected':
      return {
        status: 'rejected',
        title: i18n.t('kyc.review.rejectedTitle'),
        message: submission.rejection_reason ?? i18n.t('kyc.review.rejectedMessage'),
        action: i18n.t('common.tryAgain'),
      };
    case 'resubmit':
      return {
        status: 'resubmit',
        title: i18n.t('kyc.review.resubmitTitle', { what: resubmitWhat(submission) }),
        message: submission.rejection_reason ?? i18n.t('kyc.review.resubmitMessage'),
        action: i18n.t('kyc.review.sendAgain'),
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
