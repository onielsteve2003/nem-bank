import i18n from '@/lib/i18n';

// The legal documents (SET-6). The words live in legal.docs.<slug> and are read
// in the current language; the section order is fixed here. Bump `updated`
// whenever a document's meaning changes.

const SECTIONS = {
  terms: ['about', 'eligibility', 'security', 'payments', 'disputes', 'closing', 'law'],
  privacy: ['controller', 'collect', 'why', 'sharing', 'ai', 'retention', 'rights', 'contact'],
} as const;

export type LegalSlug = keyof typeof SECTIONS;

export const LEGAL_UPDATED: Record<LegalSlug, string> = {
  terms: '2026-11-02T12:00:00+01:00',
  privacy: '2026-11-02T12:00:00+01:00',
};

export type LegalDocument = {
  slug: LegalSlug;
  title: string;
  summary: string;
  updated: string;
  sections: { key: string; title: string; body: string }[];
};

const isSlug = (slug: string): slug is LegalSlug => Object.hasOwn(SECTIONS, slug);

/** The document in the current language, or null for an unknown slug. */
export function legalDocument(slug: string): LegalDocument | null {
  if (!isSlug(slug)) return null;
  const key = `legal.docs.${slug}` as const;
  const text: Record<string, { title: string; body: string }> = i18n.t(`${key}.sections`, {
    returnObjects: true,
  });
  return {
    slug,
    title: i18n.t(`${key}.title`),
    summary: i18n.t(`${key}.summary`),
    updated: LEGAL_UPDATED[slug],
    sections: SECTIONS[slug].map((section) => ({ key: section, ...text[section]! })),
  };
}
