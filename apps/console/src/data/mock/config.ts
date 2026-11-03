import type { Schema } from '@nem/contracts';

import { problem } from '../errors';
import type { BankConfig } from './configSeed';
import type { Handlers } from './handlers';
import { requireReason, staffRef } from './paging';
import { newId } from './state';

type Section = Schema<'ConfigChangeRequest'>['section'];
type Money = Schema<'Money'>;

const APPROVAL_TTL_MS = 72 * 60 * 60_000;

const SECTION_NAMES: Readonly<Record<Section, string>> = {
  fees: 'fees',
  limits: 'tier limits',
  fx_spreads_bps: 'FX spreads',
  cooling_off: 'new-beneficiary cooling-off',
  new_device: 'new-device cool-off',
};

function invalid(field: string, message: string): never {
  throw problem(422, 'validation_failed', 'Check the new values', {
    errors: [{ field: `/value${field}`, code: 'invalid', message }],
  });
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function naira(v: unknown, field: string): bigint {
  const m = v as Money | null;
  if (!isObject(m) || m.currency !== 'NGN' || !/^\d+$/.test(String(m.amount_minor))) {
    invalid(field, 'Use a naira amount of zero or more.');
  }
  return BigInt(m.amount_minor);
}

function wholeNumber(v: unknown, field: string, max: number): number {
  if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > max) {
    invalid(field, `Use a whole number from 0 to ${max.toLocaleString('en-NG')}.`);
  }
  return v as number;
}

/** The same rules the API will apply before a change can even reach a checker. */
function validate(section: Section, value: unknown) {
  switch (section) {
    case 'fees': {
      if (!isObject(value) || !Array.isArray(value.external_transfer_bands)) {
        invalid('', 'Send the whole fees section.');
      }
      naira(value.internal_transfer, '/internal_transfer');
      naira(value.emtl, '/emtl');
      naira(value.emtl_threshold, '/emtl_threshold');
      const bands = value.external_transfer_bands as Schema<'FeeBand'>[];
      if (bands.length === 0) invalid('/external_transfer_bands', 'Keep at least one band.');
      let previous = -1n;
      bands.forEach((band, i) => {
        naira(band.fee, `/external_transfer_bands/${i}/fee`);
        const last = i === bands.length - 1;
        if (last !== (band.up_to === null)) {
          invalid(`/external_transfer_bands/${i}/up_to`, 'Only the last band is open-ended.');
        }
        if (band.up_to) {
          const upTo = naira(band.up_to, `/external_transfer_bands/${i}/up_to`);
          if (upTo <= previous) {
            invalid(`/external_transfer_bands/${i}/up_to`, 'Each band must end above the last.');
          }
          previous = upTo;
        }
      });
      return;
    }
    case 'limits': {
      if (!Array.isArray(value) || value.length !== 3) invalid('', 'Send all three tiers.');
      let previous = -1n;
      (value as Schema<'TierLimit'>[]).forEach((t, i) => {
        if (t.tier !== i + 1) invalid(`/${i}/tier`, 'List tiers 1, 2 and 3 in order.');
        const daily = naira(t.daily_limit, `/${i}/daily_limit`);
        if (daily <= previous)
          invalid(`/${i}/daily_limit`, 'Each tier must allow more than the last.');
        previous = daily;
        if (t.max_balance !== null) naira(t.max_balance, `/${i}/max_balance`);
      });
      return;
    }
    case 'fx_spreads_bps': {
      if (!isObject(value) || Object.keys(value).length === 0) invalid('', 'Send every pair.');
      for (const [pair, bps] of Object.entries(value)) {
        if (!/^[A-Z]{3}-[A-Z]{3}$/.test(pair)) invalid(`/${pair}`, 'Pairs look like USD-NGN.');
        wholeNumber(bps, `/${pair}`, 9_999);
      }
      return;
    }
    case 'cooling_off': {
      if (!isObject(value)) invalid('', 'Send the whole section.');
      naira(value.new_beneficiary_threshold, '/new_beneficiary_threshold');
      wholeNumber(value.delay_minutes, '/delay_minutes', 1_440);
      return;
    }
    case 'new_device': {
      if (!isObject(value)) invalid('', 'Send the whole section.');
      wholeNumber(value.cool_off_hours, '/cool_off_hours', 168);
      naira(value.daily_limit, '/daily_limit');
      return;
    }
  }
}

export const configHandlers: Handlers = {
  getBankConfig: (_input, { state }) => structuredClone(state.config),

  requestConfigChange: ({ body }, { state, staff }) => {
    const reason = requireReason(body.reason);
    if (body.base_version !== state.config.version) {
      throw problem(409, 'stale_config', 'The configuration changed since you opened it', {
        detail: 'Reload to see the latest values, then make your change again.',
      });
    }
    validate(body.section, body.value);
    const waiting = [...state.approvals.values()].some(
      (a) =>
        a.action === 'config_change' && a.status === 'pending' && a.after?.section === body.section,
    );
    if (waiting) {
      throw problem(
        409,
        'approval_pending',
        'A change to this section is already waiting for approval',
      );
    }

    const now = state.now();
    const approval: Schema<'ApprovalRequest'> = {
      id: newId(),
      action: 'config_change',
      status: 'pending',
      maker: staffRef(staff),
      checker: null,
      reason,
      summary: `Change ${SECTION_NAMES[body.section]} (config v${state.config.version})`,
      before: {
        section: body.section,
        value: structuredClone(state.config[body.section as keyof BankConfig]),
      },
      after: { section: body.section, value: structuredClone(body.value) },
      rejection_reason: null,
      created_at: new Date(now).toISOString(),
      decided_at: null,
      expires_at: new Date(now + APPROVAL_TTL_MS).toISOString(),
    };
    state.approvals.set(approval.id, approval);
    return structuredClone(approval);
  },

  listFeatureFlags: (_input, { state }) => ({
    // Paid features last: they stay off until a partner is connected.
    data: structuredClone(
      [...state.flags.values()].sort(
        (a, b) => Number(a.paid_feature) - Number(b.paid_feature) || a.key.localeCompare(b.key),
      ),
    ),
  }),

  updateFeatureFlag: ({ path, body }, { state, staff }) => {
    const flag = state.flags.get(path.flag_key);
    if (!flag) throw problem(404, 'not_found', 'No feature flag with that key');
    requireReason(body.reason);
    if (body.enabled && flag.paid_feature) {
      throw problem(409, 'partner_not_configured', 'This needs a paid partner first', {
        detail:
          'Connect the partner adapter (PRD §11) before turning this on. The demo runs on $0 services.',
      });
    }
    flag.enabled = body.enabled;
    flag.updated_by = staffRef(staff);
    flag.updated_at = new Date(state.now()).toISOString();
    return structuredClone(flag);
  },
};
