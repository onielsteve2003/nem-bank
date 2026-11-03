import type { Schema } from '@nem/contracts';
import { formatMoney, parseMajor } from '@nem/shared';

import { fromApiMoney } from '@/lib/money';

import type { BankConfig, ConfigSection } from './useConfig';

// Each config section as a list of fields. The same list renders the read view and
// the change form, so the two can never disagree about what a section holds.

type Money = Schema<'Money'>;

export type FieldKind = 'naira' | 'naira_or_none' | 'int' | 'bps';
export type FieldValue = Money | number | null;

export interface FieldDef {
  key: string;
  label: string;
  kind: FieldKind;
  value: FieldValue;
  /** Shown after whole numbers: "min", "h". */
  unit?: string;
  max?: number;
}

export interface SectionDef {
  section: ConfigSection;
  title: string;
  description: string;
  fields: FieldDef[];
  /** Rebuilds the section's full value from parsed fields, as the API expects it. */
  toValue: (v: Record<string, FieldValue>) => unknown;
}

const asMoney = (v: FieldValue) => v as Money;

export function sectionsFor(config: BankConfig): SectionDef[] {
  const bands = config.fees.external_transfer_bands;
  const spreads = Object.entries(config.fx_spreads_bps);
  return [
    {
      section: 'fees',
      title: 'Fees',
      description: 'Transfer fees and the Electronic Money Transfer Levy on inflows.',
      fields: [
        {
          key: 'internal',
          label: 'Nem to Nem transfer',
          kind: 'naira',
          value: config.fees.internal_transfer,
        },
        ...bands.flatMap((b, i): FieldDef[] =>
          b.up_to
            ? [
                { key: `up${i}`, label: `Band ${i + 1} up to`, kind: 'naira', value: b.up_to },
                { key: `fee${i}`, label: `Band ${i + 1} fee`, kind: 'naira', value: b.fee },
              ]
            : [{ key: `fee${i}`, label: 'Fee above that', kind: 'naira', value: b.fee }],
        ),
        { key: 'emtl', label: 'EMTL levy', kind: 'naira', value: config.fees.emtl },
        {
          key: 'emtl_threshold',
          label: 'EMTL from inflows of',
          kind: 'naira',
          value: config.fees.emtl_threshold,
        },
      ],
      toValue: (v) => ({
        internal_transfer: v.internal,
        external_transfer_bands: bands.map((b, i) => ({
          up_to: b.up_to ? v[`up${i}`] : null,
          fee: v[`fee${i}`],
        })),
        emtl: v.emtl,
        emtl_threshold: v.emtl_threshold,
      }),
    },
    {
      section: 'limits',
      title: 'Limits by KYC tier',
      description: 'Daily outgoing limit and maximum balance. Leave a maximum empty for none.',
      fields: config.limits.flatMap((t): FieldDef[] => [
        {
          key: `daily${t.tier}`,
          label: `Tier ${t.tier} daily limit`,
          kind: 'naira',
          value: t.daily_limit,
        },
        {
          key: `max${t.tier}`,
          label: `Tier ${t.tier} max balance`,
          kind: 'naira_or_none',
          value: t.max_balance ?? null,
        },
      ]),
      toValue: (v) =>
        config.limits.map((t) => ({
          tier: t.tier,
          daily_limit: v[`daily${t.tier}`],
          max_balance: v[`max${t.tier}`],
        })),
    },
    {
      section: 'fx_spreads_bps',
      title: 'FX spreads',
      description: 'The bank’s margin on each pair, in basis points (150 = 1.5%).',
      fields: spreads.map(([pair, bps]) => ({
        key: pair,
        label: pair.replace('-', ' → '),
        kind: 'bps',
        value: bps,
        max: 9_999,
      })),
      toValue: (v) => Object.fromEntries(spreads.map(([pair]) => [pair, v[pair]])),
    },
    {
      section: 'cooling_off',
      title: 'New-beneficiary cooling-off',
      description:
        'A first transfer to a new recipient above the threshold waits or needs step-up.',
      fields: [
        {
          key: 'threshold',
          label: 'Threshold',
          kind: 'naira',
          value: config.cooling_off.new_beneficiary_threshold,
        },
        {
          key: 'delay',
          label: 'Delay',
          kind: 'int',
          unit: 'min',
          value: config.cooling_off.delay_minutes,
          max: 1_440,
        },
      ],
      toValue: (v) => ({ new_beneficiary_threshold: v.threshold, delay_minutes: v.delay }),
    },
    {
      section: 'new_device',
      title: 'New-device cool-off',
      description: 'After signing in on a new device, outgoing limits drop for a while.',
      fields: [
        {
          key: 'hours',
          label: 'Lasts',
          kind: 'int',
          unit: 'h',
          value: config.new_device.cool_off_hours,
          max: 168,
        },
        {
          key: 'daily',
          label: 'Daily limit meanwhile',
          kind: 'naira',
          value: config.new_device.daily_limit,
        },
      ],
      toValue: (v) => ({ cool_off_hours: v.hours, daily_limit: v.daily }),
    },
  ];
}

/** A field's current value as staff read it. */
export function displayValue(f: FieldDef): string {
  if (f.value === null) return 'No maximum';
  if (typeof f.value === 'number') {
    return f.kind === 'bps'
      ? `${f.value} bps (${(f.value / 100).toFixed(2)}%)`
      : `${f.value}${f.unit ? ` ${f.unit}` : ''}`;
  }
  return formatMoney(fromApiMoney(asMoney(f.value)));
}

/** A field's value as the text box starts: major units without the symbol. */
export function inputValue(f: FieldDef): string {
  if (f.value === null) return '';
  if (typeof f.value === 'number') return String(f.value);
  return formatMoney(fromApiMoney(asMoney(f.value)), { symbol: false });
}

/** Parses one text box; an error message when it can't be used. */
export function parseField(f: FieldDef, text: string): { value: FieldValue } | { error: string } {
  const trimmed = text.trim();
  if (f.kind === 'int' || f.kind === 'bps') {
    const max = f.max ?? Number.MAX_SAFE_INTEGER;
    if (!/^\d+$/.test(trimmed) || Number(trimmed) > max) {
      return { error: `A whole number from 0 to ${max.toLocaleString('en-NG')}.` };
    }
    return { value: Number(trimmed) };
  }
  if (f.kind === 'naira_or_none' && trimmed === '') return { value: null };
  try {
    const m = parseMajor(trimmed, 'NGN');
    if (m.amount < 0n) return { error: 'Zero or more.' };
    return { value: { amount_minor: m.amount.toString(), currency: 'NGN' } };
  } catch {
    return { error: 'An amount like 25 or 1,500.50.' };
  }
}

export const sameValue = (a: FieldValue, b: FieldValue) => JSON.stringify(a) === JSON.stringify(b);
