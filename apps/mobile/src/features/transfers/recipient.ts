import type { Schema } from '@nem/contracts';

import type { Tone } from '@/components';
import i18n from '@/lib/i18n';

type Bank = Schema<'Bank'>;
type NameMatch = Schema<'NameMatch'>;

/** Ten digits: a NUBAN account number, the only format Nigerian banks use. */
export const isNuban = (value: string) => /^\d{10}$/.test(value);

/**
 * The lookup a Nem user query is ready for, or null while it is still being
 * typed: a @nemtag of 3+ characters, a 10-digit account number, or a phone
 * number (080…, 234…, +234…). Spaces and dashes in pasted numbers are dropped.
 */
export function nemLookupQuery(input: string): string | null {
  const trimmed = input.trim();
  const compact = trimmed.replace(/[\s-]/g, '');
  if (/^\+?\d+$/.test(compact)) {
    const digits = compact.replace(/^\+/, '');
    const complete =
      digits.length === 10 ||
      (digits.length === 11 && digits.startsWith('0')) ||
      (digits.length === 13 && digits.startsWith('234'));
    return complete ? digits : null;
  }
  const tag = trimmed.replace(/^@/, '').toLowerCase();
  return /^[a-z0-9_]{3,}$/.test(tag) ? tag : null;
}

/** Banks whose name, short name or CBN code contains the search, by name. */
export function searchBanks(banks: readonly Bank[], search: string): Bank[] {
  const q = search.trim().toLowerCase();
  return banks
    .filter(
      (b) =>
        !q ||
        b.name.toLowerCase().includes(q) ||
        (b.short_name ?? '').toLowerCase().includes(q) ||
        b.code.startsWith(q),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
}

export interface CopVerdict {
  tone: Extract<Tone, 'success' | 'warning' | 'danger'>;
  title: string;
  message: string;
  /** No match: the customer must say they checked before they can go on. */
  needsAcknowledgement: boolean;
}

/**
 * What to tell the customer about a Confirmation of Payee answer (TRF-3). The
 * wording follows the scam pattern it guards against: a fraudster gives one
 * name and an account in another.
 */
export function copVerdict(match: NameMatch, accountName: string): CopVerdict {
  const typed = match.expected_name?.trim() || i18n.t('transfers.cop.typedFallback');
  switch (match.result) {
    case 'match':
      return {
        tone: 'success',
        title: i18n.t('transfers.cop.match.title'),
        message: i18n.t('transfers.cop.match.message', { name: accountName }),
        needsAcknowledgement: false,
      };
    case 'close_match':
      return {
        tone: 'warning',
        title: i18n.t('transfers.cop.close.title'),
        message: i18n.t('transfers.cop.close.message', { name: accountName, typed }),
        needsAcknowledgement: false,
      };
    case 'no_match':
      return {
        tone: 'danger',
        title: i18n.t('transfers.cop.none.title'),
        message: i18n.t('transfers.cop.none.message', { name: accountName, typed }),
        needsAcknowledgement: true,
      };
  }
}
