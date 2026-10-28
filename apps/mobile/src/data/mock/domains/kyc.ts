import type { Schema } from '@nem/contracts';
import { KYC_TIERS, type KycTier } from '@nem/shared';

import { problem } from '../../errors';
import type { KycRepo } from '../../repositories';
import { api, notFound } from '../convert';
import { nameMatch } from '../directory';
import type { MockBank } from '../runtime';
import { accountName } from '../views';

/** The sandbox reviewer approves a Tier 3 submission after this long. */
const REVIEW_MS = 10_000;
const UNLOCKS: Record<KycTier, Schema<'TierInfo'>['unlocks']> = {
  1: [],
  2: ['fx_wallets', 'usd_cards', 'higher_limits'],
  3: ['credit', 'higher_limits'],
};

/**
 * Puts the customer on a tier as if they had verified up to it and no
 * further: what a new sign-up starts with, and the demo's way back down.
 */
export function setKycTier(bank: MockBank, tier: KycTier) {
  const kyc = bank.world.kyc;
  bank.user.kyc_tier = tier;
  bank.user.kyc_status = tier === 3 ? 'approved' : 'not_started';
  kyc.status = bank.user.kyc_status;
  if (tier < 2) kyc.verifiedIds = [];
  else if (!kyc.verifiedIds.length) kyc.verifiedIds = ['bvn'];
  if (tier < 3) {
    kyc.documents = [];
    kyc.submissions = [];
  }
}

/** What the sandbox reviewer says when it doesn't approve (KYC-5). */
const REVIEW_FINDINGS = {
  reject: {
    reason: 'The name on your ID doesn’t match the name on your BVN record.',
    resubmit: undefined,
  },
  resubmit: {
    reason: 'Your selfie was too dark to compare with your ID.',
    resubmit: ['selfie'] as Schema<'KycDocumentKind'>[],
  },
} as const;

const REVIEW_NOTICES = {
  approved: {
    title: 'You are now Tier 3',
    body: 'Your ID was approved. Higher limits and credit are unlocked.',
  },
  rejected: {
    title: 'Your Tier 3 upgrade wasn’t approved',
    body: 'See why and try again with different documents.',
  },
  resubmit: {
    title: 'We need a document again',
    body: 'One of your photos couldn’t be used. Send a new one to finish Tier 3.',
  },
} as const;

export function processKyc(bank: MockBank): boolean {
  const cutoff = new Date(bank.now().getTime() - REVIEW_MS).toISOString();
  const kyc = bank.world.kyc;
  const due = kyc.submissions.filter(
    (s) => s.status === 'pending_review' && s.submitted_at <= cutoff,
  );
  for (const submission of due) {
    const outcome = kyc.nextReview ?? 'approve';
    delete kyc.nextReview;
    submission.reviewed_at = bank.nowIso();
    if (outcome === 'approve') {
      submission.status = 'approved';
      bank.user.kyc_tier = 3;
    } else {
      const finding = REVIEW_FINDINGS[outcome];
      submission.status = outcome === 'reject' ? 'rejected' : 'resubmit';
      submission.rejection_reason = finding.reason;
      if (finding.resubmit) submission.resubmit_documents = [...finding.resubmit];
    }
    bank.user.kyc_status = submission.status;
    kyc.status = submission.status;
    bank.notify({
      category: 'security',
      ...REVIEW_NOTICES[submission.status as keyof typeof REVIEW_NOTICES],
      deep_link: 'nembank://me/verification',
    });
  }
  return due.length > 0;
}

