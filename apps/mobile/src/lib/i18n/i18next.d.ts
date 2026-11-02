import 'i18next';

import type en from './locales/en.json';

// Typed keys: t('settings.tytle') is a compile error, not a blank label.
declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation';
    resources: { translation: typeof en };
    returnNull: false;
  }
}
