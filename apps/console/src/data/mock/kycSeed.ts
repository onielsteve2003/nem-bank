import type { Schema } from '@nem/contracts';

import { customerId, type CustomerRecord } from './customerSeed';

// KYC submissions for the seeded customers: Tier 2 asks for BVN/NIN only, Tier 3 adds
// an ID, a selfie and proof of address. A mix of waiting and decided ones, so every
// filter of the queue has something in it.

type Submission = Schema<'KycSubmission'>;
type DocumentKind = Schema<'KycDocumentKind'>;
type Document = Schema<'KycReview'>['documents'][number];

export interface KycRecord {
  userId: string;
  submission: Submission;
  documents: Document[];
  identityChecks: Schema<'IdentityVerification'>[];
  idType: string;
  idNumberMasked: string;
  address: Schema<'Address'>;
  reviewer: Schema<'StaffRef'> | null;
}

export const submissionId = (n: number) =>
  `01900000-0000-7000-8000-0000000b${String(n).padStart(4, '0')}`;

const DOC_TITLES: Readonly<Record<DocumentKind, string>> = {
  id_front: 'National ID card (front)',
  id_back: 'National ID card (back)',
  selfie: 'Selfie',
  proof_of_address: 'Utility bill',
};

const escapeXml = (s: string) => s.replace(/[<>&'"]/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * A drawn stand-in for an uploaded image, stamped SAMPLE. The API sends a signed URL
 * valid for five minutes; a data URL keeps the demo self-contained.
 */
function sampleImage(kind: DocumentKind, name: string): string {
  const title = escapeXml(DOC_TITLES[kind]);
  const who = escapeXml(name);
  const body =
    kind === 'selfie'
      ? `<circle cx="320" cy="170" r="70" fill="#c9ced6"/><rect x="200" y="250" width="240" height="150" rx="110" fill="#c9ced6"/>`
      : kind === 'proof_of_address'
        ? `<rect x="60" y="90" width="520" height="20" fill="#d5d9df"/><rect x="60" y="130" width="380" height="14" fill="#e1e4e8"/><rect x="60" y="160" width="420" height="14" fill="#e1e4e8"/><rect x="60" y="300" width="200" height="40" fill="#d5d9df"/><text x="60" y="80" font-size="22" fill="#4a5160">Ikeja Electric · ${who}</text>`
        : `<rect x="50" y="90" width="150" height="190" rx="8" fill="#c9ced6"/><text x="230" y="130" font-size="22" fill="#4a5160">${who}</text><rect x="230" y="160" width="300" height="14" fill="#d5d9df"/><rect x="230" y="190" width="240" height="14" fill="#d5d9df"/><rect x="230" y="220" width="280" height="14" fill="#d5d9df"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 420" width="640" height="420"><rect width="640" height="420" rx="18" fill="#f3f4f6"/><text x="50" y="50" font-family="sans-serif" font-size="20" fill="#4a5160">${title}</text><g font-family="sans-serif">${body}</g><text x="320" y="390" text-anchor="middle" font-family="sans-serif" font-size="28" font-weight="700" fill="#b4232a" opacity="0.7">SAMPLE · NOT A REAL DOCUMENT</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

interface Spec {
  customer: number;
  targetTier: 2 | 3;
  status: Submission['status'];
  submitted: string;
  quality?: Partial<Record<DocumentKind, Document['quality_issues']>>;
  nameMatch?: Schema<'NameMatch'>;
  rejection?: string;
}

const SPECS: Spec[] = [
  { customer: 4, targetTier: 2, status: 'pending_review', submitted: '2026-10-30T09:12:00Z' },
  {
    customer: 3,
    targetTier: 3,
    status: 'pending_review',
    submitted: '2026-10-31T16:40:00Z',
    quality: { id_back: ['glare'] },
  },
  {
    customer: 11,
    targetTier: 3,
    status: 'pending_review',
    submitted: '2026-11-01T11:05:00Z',
    nameMatch: { result: 'close_match', confidence: 0.86, expected_name: 'Kelechi O. Okafor' },
  },
  {
    customer: 9,
    targetTier: 3,
    status: 'pending_review',
    submitted: '2026-11-02T08:30:00Z',
    quality: { selfie: ['blurry'] },
  },
  {
    customer: 12,
    targetTier: 2,
    status: 'pending_review',
    submitted: '2026-11-02T19:48:00Z',
    nameMatch: { result: 'no_match', confidence: 0.31, expected_name: 'Hauwa Garba' },
  },
  { customer: 6, targetTier: 2, status: 'pending_review', submitted: '2026-11-03T07:15:00Z' },
  { customer: 1, targetTier: 3, status: 'approved', submitted: '2025-03-02T10:00:00Z' },
  {
    customer: 2,
    targetTier: 3,
    status: 'rejected',
    submitted: '2026-10-20T13:00:00Z',
    rejection: 'The ID photo belongs to someone else.',
  },
  {
    customer: 8,
    targetTier: 3,
    status: 'resubmit',
    submitted: '2026-10-25T12:20:00Z',
    quality: { proof_of_address: ['cropped'] },
    rejection: 'The utility bill is cut off. Upload the whole page.',
  },
];

const AISHA = { id: '01900000-0000-7000-8000-00000000a002', name: 'Aisha Bello' };

function build(spec: Spec, n: number, record: CustomerRecord): KycRecord {
  const name = record.view.customer.name;
  const decided = spec.status !== 'pending_review';
  const reviewedAt = decided
    ? new Date(Date.parse(spec.submitted) + 20 * 3_600_000).toISOString()
    : null;
  const kinds: DocumentKind[] =
    spec.targetTier === 3 ? ['id_front', 'id_back', 'selfie', 'proof_of_address'] : [];
  const resubmit =
    spec.status === 'resubmit' ? (Object.keys(spec.quality ?? {}) as DocumentKind[]) : [];
  const nameMatch = spec.nameMatch ?? { result: 'match', confidence: 0.98, expected_name: null };

  return {
    userId: customerId(spec.customer),
    submission: {
      id: submissionId(n),
      target_tier: spec.targetTier,
      status: spec.status,
      submitted_at: spec.submitted,
      reviewed_at: reviewedAt,
      rejection_reason: spec.rejection ?? null,
      ...(resubmit.length > 0 && { resubmit_documents: resubmit }),
    },
    documents: kinds.map((kind, i) => ({
      id: `01900000-0000-7000-8000-0000000b${n}${i}`.padEnd(36, '0'),
      kind,
      status:
        spec.status === 'approved' ? 'accepted' : resubmit.includes(kind) ? 'rejected' : 'uploaded',
      quality_issues: spec.quality?.[kind] ?? [],
      uploaded_at: spec.submitted,
      url: sampleImage(kind, name),
    })),
    identityChecks: [
      {
        type: 'bvn',
        verified: nameMatch.result !== 'no_match',
        name_match: nameMatch,
        sandbox: true,
        date_of_birth_match: true,
        tier: 2,
      },
      ...(spec.targetTier === 3
        ? [
            {
              type: 'nin' as const,
              verified: true,
              name_match: nameMatch,
              sandbox: true,
              tier: 3 as const,
            },
          ]
        : []),
    ],
    idType: spec.targetTier === 3 ? 'National ID card (NIN slip)' : 'BVN',
    idNumberMasked: `*******${String(4000 + n * 137).slice(-4)}`,
    address: { line1: `${12 + n} Admiralty Way`, city: 'Lekki', state: 'Lagos', country: 'NG' },
    reviewer: decided ? AISHA : null,
  };
}

/** Builds the submissions and points each customer's 360 at their latest one. */
export function seedKyc(customers: Map<string, CustomerRecord>): Map<string, KycRecord> {
  const records = SPECS.map((spec, i) => {
    const customer = customers.get(customerId(spec.customer))!;
    const record = build(spec, i + 1, customer);
    customer.view.kyc = {
      ...customer.view.kyc,
      status: spec.status === 'approved' ? 'approved' : spec.status,
      latest_submission: record.submission,
    };
    if (spec.status === 'approved') customer.view.kyc.tier = spec.targetTier;
    return record;
  });
  return new Map(records.map((r) => [r.submission.id, r]));
}
