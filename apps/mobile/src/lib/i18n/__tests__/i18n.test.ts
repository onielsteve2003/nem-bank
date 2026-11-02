import i18n, { languageFor } from '..';

it('reads strings from the English catalogue with values filled in', () => {
  expect(i18n.t('settings.title')).toBe('Settings');
  expect(i18n.t('me.checkupScore', { score: 82 })).toBe('Checkup score 82 of 100');
  expect(i18n.t('settings.minutes', { count: 5 })).toBe('5 min');
});

it('falls back to English for a language that lacks a string', async () => {
  await i18n.changeLanguage('pcm');
  expect(i18n.t('tabs.home')).toBe('Home');
  await i18n.changeLanguage('en');
});

it('starts in the phone language only when Nem speaks it', () => {
  expect(languageFor('pcm')).toBe('pcm');
  expect(languageFor('en')).toBe('en');
  expect(languageFor('fr')).toBe('en');
  expect(languageFor(undefined)).toBe('en');
});
