/**
 * AppuBot design tokens: near-neutral surfaces, a warm coral-orange accent, filled squircle controls (no pills
 * since 2026-11-14), thin 1.5px line icons. Shared by desktop (via tokens.css)
 * and mobile (via these TS objects).
 */

export const ramps = {
  indigo: { 50: '#fafcff', 100: '#e8effc', 200: '#d2dff9', 300: '#a7c0f1', 400: '#81a0e9', 500: '#6a88e2', 600: '#556adc', 700: '#4250d5', 800: '#3333cc', 900: '#212191', 950: '#11115b' },
  orange: { 50: '#fffbfa', 100: '#feede6', 200: '#fddcce', 300: '#f9bb9e', 400: '#f59970', 500: '#f38858', 600: '#ee7944', 700: '#e96c2f', 800: '#e6651b', 900: '#a5460f', 950: '#682906' },
  grey: { 50: '#f9f9f9', 100: '#f5f5f5', 200: '#f0f0f0', 300: '#e6e6e6', 400: '#cccccc', 500: '#b3b3b3', 600: '#999999', 700: '#666666', 800: '#525252', 900: '#3d3d3d', 950: '#292929' },
  green: { 50: '#f2f8eb', 100: '#e3f1d8', 400: '#90c85b', 500: '#83c040', 600: '#6ea335', 700: '#496d21', 900: '#263d0e' },
  yellow: { 50: '#fff8e6', 100: '#fff0cf', 400: '#ffb94a', 500: '#feb12b', 600: '#df9c2a', 800: '#a27224', 900: '#6b4c1c' },
  red: { 50: '#fde7e2', 100: '#f8d1c6', 300: '#db715c', 400: '#c43d2b', 500: '#b81514', 600: '#a21913', 700: '#781a11', 900: '#52170e' },
  pink: { 50: '#fceaf0', 100: '#f9d5e1', 300: '#e380a8', 400: '#d4508e', 500: '#b12060', 700: '#871f4b', 950: '#4d192c' },
} as const;

export interface SemanticColors {
  bg: string; surface: string; surface2: string; surface3: string;
  fg: string; fg2: string; muted: string; inverse: string;
  border: string; borderSubtle: string;
  /** .5px lines around cards, popovers and the composer (desktop --ab-hairline) */
  hairline: string;
  primary: string; primaryFg: string;
  accent: string; accentStrong: string; accentSoft: string;
  link: string; ring: string;
  success: string; successSoft: string; warning: string; warningSoft: string; danger: string; dangerSoft: string;
  userBubble: string; agentBubble: string; codeBg: string;
  /** menus and sheets */
  popover: string;
  /** the prompt box: its fill and outline */
  composer: string; composerBorder: string;
  /** the roster's unread dot */
  unread: string;
  diffAdd: string; diffDel: string;
}

/*
 * Mirrors tokens.css. Desktop draws on macOS vibrancy (glass); these are the same inks over an opaque page, which is
 * what the phone and desktop's non-glass fallback show. Neutrals are ink at low alpha, as on desktop. The page and
 * the raised tone are the neutral background's (backgrounds.ts); `withBackground` swaps in a tinted one's.
 */
export const light: SemanticColors = {
  bg: '#fdfdfd', surface: '#ffffff', surface2: 'rgba(28,28,28,0.05)', surface3: 'rgba(28,28,28,0.09)',
  fg: '#1c1c1c', fg2: 'rgba(28,28,28,0.76)', muted: 'rgba(28,28,28,0.6)', inverse: '#fdfdfd',
  border: 'rgba(28,28,28,0.1)', borderSubtle: 'rgba(28,28,28,0.06)', hairline: 'rgba(28,28,28,0.12)',
  primary: '#1c1c1c', primaryFg: '#ffffff',
  accent: '#ee7944', accentStrong: '#c74614', accentSoft: 'rgba(238,121,68,0.13)',
  link: '#c74614', ring: 'rgba(238,121,68,0.7)',
  success: '#3f7f1f', successSoft: 'rgba(110,163,53,0.14)', warning: '#8a5f1a', warningSoft: 'rgba(254,177,43,0.18)', danger: '#b81514', dangerSoft: 'rgba(184,21,20,0.09)',
  // the bot's bubble: ink at 6% on the page, a flat grey with no outline (2026-11-17)
  userBubble: 'rgba(28,28,28,0.03)', agentBubble: 'rgba(28,28,28,0.06)', codeBg: 'rgba(28,28,28,0.04)',
  popover: 'rgba(255,255,255,0.94)',
  composer: '#ffffff', composerBorder: 'rgba(28,28,28,0.12)',
  unread: '#2e8eff',
  diffAdd: '#1a7f37', diffDel: '#cf222e',
};

