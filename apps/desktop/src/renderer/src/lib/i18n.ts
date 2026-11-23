import { useEffect, useSyncExternalStore } from 'react';
import { LOCALES, addTranslations, getLocale, hasTranslations, isLocaleCode, isRtl, localeInfo, matchLocale, onLocaleChange, resolveLocale, setLocale, t, tn, type LanguageSetting, type LocaleCode } from '@appubot/chat-core';
import { PLATFORM } from './platform';

/*
 * The interface's language, a device-local preference like the appearance ones (not synced to the computer: the
 * phone and another Mac each read in their own): Settings › General › Language, `auto` (the default) following the
 * system's language (`navigator.languages`, matched to one of ours by chat-core `matchLocale`). It drives chat-core's
 * `t()`/`tn()` and, for a chosen language, the locale every date and number formatter there uses (`intlLocale`);
 * on Automatic those keep the system's own habits. `<html lang>` follows it too.
 */
const KEY = 'appubot:language';

function read(): LanguageSetting {
  try {
    const v = localStorage.getItem(KEY);
    return v && v !== 'auto' && isLocaleCode(v) ? v : 'auto';
  } catch { return 'auto'; }
}

let setting: LanguageSetting = read();

/** The system's language tags, most preferred first. */
export function systemTags(): string[] {
  if (typeof navigator === 'undefined') return [];
  return [...(navigator.languages ?? []), navigator.language].filter((s): s is string => !!s);
}

/** What Automatic resolves to here. */
export function systemLocale(): LocaleCode { return matchLocale(systemTags()); }

/**
 * Every language but English is a chunk of its own (~200 KB the window would otherwise parse at every launch), loaded
 * once the interface needs one: before the first render when the setting or the system asks for one (`i18nReady`),
 * and before a language picked later is applied, so nothing shows in English first.
 */
let loading: Promise<void> | null = null;
function loadTranslations(): Promise<void> {
  loading ??= import('@appubot/chat-core/translations').then((m) => addTranslations(m.TRANSLATIONS));
  return loading;
}
const wanted = (): LocaleCode => resolveLocale(setting, systemTags());

/** Resolves once the language the interface will start in can be drawn: at once (null) for English. */
export function i18nReady(): Promise<void> | null {
  return hasTranslations(wanted()) ? null : loadTranslations().catch(() => undefined);
}

/** Apply the setting now (main.tsx, before the first render; again by `useI18n`). */
export function applyLanguage(): void { apply(); }

function apply(): void {
  const code = wanted();
  // (a language whose strings aren't here yet is applied when they are)
  if (!hasTranslations(code)) { void loadTranslations().then(apply, () => undefined); return; }
  setLocale(code, setting !== 'auto');
  if (typeof document !== 'undefined') {
    document.documentElement.lang = code;
    // Arabic reads right to left: the whole layout follows (flex rows, text alignment), as the system's apps do
    document.documentElement.dir = isRtl(code) ? 'rtl' : 'ltr';
  }
}

export function languageSetting(): LanguageSetting { return setting; }

export function setLanguage(next: LanguageSetting): void {
  setting = next;
  try { if (next === 'auto') localStorage.removeItem(KEY); else localStorage.setItem(KEY, next); } catch { /* storage unavailable */ }
  apply();
}

const subscribe = (cb: () => void) => onLocaleChange(cb);

/** The interface's current language; a component using it re-renders when it changes. */
export function useLocale(): LocaleCode { return useSyncExternalStore(subscribe, getLocale, getLocale); }

export function useLanguageSetting(): LanguageSetting { useLocale(); return setting; }

/** `t` for a component: the same function, but the component re-renders when the language changes. */
export function useT(): typeof t { useLocale(); return t; }

/** Mounted once at the app's root: applies the setting and follows the system's language while on Automatic. */
export function useI18n(): void {
  useEffect(() => {
    apply();
    const onChange = () => { if (setting === 'auto') apply(); };
    window.addEventListener('languagechange', onChange);
    return () => window.removeEventListener('languagechange', onChange);
  }, []);
}

/** The kind of computer this is, in the current language, for `{machine}` / `{thisMachine}` in strings. */
export function machineParams(): { machine: string; thisMachine: string } {
  if (PLATFORM === 'darwin') return { machine: t('machine.mac'), thisMachine: t('machine.thisMac') };
  if (PLATFORM === 'win32') return { machine: t('machine.pc'), thisMachine: t('machine.thisPc') };
  return { machine: t('machine.computer'), thisMachine: t('machine.thisComputer') };
}

// before the first render, so nothing flashes in English first
if (typeof document !== 'undefined') apply();

export { LOCALES, localeInfo, t, tn, type LanguageSetting, type LocaleCode };
