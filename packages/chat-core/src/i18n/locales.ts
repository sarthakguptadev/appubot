/**
 * The languages the apps' interface speaks. `code` is the BCP 47 tag the dictionaries are keyed by and the one given
 * to `Intl` for dates and numbers; `native` is how the language names itself (what the Language setting shows);
 * `rtl` marks a language written right to left (the desktop sets `<html dir>` from it).
 */
export const LOCALES = [
  { code: 'en', name: 'English', native: 'English' },
  { code: 'es', name: 'Spanish', native: 'Español' },
  { code: 'fr', name: 'French', native: 'Français' },
  { code: 'de', name: 'German', native: 'Deutsch' },
  { code: 'it', name: 'Italian', native: 'Italiano' },
  { code: 'pt-BR', name: 'Portuguese (Brazil)', native: 'Português (Brasil)' },
  { code: 'nl', name: 'Dutch', native: 'Nederlands' },
  { code: 'pl', name: 'Polish', native: 'Polski' },
  { code: 'tr', name: 'Turkish', native: 'Türkçe' },
  { code: 'uk', name: 'Ukrainian', native: 'Українська' },
  { code: 'ru', name: 'Russian', native: 'Русский' },
  { code: 'ar', name: 'Arabic', native: 'العربية', rtl: true },
  { code: 'hi', name: 'Hindi', native: 'हिन्दी' },
  { code: 'bn', name: 'Bengali', native: 'বাংলা' },
  { code: 'id', name: 'Indonesian', native: 'Bahasa Indonesia' },
  { code: 'vi', name: 'Vietnamese', native: 'Tiếng Việt' },
  { code: 'th', name: 'Thai', native: 'ไทย' },
  { code: 'ja', name: 'Japanese', native: '日本語' },
  { code: 'zh-CN', name: 'Chinese (Simplified)', native: '简体中文' },
  { code: 'ko', name: 'Korean', native: '한국어' },
] as const;

export type LocaleCode = (typeof LOCALES)[number]['code'];

/** Whether the language is written right to left (Arabic). */
export function isRtl(code: LocaleCode): boolean {
  return !!(LOCALES.find((l) => l.code === code) as { rtl?: boolean } | undefined)?.rtl;
}

/** The interface language setting: follow the system, or one of ours. */
export type LanguageSetting = 'auto' | LocaleCode;

export const DEFAULT_LOCALE: LocaleCode = 'en';

export function isLocaleCode(s: string): s is LocaleCode {
  return LOCALES.some((l) => l.code === s);
}

/** The locale's entry (its names), for the picker. */
export function localeInfo(code: LocaleCode): (typeof LOCALES)[number] {
  return LOCALES.find((l) => l.code === code) ?? LOCALES[0];
}

/**
 * The best of our locales for the system's language tags, in the order the system prefers them (`navigator.languages`,
 * `Intl.DateTimeFormat().resolvedOptions().locale`): an exact tag first ("pt-BR"), then one of the same language
 * ("pt-PT" → pt-BR, "zh-Hans-SG" → zh-CN, "es-MX" → es); English when none fits.
 */
export function matchLocale(tags: readonly string[]): LocaleCode {
  // the person's order wins: their second language in full beats their third one exactly
  for (const tag of tags.map((t) => t.trim().toLowerCase()).filter(Boolean)) {
    const exact = LOCALES.find((l) => l.code.toLowerCase() === tag);
    if (exact) return exact.code;
    const lang = tag.split('-')[0]!;
    const same = LOCALES.find((l) => l.code.toLowerCase().split('-')[0] === lang);
    if (same) return same.code;
  }
  return DEFAULT_LOCALE;
}

/** What the setting resolves to: `auto` follows the system, a known code is itself, anything else follows the system. */
export function resolveLocale(setting: string | null | undefined, systemTags: readonly string[]): LocaleCode {
  if (setting && setting !== 'auto' && isLocaleCode(setting)) return setting;
  return matchLocale(systemTags);
}