/*
 * Dark is three flat tones, as tokens.css has them (the owner's call 2026-11-11): the page #121212, everything raised
 * on it (cards, buttons, the composer, menus) #1f1f1f, and #282828 for what sits on that; ink alphas for muted text,
 * borders and the bubble.
 */
export const dark: SemanticColors = {
  bg: '#121212', surface: '#1f1f1f', surface2: 'rgba(252,252,252,0.056)', surface3: 'rgba(252,252,252,0.1)',
  fg: '#fcfcfc', fg2: 'rgba(252,252,252,0.78)', muted: 'rgba(252,252,252,0.58)', inverse: '#0d0d0d',
  border: 'rgba(252,252,252,0.072)', borderSubtle: 'rgba(252,252,252,0.046)', hairline: 'rgba(255,255,255,0.09)',
  primary: '#fcfcfc', primaryFg: '#0d0d0d',
  accent: '#f58056', accentStrong: '#f58056', accentSoft: 'rgba(245,128,86,0.16)',
  link: '#f58056', ring: 'rgba(245,128,86,0.65)',
  success: '#90c85b', successSoft: 'rgba(144,200,91,0.16)', warning: '#ffb94a', warningSoft: 'rgba(255,185,74,0.16)', danger: '#e02e2a', dangerSoft: 'rgba(224,46,42,0.16)',
  userBubble: 'rgba(252,252,252,0.026)', agentBubble: 'rgba(252,252,252,0.055)', codeBg: 'rgba(252,252,252,0.026)',
  popover: 'rgba(31,31,31,0.95)',
  // the composer is the raised tone, all but solid
  composer: '#1f1f1f', composerBorder: 'rgba(252,252,252,0.04)',
  unread: '#4c9dff',
  diffAdd: '#3fb950', diffDel: '#f85149',
};

/** The tone above the raised one (dark #282828; light a faint ink on white): what sits on a card. */
export const raised2 = { light: '#f3f3f3', dark: '#282828' } as const;

/**
 * Shapes since the 2026-11-14 overhaul (tokens.css `--radius-*`): squircle controls, cards and sheets, no pills and
 * no round buttons. The desktop's numbers are for a 36px control; `phoneShape` is the same scale for a 44pt one.
 */
export const shape = { controlSm: 8, control: 10, controlLg: 12, row: 10, pop: 14, card: 16, sheet: 22 } as const;
export const phoneShape = { controlSm: 9, control: 12, controlLg: 14, row: 14, pop: 20, card: 20, sheet: 28 } as const;
/** type roles (sizes only): a note, dense chrome, body, a chat's text, a card's title, a page's heading */
export const roles = { note: 12, ui: 13, copy: 14, lead: 15, title: 16, heading: 22, trackingUi: -0.01 } as const;

export const radius = { sm: 8, md: 12, lg: 16, xl: 24, xxl: 32, pill: 9999 } as const;
export const spacing = { 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 8: 32, 10: 40, 12: 48 } as const;
export const type = {
  label: 12, caption: 14, body: 16, bodyLg: 18, card: 20, h2: 28, h1: 36, metric: 48, hero: 56,
  trackingDisplay: -0.025, trackingHeading: -0.02,
} as const;
export const fonts = {
  display: 'InstrumentSans', // open substitute for Sarvam's Season Mix
  sans: 'system',            // the platform's UI font (SF Pro on Apple platforms), as on desktop
  mono: 'JetBrainsMono',     // Synara's code face
} as const;
export const motion = {
  fast: 150, normal: 200, moderate: 300, slow: 500, entrance: 700,
  easeReveal: [0.25, 1, 0.5, 1] as const, easeUi: [0.2, 0, 0, 1] as const,
} as const;
export const icon = { size: 20, sizeDense: 16, strokeWidth: 1.5 } as const;

/** Signature hero glow: orange → amber → periwinkle → near white. */
export const heroGlow = ['#F9730C', '#FFB053', '#A5BBFC', '#F4F7FF'] as const;

export type Theme = { name: 'light' | 'dark'; colors: SemanticColors };
export const themes: Record<'light' | 'dark', Theme> = {
  light: { name: 'light', colors: light },
  dark: { name: 'dark', colors: dark },
};

export { BACKGROUNDS, DEFAULT_BACKGROUND, backgroundOf, isBackgroundId, withBackground } from './backgrounds';
export type { Background, BackgroundId, BackgroundTones } from './backgrounds';
