import { useEffect, useSyncExternalStore } from 'react';
import { setClockStyle, type ClockStyle } from '@appubot/chat-core';
import { DEFAULT_BACKGROUND, backgroundOf, isBackgroundId, type BackgroundId } from '@appubot/theme';
import { IS_MAC } from './platform';

/*
 * Device-local appearance preferences (not synced to the gateway):
 *  - window translucency → CSS var --ab-glass-opacity on <html> (20–100%; unset = the theme's default)
 *  - "Reduce transparency" → html[data-glass="off"] (opaque coat + cards); on unless turned off ('0' saved)
 *  - glass opacity (T3 Code's): how solid menus and the chat box are (dialogs are solid, like Settings) → --ab-solid-boost (-1…1, tokens.css)
 *  - render math, the send shortcut and the clock style (12/24 hours, chat-core `setClockStyle`)
 *  - the empty chat's animated dithered background (features/chat/DitherBackground.tsx)
 *  - tooltips (components/ui/Tooltip.tsx): off unless turned on ('1' saved)
 *  - what a chat shows of the bot's work (features/chat/WorkTrail.tsx): its replies alone, or the work trail above
 *    them too; off unless turned on ('1' saved)
 *  - the background (packages/theme `backgrounds.ts`): the app's flat tones in a tint → `--ab-bg-*` on <html>, which
 *    tokens.css reads for the sidebar, the page and what is raised on them; `neutral` sets none
 *  - the shape of controls (index.css `.ab-pill`): `round`, pills and circles (the default), or `squircle`, the
 *    rounded squares from before → html[data-shape]
 *  - the theme (themes/messages.css): `messages`, a messaging app's look (the default), or `classic`, AppuBot's
 *    original → html[data-theme]; it works in light and dark, which stay the colour scheme's (settings.theme)
 * useThemeSync (lib/theme.ts) sets data-glass on boot from the platform; useAppearance runs after it and only
 * forces "off" when the user asked for it, so the platform default still wins otherwise.
 */
const OPACITY_KEY = 'appubot:glass-opacity';
const OFF_KEY = 'appubot:glass-off';
const SOLID_KEY = 'appubot:surface-solid';
const MATH_KEY = 'appubot:math';
const SEND_KEY = 'appubot:send-key';
const CLOCK_KEY = 'appubot:clock';
const ANIMATED_BACKGROUND_KEY = 'appubot:ascii-background';
const TOOLTIPS_KEY = 'appubot:tooltips';
const WORK_KEY = 'appubot:chat-work';
const THEME_KEY = 'appubot:app-theme';
const BACKGROUND_KEY = 'appubot:background';
const SHAPE_KEY = 'appubot:shape';
/**
 * How buttons, one-line fields, chips and the other small controls are cut: `round` (the default) makes them pills, and
 * circles where they are square; `squircle` keeps the rounded squares they were until 2026-11-17. Cards, menus, rows
 * and multi-line fields are the same in both.
 */
export type ControlShape = 'round' | 'squircle';
export const DEFAULT_SHAPE: ControlShape = 'round';
/**
 * How the app is drawn. `messages` (the default): a messaging app's chat, warm tones, a faint wallpaper, bubbles with
 * tails and the time inside, the composer as floating pieces. `classic`: the look from before themes.
 */
export type AppTheme = 'messages' | 'classic';
export const APP_THEMES: readonly AppTheme[] = ['messages', 'classic'];
// `classic` until the Messages theme is finished and has its switch in Settings › Appearance (2026-11-13: the work on
// it stopped part-way, with no switch, and the owner hasn't seen it): nobody's app changes its look by itself.
// `?look=messages` shows it in the mocks; make it the default by changing this one line.
export const DEFAULT_THEME: AppTheme = 'classic';
export const GLASS_MIN = 20;
export const GLASS_MAX = 100;
/** The default in tokens.css (both themes): 20%, the most see-through. */
export const GLASS_DEFAULT = 20;

/** Glass opacity's slider: 0 most see-through, 100 solid; 50 is the theme's own. */
export const SOLID_DEFAULT = 50;
/** Enter sends (Shift+Enter breaks the line), or ⌘/Ctrl+Enter sends and Enter breaks it. */
export type SendKey = 'enter' | 'mod-enter';

