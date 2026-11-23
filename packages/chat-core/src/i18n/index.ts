/**
 * The interface's language (desktop `lib/i18n.ts` sets it from Settings › General › Language, or the system's;
 * the phone the same): `t` gives a string of the current language, English where one isn't translated yet;
 * `tn` picks a plural form; `intlLocale()` is what every date and number formatter here is given (`format.ts`),
 * so they follow the chosen language too (undefined: the system's own habits, while the setting is Automatic).
 */
import { DEFAULT_LOCALE, type LocaleCode } from './locales';
import { en, type MessageKey, type Messages } from './en';

export * from './locales';
export { en, type MessageKey, type Messages } from './en';
// every language but English, ~200 KB: never read by `t` from here (it would be in every bundle that translates), but
// handed to `addTranslations` by each app, the phone at once, the desktop as a chunk of its own once one is chosen
export { TRANSLATIONS } from './translations';

export type MessageParams = Record<string, string | number>;

let current: LocaleCode = DEFAULT_LOCALE;
/** the BCP 47 tag for `Intl`; undefined = the system's */
let intl: string | undefined;
let plurals: Intl.PluralRules | null = null;
const listeners = new Set<() => void>();

/**
 * Set the interface's language. `forIntl` says whether dates and numbers should follow it too: the apps pass false
 * while the setting is Automatic (the system already formats as the person is used to) and true for a chosen one.
 */
export function setLocale(code: LocaleCode, forIntl = true): void {
  const next = forIntl ? code : undefined;
  if (code === current && next === intl) return;
  current = code;
  intl = next;
  plurals = null;
  for (const l of listeners) l();
}

export function getLocale(): LocaleCode { return current; }

/** The locale to give `Intl` and `toLocale*String`: the chosen language, or undefined for the system's own. */
export function intlLocale(): string | undefined { return intl; }

/** Hear of every language change (the apps re-render on it). */
export function onLocaleChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The other languages' strings, as the app has given them (`addTranslations`); English is always here. */
const tables: Partial<Record<LocaleCode, Messages>> = {};

/**
 * Give `t` the strings of other languages (chat-core's `TRANSLATIONS`, or some of them). Until a language's are here
 * it reads in English; components following `onLocaleChange` draw again once they come.
 */
export function addTranslations(more: Partial<Record<LocaleCode, Messages>>): void {
  Object.assign(tables, more);
  plurals = null;
  for (const l of listeners) l();
}

/** Whether `code`'s strings are here (English always is). */
export function hasTranslations(code: LocaleCode): boolean { return code === DEFAULT_LOCALE || !!tables[code]; }

const dictionary = (code: LocaleCode): Messages => (code === DEFAULT_LOCALE ? en : tables[code] ?? {});

/** Fill `{name}` parameters. An unknown parameter is left as it is, so a wrong translation shows rather than hides. */
export function interpolate(template: string, params?: MessageParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m));
}

/** The string `key` in the current language (English when it isn't translated), with its parameters filled. */
export function t(key: MessageKey | (string & {}), params?: MessageParams): string {
  const k = key as MessageKey;
  const s = dictionary(current)[k] ?? en[k] ?? key;
  return interpolate(s, params);
}

/** A plural: `key_one` / `key_other` (and `_zero`, `_two`, `_few`, `_many` where a language has them) by `count`. */
export function tn(key: string, count: number, params?: MessageParams): string {
  plurals ??= new Intl.PluralRules(current);
  const form = plurals.select(count);
  const dict = dictionary(current);
  const pick = (d: Messages): string | undefined => d[`${key}_${form}` as MessageKey] ?? d[`${key}_other` as MessageKey];
  const s = pick(dict) ?? pick(en) ?? key;
  return interpolate(s, { count, ...params });
}

/** The languages a dictionary covers, for a check that every one of ours has every key (`i18n.test.ts`). */
export function missingKeys(code: LocaleCode): MessageKey[] {
  const dict = dictionary(code);
  // a plural form the language doesn't have (Japanese has no "one") isn't missing
  const forms = new Set(new Intl.PluralRules(code).resolvedOptions().pluralCategories);
  return (Object.keys(en) as MessageKey[]).filter((k) => {
    if (k in dict) return false;
    const form = /_(zero|one|two|few|many|other)$/.exec(k)?.[1];
    return !form || forms.has(form as Intl.LDMLPluralRule);
  });
}
