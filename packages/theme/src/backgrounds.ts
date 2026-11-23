/**
 * Backgrounds: the app's flat tones in a tint of the person's choosing (Settings › Appearance › Background).
 *
 * A background is nothing but three tones for each colour scheme: the sidebar, the page (the chat, pages, dialogs)
 * and what is raised on them (cards, the composer, menus). Everything else, the inks, hairlines, bubbles and
 * controls, is an alpha of ink over those, so it follows by itself. `neutral` is the app as it has always been.
 *
 * The tinted ones sit on the neutral one's own lightness steps (OKLCH), with a little chroma in one hue, so every
 * background keeps the same contrast: the sidebar a step darker than the page in both schemes, raised a step
 * lighter in dark and white in light. Desktop: tokens.css reads them through `--ab-bg-*` (lib/appearance.ts sets
 * those on <html>). The phone lays them over `light` / `dark` with `withBackground`.
 */
import type { SemanticColors } from './index';

export type BackgroundId = 'neutral' | 'slate' | 'ocean' | 'moss' | 'cocoa' | 'rose' | 'plum' | 'indigo';

export interface BackgroundTones {
  /** the sidebar and Settings' nav */
  side: string;
  /** the chat, pages and dialogs */
  page: string;
  /** cards, the composer, menus */
  raised: string;
}

export interface Background {
  id: BackgroundId;
  /** its English name (the apps translate it: `appearance.background.<id>`) */
  name: string;
  light: BackgroundTones;
  dark: BackgroundTones;
}

export const DEFAULT_BACKGROUND: BackgroundId = 'neutral';

export const BACKGROUNDS: readonly Background[] = [
  { id: 'neutral', name: 'Neutral', light: { side: '#f7f7f7', page: '#fdfdfd', raised: '#ffffff' }, dark: { side: '#0e0e0e', page: '#121212', raised: '#1f1f1f' } },
  { id: 'slate', name: 'Slate', light: { side: '#f1f6fc', page: '#fafcff', raised: '#ffffff' }, dark: { side: '#0a0e14', page: '#0e1218', raised: '#182029' } },
  { id: 'ocean', name: 'Ocean', light: { side: '#eef7f9', page: '#f9fdfe', raised: '#ffffff' }, dark: { side: '#081011', page: '#0b1416', raised: '#132225' } },
  { id: 'moss', name: 'Moss', light: { side: '#f1f8f2', page: '#fafdfb', raised: '#ffffff' }, dark: { side: '#0a100b', page: '#0e140f', raised: '#18221a' } },
  { id: 'cocoa', name: 'Cocoa', light: { side: '#fbf4ef', page: '#fefcf9', raised: '#ffffff' }, dark: { side: '#120d08', page: '#17110c', raised: '#261d15' } },
  { id: 'rose', name: 'Rose', light: { side: '#fcf3f4', page: '#fffbfb', raised: '#ffffff' }, dark: { side: '#130c0d', page: '#181010', raised: '#281b1c' } },
  { id: 'plum', name: 'Plum', light: { side: '#f8f3fa', page: '#fdfbfe', raised: '#ffffff' }, dark: { side: '#100c12', page: '#151016', raised: '#231c26' } },
  { id: 'indigo', name: 'Indigo', light: { side: '#f3f5ff', page: '#fbfcff', raised: '#ffffff' }, dark: { side: '#0c0d16', page: '#10111a', raised: '#1c1e2d' } },
];

export function isBackgroundId(value: unknown): value is BackgroundId {
  return typeof value === 'string' && BACKGROUNDS.some((b) => b.id === value);
}

/** The background by id; an id this build doesn't know is the neutral one. */
export function backgroundOf(id: string | null | undefined): Background {
  return BACKGROUNDS.find((b) => b.id === id) ?? BACKGROUNDS[0]!;
}

/** A scheme's colours on a background: its page, raised tone, composer and menus (the phone's theme). */
export function withBackground(colors: SemanticColors, tones: BackgroundTones): SemanticColors {
  return { ...colors, bg: tones.page, surface: tones.raised, composer: tones.raised, popover: tones.raised };
}