export function kycRepo(bank: MockBank): KycRepo {
  const latest = () => bank.world.kyc.submissions.at(-1) ?? null;
  const document = (id: string) => {
    const d = bank.world.kyc.documents.find((x) => x.id === id);
    if (!d) throw notFound('Document');
    return d;
  };
  return {
    async getOverview() {
      return {
        tier: bank.tier(),
        status: bank.user.kyc_status,
        tiers: ([1, 2, 3] as const).map((tier) => ({
          tier,
          daily_limit: api(KYC_TIERS[tier].dailyLimit),
          max_balance: KYC_TIERS[tier].maxBalance ? api(KYC_TIERS[tier].maxBalance!) : null,
          requirements: [...KYC_TIERS[tier].requirements],
          unlocks: UNLOCKS[tier],
          current: tier === bank.tier(),
        })),
        latest_submission: latest(),
        demo_limits: true,
      };
    },
    async verifyIdentity({ body }) {
      if (!/^\d{11}$/.test(body.number))
        throw problem(422, 'validation_failed', `A ${body.type.toUpperCase()} has 11 digits`);
      // Sandbox numbers: anything but all zeros belongs to the customer, and
      // the record holds the date of birth they signed up with.
      const found = !/^0+$/.test(body.number);
      const dobMatch =
        body.date_of_birth === undefined
          ? undefined
          : body.date_of_birth === bank.user.date_of_birth;
      const verified = found && dobMatch !== false;
      const match = found
        ? nameMatch(accountName(bank), accountName(bank))
        : { result: 'no_match' as const, confidence: 0, expected_name: accountName(bank) };
      if (verified) {
        if (!bank.world.kyc.verifiedIds.includes(body.type))
          bank.world.kyc.verifiedIds.push(body.type);
        if (bank.user.kyc_tier < 2) bank.user.kyc_tier = 2;
      }
      return {
        type: body.type,
        verified,
        name_match: match,
        sandbox: true,
        ...(found && dobMatch !== undefined && { date_of_birth_match: dobMatch }),
        tier: bank.tier(),
      };
    },
    async uploadDocument({ body }) {
      if (!body.file) throw problem(422, 'validation_failed', 'Choose a photo first');
      // Tiny images are treated as unreadable, so the retake path can be demoed.
      const blurry = body.file.length < 2_000;
      const doc: Schema<'KycDocument'> = {
        id: bank.id(),
        kind: body.kind,
        status: blurry ? 'rejected' : 'uploaded',
        quality_issues: blurry ? (body.kind === 'selfie' ? ['face_not_found'] : ['blurry']) : [],
        uploaded_at: bank.nowIso(),
      };
      bank.world.kyc.documents.push(doc);
      return doc;
    },
    async prefill({ body }) {
      const doc = document(body.document_id);
      if (doc.kind !== 'id_front')
        throw problem(422, 'validation_failed', 'Prefill reads the front of your ID');
      return {
        fields: {
          id_type: 'national_id',
          id_number: null,
          full_name: accountName(bank),
          date_of_birth: bank.user.date_of_birth,
          expiry_date: null,
        },
        confidence: 0.82,
        ai: {
          feature: 'id_prefill',
          model_version: 'rules-mock-1',
          explanation: 'Filled from your profile in the demo. Check every field before you submit.',
          fallback_used: true,
        },
      };
    },
    async submit({ body }) {
      if (bank.tier() >= 3) throw problem(409, 'invalid_state', 'You are already Tier 3');
      if (bank.tier() < 2) throw problem(403, 'kyc_tier_required', 'Verify your BVN or NIN first');
      if (latest()?.status === 'pending_review')
        throw problem(409, 'invalid_state', 'Your documents are being reviewed');
      const docs = body.document_ids.map(document);
      for (const kind of ['id_front', 'selfie'] as const) {
        if (!docs.some((d) => d.kind === kind && d.status !== 'rejected')) {
          throw problem(
            422,
            'validation_failed',
            `Add a clear ${kind === 'selfie' ? 'selfie' : 'photo of your ID'}`,
          );
        }
      }
      const submission: Schema<'KycSubmission'> = {
        id: bank.id(),
        target_tier: 3,
        status: 'pending_review',
        submitted_at: bank.nowIso(),
        reviewed_at: null,
        rejection_reason: null,
      };
      bank.world.kyc.submissions.push(submission);
      bank.world.kyc.status = 'pending_review';
      bank.user.kyc_status = 'pending_review';
      return submission;
    },
    async getSubmission({ path }) {
      const s = bank.world.kyc.submissions.find((x) => x.id === path.submission_id);
      if (!s) throw notFound('Submission');
      return s;
    },
  };
}
