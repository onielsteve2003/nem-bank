import type { Schema } from '@nem/contracts';

// Reference data for the sandbox: Nigerian banks with their CBN codes, and a
// deterministic "other bank" account directory for Confirmation of Payee.

export const NEM_BANK = { code: '090999', name: 'Nem Bank (demo)', short_name: 'Nem' } as const;

export const BANKS: Schema<'Bank'>[] = [
  NEM_BANK,
  { code: '044', name: 'Access Bank', short_name: 'Access' },
  { code: '058', name: 'Guaranty Trust Bank', short_name: 'GTBank' },
  { code: '057', name: 'Zenith Bank', short_name: 'Zenith' },
  { code: '011', name: 'First Bank of Nigeria', short_name: 'First Bank' },
  { code: '033', name: 'United Bank for Africa', short_name: 'UBA' },
  { code: '070', name: 'Fidelity Bank', short_name: 'Fidelity' },
  { code: '214', name: 'First City Monument Bank', short_name: 'FCMB' },
  { code: '032', name: 'Union Bank of Nigeria', short_name: 'Union' },
  { code: '232', name: 'Sterling Bank', short_name: 'Sterling' },
  { code: '035', name: 'Wema Bank', short_name: 'Wema' },
  { code: '221', name: 'Stanbic IBTC Bank', short_name: 'Stanbic' },
  { code: '050', name: 'Ecobank Nigeria', short_name: 'Ecobank' },
  { code: '076', name: 'Polaris Bank', short_name: 'Polaris' },
  { code: '082', name: 'Keystone Bank', short_name: 'Keystone' },
  { code: '101', name: 'Providus Bank', short_name: 'Providus' },
  { code: '301', name: 'Jaiz Bank', short_name: 'Jaiz' },
  { code: '999992', name: 'OPay Digital Services', short_name: 'OPay' },
  { code: '999991', name: 'PalmPay', short_name: 'PalmPay' },
  { code: '50515', name: 'Moniepoint MFB', short_name: 'Moniepoint' },
  { code: '50211', name: 'Kuda Microfinance Bank', short_name: 'Kuda' },
].map((b) => ({ ...b, logo_url: null }));

export function bankByCode(code: string): Schema<'Bank'> | undefined {
  return BANKS.find((b) => b.code === code);
}

const FIRST = ['Adaeze', 'Babatunde', 'Chinedu', 'Damilola', 'Efosa', 'Folake', 'Garba', 'Halima'];
const LAST = ['Okafor', 'Balogun', 'Nnamdi', 'Ogunleye', 'Bello', 'Eze', 'Danjuma', 'Ibe'];

/** Accounts at other banks the seed history pays, so their names resolve exactly. */
export const KNOWN_EXTERNAL: Record<string, string> = {
  '0123456789': 'Chidi Okonkwo',
  '2234567890': 'Funmi Ade',
  '3034567891': 'Ibrahim Musa',
  '3045678912': 'Mama Adebayo',
};

/** A stable, plausible account name for any 10-digit number at another bank. */
export function externalAccountName(accountNumber: string): string | null {
  if (!/^\d{10}$/.test(accountNumber)) return null;
  if (KNOWN_EXTERNAL[accountNumber]) return KNOWN_EXTERNAL[accountNumber]!;
  // Numbers ending in 0000 do not exist, so the "no account" path can be demoed.
  if (accountNumber.endsWith('0000')) return null;
  const n = [...accountNumber].reduce((acc, d) => acc * 7 + Number(d), 0);
  return `${FIRST[n % FIRST.length]} ${LAST[Math.floor(n / FIRST.length) % LAST.length]}`;
}

const tokens = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

/**
 * Confirmation of Payee (TRF-3): how well the name the customer typed matches the
 * account name. Token overlap with prefix credit, so "Tolu Adebayo" closely
 * matches "Tolulope Adebayo" and the word order does not matter.
 */
export function nameMatch(expected: string, actual: string): Schema<'NameMatch'> {
  const a = tokens(expected);
  const b = tokens(actual);
  if (a.length === 0 || b.length === 0) {
    return { result: 'no_match', confidence: 0, expected_name: expected };
  }
  const scoreToken = (t: string) =>
    Math.max(...b.map((u) => (u === t ? 1 : u.startsWith(t) || t.startsWith(u) ? 0.75 : 0)));
  const confidence =
    Math.round(
      (a.map(scoreToken).reduce((x, y) => x + y, 0) / Math.max(a.length, b.length)) * 100,
    ) / 100;
  const result = confidence >= 0.95 ? 'match' : confidence >= 0.5 ? 'close_match' : 'no_match';
  return { result, confidence, expected_name: expected };
}

/** Phone prefixes → network (NCC allocations), for airtime auto-detect. */
const NETWORK_PREFIXES: Record<Schema<'MobileNetwork'>, string[]> = {
  mtn: [
    '0803',
    '0806',
    '0703',
    '0706',
    '0813',
    '0816',
    '0810',
    '0814',
    '0903',
    '0906',
    '0913',
    '0916',
  ],
  airtel: ['0802', '0808', '0708', '0812', '0701', '0902', '0901', '0904', '0907', '0912'],
  glo: ['0805', '0807', '0705', '0815', '0811', '0905', '0915'],
  nine_mobile: ['0809', '0818', '0817', '0909', '0908'],
};

export function detectNetwork(phone: string): Schema<'MobileNetwork'> | null {
  const digits = phone.replace(/\D/g, '');
  const local = digits.startsWith('234') ? `0${digits.slice(3)}` : digits;
  const prefix = local.slice(0, 4);
  const hit = Object.entries(NETWORK_PREFIXES).find(([, prefixes]) => prefixes.includes(prefix));
  return (hit?.[0] as Schema<'MobileNetwork'> | undefined) ?? null;
}