export interface Appearance {
  opacity: number | null;
  reduceTransparency: boolean;
  /** menus and the chat box: 0–100, null = the theme's own (50) */
  solid: number | null;
  /** LaTeX in replies as typeset maths (KaTeX; chat-core `normalizeMathDelimiters` keeps prices as text) */
  math: boolean;
  sendKey: SendKey;
  clock: ClockStyle;
  /** the empty chat's animated dithered field; on unless turned off ('0' saved) */
  animatedBackground: boolean;
  /** hover labels on buttons and cut-off text; off unless turned on ('1' saved) */
  tooltips: boolean;
  /**
   * Chat shows "Everything": the bot's work (calls, thoughts, narration) as a trail above its reply, after MonoCode's;
   * off ("Answers") unless turned on ('1' saved). This device's choice: `settings.chatView` stays as it is.
   */
  workTrail: boolean;
  theme: AppTheme;
  /** the app's tones in a tint (Settings › Appearance › Background); `neutral` is the app's own */
  background: BackgroundId;
  /** pills and circles, or squircles (Settings › Appearance › Buttons) */
  shape: ControlShape;
}

function read(): Appearance {
  const prefs: Appearance = { opacity: null, reduceTransparency: true, solid: null, math: true, sendKey: 'enter', clock: 'auto', animatedBackground: true, tooltips: false, workTrail: false, theme: DEFAULT_THEME, background: DEFAULT_BACKGROUND, shape: DEFAULT_SHAPE };
  try {
    const num = (key: string, min: number, max: number): number | null => {
      const raw = localStorage.getItem(key);
      const n = raw === null ? NaN : Number(raw);
      return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : null;
    };
    prefs.opacity = num(OPACITY_KEY, GLASS_MIN, GLASS_MAX);
    prefs.reduceTransparency = localStorage.getItem(OFF_KEY) !== '0';
    prefs.solid = num(SOLID_KEY, 0, 100);
    // on unless turned off ('0' saved)
    prefs.math = localStorage.getItem(MATH_KEY) !== '0';
    prefs.animatedBackground = localStorage.getItem(ANIMATED_BACKGROUND_KEY) !== '0';
    prefs.tooltips = localStorage.getItem(TOOLTIPS_KEY) === '1';
    prefs.workTrail = localStorage.getItem(WORK_KEY) === '1';
    if (localStorage.getItem(SEND_KEY) === 'mod-enter') prefs.sendKey = 'mod-enter';
    const clock = localStorage.getItem(CLOCK_KEY);
    if (clock === '12h' || clock === '24h') prefs.clock = clock;
    const theme = localStorage.getItem(THEME_KEY);
    if (APP_THEMES.includes(theme as AppTheme)) prefs.theme = theme as AppTheme;
    // the mocks and screenshots: ?look=classic|messages (for this page only, nothing saved)
    const look = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('look');
    if (APP_THEMES.includes(look as AppTheme)) prefs.theme = look as AppTheme;
    const background = localStorage.getItem(BACKGROUND_KEY);
    if (isBackgroundId(background)) prefs.background = background;
    // ?bg=slate|plum|…: a background for this page only (the mocks and screenshots)
    const bg = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('bg');
    if (isBackgroundId(bg)) prefs.background = bg;
    if (localStorage.getItem(SHAPE_KEY) === 'squircle') prefs.shape = 'squircle';
    // ?shape=round|squircle: for this page only (the mocks and screenshots)
    const shape = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('shape');
    if (shape === 'round' || shape === 'squircle') prefs.shape = shape;
    // ?work=1|0: the work trail on or off for this page (the mocks and screenshots)
    const work = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('work');
    if (work === '1' || work === '0') prefs.workTrail = work === '1';
  } catch { /* storage unavailable */ }
  return prefs;
}

/** A background's tones as the custom properties tokens.css reads; the neutral one clears them. */
function paintBackground(html: HTMLElement, id: BackgroundId): void {
  const b = backgroundOf(id);
  for (const scheme of ['light', 'dark'] as const) {
    for (const tone of ['side', 'page', 'raised'] as const) {
      const name = `--ab-bg-${tone}-${scheme}`;
      if (b.id === DEFAULT_BACKGROUND) html.style.removeProperty(name);
      else html.style.setProperty(name, b[scheme][tone]);
    }
  }
  html.dataset.background = b.id;
}

let current = read();
// before the first paint, so the window never shows a frame of the other theme or background
try {
  document.documentElement.dataset.theme = current.theme;
  document.documentElement.dataset.shape = current.shape;
  paintBackground(document.documentElement, current.background);
} catch { /* no document (tests) */ }
const listeners = new Set<() => void>();
let platformGlass: string | undefined;

