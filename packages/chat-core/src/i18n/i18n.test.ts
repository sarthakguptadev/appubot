import { afterEach, describe, expect, it } from 'vitest';
import { LOCALES, addTranslations, en, getLocale, interpolate, intlLocale, isRtl, matchLocale, missingKeys, onLocaleChange, resolveLocale, setLocale, t, tn } from './index';
import { TRANSLATIONS } from './translations';

addTranslations(TRANSLATIONS);

afterEach(() => setLocale('en', false));

describe('matching the system language', () => {
  it('takes an exact tag, then the same language, else English', () => {
    expect(matchLocale(['pt-BR'])).toBe('pt-BR');
    expect(matchLocale(['pt-PT', 'en'])).toBe('pt-BR');
    expect(matchLocale(['es-MX'])).toBe('es');
    expect(matchLocale(['zh-Hans-SG'])).toBe('zh-CN');
    expect(matchLocale(['ZH-cn'])).toBe('zh-CN');
    expect(matchLocale(['sv', 'fi'])).toBe('en');
    expect(matchLocale([])).toBe('en');
    expect(matchLocale(['ar-EG'])).toBe('ar');
    expect(matchLocale(['nl-BE'])).toBe('nl');
    expect(matchLocale(['en_US'.replace('_', '-'), 'th-TH'])).toBe('en');
  });

  it('knows which languages read right to left', () => {
    expect(isRtl('ar')).toBe(true);
    expect(isRtl('en')).toBe(false);
    expect(isRtl('hi')).toBe(false);
  });

  it('prefers the first tag the system lists that we have', () => {
    expect(matchLocale(['sv', 'fr-CA', 'en'])).toBe('fr');
    expect(matchLocale(['fr-CA', 'ja'])).toBe('fr');
  });

  it('resolves the setting: a chosen language wins, Automatic and junk follow the system', () => {
    expect(resolveLocale('hi', ['en'])).toBe('hi');
    expect(resolveLocale('auto', ['de-AT'])).toBe('de');
    expect(resolveLocale('klingon', ['ko'])).toBe('ko');
    expect(resolveLocale(null, ['it'])).toBe('it');
  });
});

describe('translating', () => {
  it('fills parameters and leaves unknown ones visible', () => {
    expect(interpolate('Message {name} on {machine}', { name: 'Ada', machine: 'Mac' })).toBe('Message Ada on Mac');
    expect(interpolate('Keep {thisMachine} awake', {})).toBe('Keep {thisMachine} awake');
  });

  it('speaks the chosen language and falls back to English for a key a dictionary lacks', () => {
    setLocale('es');
    expect(t('common.cancel')).toBe('Cancelar');
    expect(t('composer.message', { name: 'Ada' })).toBe('Mensaje para Ada');
    expect(t('no.such.key')).toBe('no.such.key');
    expect(getLocale()).toBe('es');
    expect(intlLocale()).toBe('es');
    setLocale('en', false);
    expect(intlLocale()).toBeUndefined();
  });

  it('picks plural forms by the language’s rules', () => {
    expect(tn('sidebar.phonesOnline', 1)).toBe('1 phone online');
    expect(tn('sidebar.phonesOnline', 3)).toBe('3 phones online');
    setLocale('ru');
    expect(tn('sidebar.phonesOnline', 1)).toBe('1 телефон в сети');
    expect(tn('sidebar.phonesOnline', 3)).toBe('3 телефона в сети');
    expect(tn('sidebar.phonesOnline', 5)).toBe('5 телефонов в сети');
    setLocale('ja');
    expect(tn('sidebar.phonesOnline', 2)).toBe('2台のスマートフォンがオンライン');
    setLocale('pl');
    expect(tn('sidebar.phonesOnline', 2)).toBe('2 telefony online');
    expect(tn('sidebar.phonesOnline', 5)).toBe('5 telefonów online');
    setLocale('ar');
    expect(tn('sidebar.phonesOnline', 0)).toBe('لا هواتف متصلة');
    expect(tn('sidebar.phonesOnline', 2)).toBe('هاتفان متصلان');
    expect(tn('sidebar.phonesOnline', 3)).toBe('3 هواتف متصلة');
    setLocale('vi');
    expect(tn('sidebar.phonesOnline', 1)).toBe('1 điện thoại đang trực tuyến');
  });

  it('tells listeners of a change, once per real change', () => {
    let n = 0;
    const off = onLocaleChange(() => { n += 1; });
    setLocale('fr');
    setLocale('fr');
    setLocale('fr', false);
    off();
    setLocale('de');
    expect(n).toBe(2);
  });

  it('has every language translated in full, parameters kept', () => {
    for (const l of LOCALES) {
      if (l.code === 'en') continue;
      expect(missingKeys(l.code), l.code).toEqual([]);
      const dict = TRANSLATIONS[l.code]!;
      for (const [key, value] of Object.entries(dict)) {
        const source: string | undefined = en[key as keyof typeof en];
        if (!source) continue; // a plural form English lacks
        const params = [...source.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
        for (const p of params) expect(value, `${l.code} ${key}`).toContain(`{${p}}`);
      }
    }
  });
});
