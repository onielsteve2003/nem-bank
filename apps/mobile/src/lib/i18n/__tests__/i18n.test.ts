import i18n, { languageFor, localized, type TranslationKey } from '..';
import en from '../locales/en.json';
import pcm from '../locales/pcm.json';

/** Every string in a catalogue by its dotted key, arrays as key[i]. */
function strings(catalogue: object, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(catalogue)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') out.set(key, v);
    else if (Array.isArray(v)) v.forEach((s: string, i) => out.set(`${key}[${i}]`, s));
    else for (const [kk, vv] of strings(v as object, key)) out.set(kk, vv);
  }
  return out;
}

const placeholders = (s: string) => (s.match(/\{\{\s*\w+\s*\}\}/g) ?? []).sort();

afterEach(async () => {
  await i18n.changeLanguage('en');
});

it('reads strings from the English catalogue with values filled in', () => {
  expect(i18n.t('settings.title')).toBe('Settings');
  expect(i18n.t('me.checkupScore', { score: 82 })).toBe('Checkup score 82 of 100');
  expect(i18n.t('settings.minutes', { count: 5 })).toBe('5 min');
});

it('has every English string in Pidgin, with the same placeholders', () => {
  const english = strings(en);
  const pidgin = strings(pcm);
  expect([...pidgin.keys()].sort()).toEqual([...english.keys()].sort());
  for (const [key, text] of english) {
    expect({ key, placeholders: placeholders(pidgin.get(key)!) }).toEqual({
      key,
      placeholders: placeholders(text),
    });
  }
});

it('speaks Pidgin, plurals included', async () => {
  await i18n.changeLanguage('pcm');
  expect(i18n.t('common.tryAgain')).toBe('Try am again');
  expect(i18n.t('lock.wrong', { count: 1 })).toBe('Wrong PIN. 1 try remain.');
  expect(i18n.t('lock.wrong', { count: 2 })).toBe('Wrong PIN. 2 tries remain.');
});

it('falls back to English for a string Pidgin lacks', async () => {
  i18n.addResource('en', 'translation', 'fallbackProbe', 'Only in English');
  await i18n.changeLanguage('pcm');
  expect(i18n.t('fallbackProbe' as TranslationKey)).toBe('Only in English');
});

it('reads lookup tables in the current language each time', async () => {
  const table = localized({ done: 'transactions.status.completed', retry: 'common.tryAgain' });
  expect(Object.keys(table)).toEqual(['done', 'retry']);
  expect(table.retry).toBe('Try again');

  await i18n.changeLanguage('pcm');
  expect(table.retry).toBe('Try am again');
  expect(table.done).toBe('E don complete');
});

it('starts in the phone language only when Nem speaks it', () => {
  expect(languageFor('pcm')).toBe('pcm');
  expect(languageFor('en')).toBe('en');
  expect(languageFor('fr')).toBe('en');
  expect(languageFor(undefined)).toBe('en');
});
