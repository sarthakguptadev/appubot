// The ⌘K palette's rows and footer (T3 Code's sizes: rows of 36, the matched words in semibold, a footer of keys),
// shared with the lists that work like it (Settings' search).
import type { ReactNode } from 'react';
import { ArrowDown, ArrowUp } from '../ui/icons';
import { Icon, Kbd } from '../ui';
import { splitByRanges, type SearchRange } from './paletteSearch';

/** a rounded rectangle, the palette's corners less the list's 8px (22 − 8 = 14), darker while pressed */
export const PALETTE_ROW = 'squircle flex min-h-9 w-full items-center gap-2.5 rounded-pop px-2 py-1.5 text-left outline-none active:bg-[color-mix(in_srgb,var(--ab-fg)_10%,transparent)]';
/** the highlighted row's wash (the pointer moves it, so it stays light) */
export const PALETTE_ROW_ON = 'bg-[color-mix(in_srgb,var(--ab-fg)_7%,transparent)]';

const FOOTER_KEY = 'h-[18px] min-w-[18px] bg-[color-mix(in_srgb,var(--ab-fg)_8%,transparent)] text-fg';

/** A name with its matched words in semibold. */
export function Marked({ text, ranges }: { text: string; ranges?: SearchRange[] }): ReactNode {
  if (!ranges?.length) return text;
  return splitByRanges(text, ranges).map((p, i) => (p.hit ? <mark key={i} className="bg-transparent font-semibold text-fg">{p.text}</mark> : p.text));
}

/** The keys the list answers to: ↑↓ Navigate, ↵ and what Enter does, then Escape's (and any other) keys. */
export function PaletteFooter({ verb, escKeys, escLabel }: { verb?: string; escKeys: string[]; escLabel: string }) {
  return (
    <div className="flex shrink-0 items-center gap-3 border-t border-[color-mix(in_srgb,var(--ab-fg)_7%,transparent)] bg-[color-mix(in_srgb,var(--ab-fg)_2.5%,transparent)] px-4 py-2.5 text-note font-medium text-muted">
      <span className="flex items-center gap-1.5">
        <Kbd className={FOOTER_KEY}><Icon icon={ArrowUp} size={11} /></Kbd>
        <Kbd className={FOOTER_KEY}><Icon icon={ArrowDown} size={11} /></Kbd>
        Navigate
      </span>
      {verb ? <span className="flex items-center gap-1.5"><Kbd className={FOOTER_KEY}>↵</Kbd>{verb}</span> : null}
      <span className="flex items-center gap-1.5">{escKeys.map((k) => <Kbd key={k} className={FOOTER_KEY}>{k}</Kbd>)}{escLabel}</span>
    </div>
  );
}
