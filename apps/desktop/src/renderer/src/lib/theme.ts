import { useEffect } from 'react';
import { native } from './native';
import { macSettingsOf, setState, useStore } from './store';

/** The colour scheme is this app's own: this Mac's setting, also with an AppuBot computer on screen (lib/thisMac.ts). */
export function useIsDark(): boolean {
  const pref = useStore((s) => macSettingsOf(s)?.theme ?? 'system');
  const nativeDark = useStore((s) => s.nativeDark);
  return pref === 'dark' || (pref === 'system' && nativeDark);
}

/** Keeps `.dark` on <html> in sync with settings.theme + the OS appearance, and tells main about the choice. */
export function useThemeSync(): void {
  const pref = useStore((s) => macSettingsOf(s)?.theme ?? 'system');
  const dark = useIsDark();

  useEffect(() => {
    const api = native();
    let alive = true;
    void api.getNativeTheme().then((d) => { if (alive) setState({ nativeDark: d }); }).catch(() => undefined);
    const off = api.onNativeTheme((d) => setState({ nativeDark: d }));
    return () => { alive = false; off(); };
  }, []);

  useEffect(() => {
    void native().setTheme(pref).catch(() => undefined);
  }, [pref]);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
  }, [dark]);

  // glass needs the native vibrancy that only the macOS Electron window has; data-platform places the window chrome
  useEffect(() => {
    document.documentElement.dataset.platform = native().platform;
    const glass = !!(window as Partial<Window>).appubot && native().platform === 'darwin';
    document.documentElement.dataset.glass = glass ? 'on' : 'off';
  }, []);
}