function apply(): void {
  const html = document.documentElement;
  if (current.opacity === null) html.style.removeProperty('--ab-glass-opacity');
  else html.style.setProperty('--ab-glass-opacity', `${current.opacity}%`);
  if (current.solid === null) html.style.removeProperty('--ab-solid-boost');
  else html.style.setProperty('--ab-solid-boost', String((current.solid - SOLID_DEFAULT) / SOLID_DEFAULT));
  html.dataset.theme = current.theme;
  html.dataset.shape = current.shape;
  paintBackground(html, current.background);
  setClockStyle(current.clock);
  // remember what the platform chose so turning the switch back off restores it
  if (platformGlass === undefined) platformGlass = html.dataset.glass ?? (IS_MAC ? 'on' : 'off');
  html.dataset.glass = current.reduceTransparency ? 'off' : platformGlass;
}

function update(patch: Partial<Appearance>): void {
  current = { ...current, ...patch };
  try {
    if (current.opacity === null) localStorage.removeItem(OPACITY_KEY);
    else localStorage.setItem(OPACITY_KEY, String(current.opacity));
    if (current.reduceTransparency) localStorage.removeItem(OFF_KEY);
    else localStorage.setItem(OFF_KEY, '0');
    const keep = (key: string, value: string | null) => { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); };
    keep(SOLID_KEY, current.solid === null ? null : String(current.solid));
    keep(MATH_KEY, current.math ? null : '0');
    keep(ANIMATED_BACKGROUND_KEY, current.animatedBackground ? null : '0');
    keep(TOOLTIPS_KEY, current.tooltips ? '1' : null);
    keep(WORK_KEY, current.workTrail ? '1' : null);
    keep(SEND_KEY, current.sendKey === 'enter' ? null : current.sendKey);
    keep(CLOCK_KEY, current.clock === 'auto' ? null : current.clock);
    keep(THEME_KEY, current.theme === DEFAULT_THEME ? null : current.theme);
    keep(BACKGROUND_KEY, current.background === DEFAULT_BACKGROUND ? null : current.background);
    keep(SHAPE_KEY, current.shape === DEFAULT_SHAPE ? null : current.shape);
  } catch { /* storage unavailable */ }
  apply();
  listeners.forEach((l) => l());
}

export const appearance = {
  setOpacity(pct: number): void { update({ opacity: Math.min(GLASS_MAX, Math.max(GLASS_MIN, Math.round(pct))) }); },
  resetOpacity(): void { update({ opacity: null }); },
  setReduceTransparency(on: boolean): void { update({ reduceTransparency: on }); },
  setSolid(v: number): void { update({ solid: Math.min(100, Math.max(0, Math.round(v))) }); },
  resetSolid(): void { update({ solid: null }); },
  setMath(on: boolean): void { update({ math: on }); },
  setAnimatedBackground(on: boolean): void { update({ animatedBackground: on }); },
  setTooltips(on: boolean): void { update({ tooltips: on }); },
  setWorkTrail(on: boolean): void { update({ workTrail: on }); },
  setSendKey(k: SendKey): void { update({ sendKey: k }); },
  setClock(c: ClockStyle): void { update({ clock: c }); },
  setTheme(theme: AppTheme): void { update({ theme }); },
  setBackground(background: BackgroundId): void { update({ background }); },
  setShape(shape: ControlShape): void { update({ shape }); },
};

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Whether this Enter sends, by the send shortcut (Settings › Appearance); otherwise it breaks the line. */
export function isSendKey(e: { key: string; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }): boolean {
  if (e.key !== 'Enter' || e.shiftKey) return false;
  const mod = e.metaKey || e.ctrlKey;
  return current.sendKey === 'enter' ? !mod : mod;
}

/** The preferences now, outside React (the composer's keys). */
export function appearanceNow(): Appearance { return current; }

/** Current appearance preferences (re-renders on change). */
export function useAppearancePrefs(): Appearance {
  return useSyncExternalStore(subscribe, () => current);
}

/** Whether the Messages theme is on: the chat draws tails, times in the bubbles and neutral sent bubbles (re-renders on change). */
export function useMessagesTheme(): boolean {
  return useSyncExternalStore(subscribe, () => current.theme === 'messages');
}

/** Whether the chat shows the bot's work as a trail above its replies (re-renders on change). */
export function useWorkTrail(): boolean {
  return useSyncExternalStore(subscribe, () => current.workTrail);
}

/** Apply the saved appearance on boot. Call after useThemeSync() so its data-glass effect runs first. */
export function useAppearance(): void {
  useEffect(() => { apply(); }, []);
}
