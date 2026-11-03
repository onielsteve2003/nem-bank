import type { Schema } from '@nem/contracts';

import { problem } from '../errors';
import { findCustomer } from './customers';
import type { Handlers } from './handlers';
import type { KycRecord } from './kycSeed';
import { paginate, requireReason, staffRef } from './paging';
import type { MockState } from './state';

const HOUR_MS = 3_600_000;

function findReview(state: MockState, submissionId: string): KycRecord {
  const record = state.kyc.get(submissionId);
  if (!record) throw problem(404, 'not_found', 'No KYC submission with that ID');
  return record;
}

function toReview(state: MockState, record: KycRecord): Schema<'KycReview'> {
  return structuredClone({
    submission: record.submission,
    customer: findCustomer(state, record.userId).view.customer,
    documents: record.documents,
    identity_checks: record.identityChecks,
    id_type: record.idType,
    id_number_masked: record.idNumberMasked,
    address: record.address,
    reviewer: record.reviewer,
  });
}

export const kycHandlers: Handlers = {
  listKycReviews: ({ query } = {}, { state }) => {
    const status = query?.status ?? 'pending_review';
    const now = state.now();
    const rows = [...state.kyc.values()]
      .filter((r) => r.submission.status === status)
      // Oldest first, so nobody waits too long (ADM-4).
      .sort((a, b) => a.submission.submitted_at.localeCompare(b.submission.submitted_at))
      .map((r) => ({
        submission: structuredClone(r.submission),
        customer: structuredClone(findCustomer(state, r.userId).view.customer),
        waiting_hours: Math.max(
          0,
          Math.floor(
            ((r.submission.reviewed_at ? Date.parse(r.submission.reviewed_at) : now) -
              Date.parse(r.submission.submitted_at)) /
              HOUR_MS,
          ),
        ),
      }));
    return paginate(rows, query?.cursor, query?.limit);
  },

  getKycReview: ({ path }, { state }) => toReview(state, findReview(state, path.submission_id)),

  decideKycReview: ({ path, body }, { state, staff }) => {
    const record = findReview(state, path.submission_id);
    if (record.submission.status !== 'pending_review') {
      throw problem(409, 'conflict', 'This submission has already been decided');
    }
    // The reason is shown to the customer, so a rejection always explains itself.
    const reason = body.decision === 'approve' ? null : requireReason(body.reason);
    const resubmit =
      body.decision === 'resubmit' ? [...new Set(body.resubmit_documents ?? [])] : [];
    if (body.decision === 'resubmit' && resubmit.length === 0) {
      throw problem(422, 'validation_failed', 'Pick the documents to upload again', {
        errors: [{ field: '/resubmit_documents', code: 'required', message: 'Pick at least one.' }],
      });
    }

    const status = ({ approve: 'approved', reject: 'rejected', resubmit: 'resubmit' } as const)[
      body.decision
    ];
    record.submission = {
      ...record.submission,
      status,
      reviewed_at: new Date(state.now()).toISOString(),
      rejection_reason: reason,
      ...(resubmit.length > 0 && { resubmit_documents: resubmit }),
    };
    record.documents = record.documents.map((d) => ({
      ...d,
      status:
        status === 'approved'
          ? 'accepted'
          : status === 'rejected' || resubmit.includes(d.kind)
            ? 'rejected'
            : d.status,
    }));
    record.reviewer = staffRef(staff);

    // The customer's tier moves at once (the app hears `kyc.updated`).
    const customer = findCustomer(state, record.userId).view;
    customer.kyc = { ...customer.kyc, status, latest_submission: record.submission };
    if (status === 'approved') {
      const tier = record.submission.target_tier;
      customer.kyc.tier = tier;
      customer.customer.kyc_tier = tier;
      customer.accounts = customer.accounts.map((a) => ({ ...a, max_balance: null }));
    }
    return toReview(state, record);
  },
};
