// i18n configuration — supported locales, default, persistence key.
//
// Per docs/09-design-system.md the platform ships English first with Hindi
// next (Marathi/Tamil to follow), so this is modelled as an open list of
// locales rather than a hard-coded en/hi pair. Adding a locale = add the
// code here + a dictionary under ./dictionaries/<code>.

export const LOCALES = ['en', 'hi'] as const;

export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'en';

// Cookie + localStorage key. The cookie lets the server component (root
// layout) render <html lang> and the initial dictionary correctly so there
// is no flash of the wrong language and no hydration mismatch.
export const LOCALE_STORAGE_KEY = 'locale';

// Short label shown in the language switcher, in the language's own script.
export const LOCALE_LABELS: Record<Locale, string> = {
  en: 'EN',
  hi: 'हिं',
};

// Full endonym for menus / accessibility labels.
export const LOCALE_NAMES: Record<Locale, string> = {
  en: 'English',
  hi: 'हिन्दी',
};

export function isLocale(value: string | undefined | null): value is Locale {
  return value === 'en' || value === 'hi';
}
