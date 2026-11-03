import type { StaffRole } from '@nem/contracts';
import { describe, expect, it } from 'vitest';

import { isApiError } from '../errors';
import { repositoriesFromDispatcher } from '../repositories';
import { switchDemoRole } from './auth';
import { customerId } from './customerSeed';
import { createMockDispatcher } from './index';
import { submissionId } from './kycSeed';
import { createMockState } from './state';

function reposAs(role: StaffRole) {
  const state = createMockState(() => Date.parse('2026-11-03T10:00:00Z'));
  const { access_token } = switchDemoRole(state, role);
  return repositoriesFromDispatcher(
    createMockDispatcher({ latencyMs: 0, state, getAccessToken: () => access_token }),
  );
}

// Seed order: 1 Ibrahim (Tier 2), 2 Funmilayo (Tier 3, glare on the ID back).
const IBRAHIM = submissionId(1);
const FUNMI = submissionId(2);

describe('mock KYC reviews', () => {
  it('lists waiting submissions oldest first with hours waited', async () => {
    const page = await reposAs('compliance').kyc.list();
    const submitted = page.data.map((r) => r.submission.submitted_at);
    expect(submitted).toEqual([...submitted].sort());
    expect(page.data.every((r) => r.submission.status === 'pending_review')).toBe(true);
    // 2026-10-30 09:12 → 2026-11-03 10:00.
    expect(page.data[0]).toMatchObject({ customer: { name: 'Ibrahim Musa' }, waiting_hours: 96 });

    const resubmit = await reposAs('compliance').kyc.list({ query: { status: 'resubmit' } });
    expect(resubmit.data.map((r) => r.customer.name)).toEqual(['Tolulope Ajayi']);
  });

  it('keeps the queue away from support and finance', async () => {
    for (const role of ['support', 'finance'] as const) {
      await expect(reposAs(role).kyc.list()).rejects.toSatisfy((e) => isApiError(e, 'forbidden'));
    }
  });

  it('returns documents as image links with their quality issues', async () => {
    const review = await reposAs('admin').kyc.get({ path: { submission_id: FUNMI } });
    expect(review.documents.map((d) => d.kind)).toEqual([
      'id_front',
      'id_back',
      'selfie',
      'proof_of_address',
    ]);
    expect(review.documents[1]!.quality_issues).toEqual(['glare']);
    expect(review.documents[0]!.url).toMatch(/^data:image\/svg\+xml/);
    expect(review.identity_checks.map((c) => c.type)).toEqual(['bvn', 'nin']);
  });

  it('approving moves the customer up a tier at once and cannot be decided twice', async () => {
    const repos = reposAs('compliance');
    const decided = await repos.kyc.decide({
      path: { submission_id: IBRAHIM },
      body: { decision: 'approve' },
    });
    expect(decided.submission.status).toBe('approved');
    expect(decided.reviewer?.name).toBe('Aisha Bello');
    const customer = await repos.customers.get({ path: { user_id: customerId(4) } });
    expect(customer.customer.kyc_tier).toBe(2);
    expect(customer.kyc).toMatchObject({ tier: 2, status: 'approved' });

    await expect(
      repos.kyc.decide({ path: { submission_id: IBRAHIM }, body: { decision: 'approve' } }),
    ).rejects.toSatisfy((e) => isApiError(e, 'conflict'));
  });

  it('needs a reason to reject, and documents to ask for a resubmission', async () => {
    const repos = reposAs('compliance');
    await expect(
      repos.kyc.decide({ path: { submission_id: FUNMI }, body: { decision: 'reject' } }),
    ).rejects.toSatisfy((e) => isApiError(e, 'validation_failed'));
    await expect(
      repos.kyc.decide({
        path: { submission_id: FUNMI },
        body: { decision: 'resubmit', reason: 'The back of the ID has glare.' },
      }),
    ).rejects.toSatisfy((e) => isApiError(e, 'validation_failed'));

    const review = await repos.kyc.decide({
      path: { submission_id: FUNMI },
      body: {
        decision: 'resubmit',
        reason: 'The back of the ID has glare.',
        resubmit_documents: ['id_back'],
      },
    });
    expect(review.submission).toMatchObject({
      status: 'resubmit',
      rejection_reason: 'The back of the ID has glare.',
      resubmit_documents: ['id_back'],
    });
    expect(review.documents.find((d) => d.kind === 'id_back')!.status).toBe('rejected');
    expect(review.documents.find((d) => d.kind === 'id_front')!.status).toBe('uploaded');
  });
});
