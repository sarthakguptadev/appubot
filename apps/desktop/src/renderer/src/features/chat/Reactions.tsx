// Emoji reactions (chat-core reactions.ts): a smiley beside a bot's reply opens five quick ones in Rare UI's pill and
// "+" for more; the user's reaction shows as a chip under the reply (click it to take it back), the bot's under the
// user's message.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import type { Message } from '@appubot/protocol';
import { MORE_REACTIONS, QUICK_REACTIONS, reactionBy } from '@appubot/chat-core';
import { Plus, Smile } from '../../components/ui/icons';
import { Icon, Tooltip, cn } from '../../components/ui';
import { EMOJI_SURFACE, EmojiBar, useEmojiBurst } from '../../components/rare/EmojiReaction';
import { optimisticCall } from '../../lib/optimistic';

/**
 * Set (or take back, `emoji` null) the user's reaction: at once on screen, kept over what the computer says until it
 * answers (lib/optimistic.ts), put back if it refuses.
 */
export async function reactTo(msg: Message, emoji: string | null): Promise<void> {
  const prev = msg.reactions ?? [];
  const next = [...prev.filter((r) => r.by !== 'user'), ...(emoji ? [{ emoji, by: 'user' as const, at: Date.now() }] : [])];
  await optimisticCall('chat.react', { threadId: msg.threadId, messageId: msg.id, emoji }, [{ kind: 'reactions', threadId: msg.threadId, messageId: msg.id, reactions: next }], { errorTitle: 'Could not react' });
}

const EDGE = 8;
/** the pill sits this far from the smiley: room for its tail's two dots */
const GAP = 16;

/**
 * The smiley beside a reply and its picker, Rare UI's emoji reaction (components/rare/EmojiReaction.tsx): a pill
 * whose emoji pop in one after another and lift under the pointer, two dots trailing back to the smiley, and a small
 * flock of the picked emoji drifting up. It opens above the smiley (below when there's no room), in a portal on top
 * of the page and kept inside the window, so wherever the smiley sits nothing spills past the transcript. "+" opens
 * the rest in a panel under the pill. Esc, a click outside or scrolling closes it.
 */
export function ReactionButton({ msg, className }: { msg: Message; className?: string }) {
  const [open, setOpen] = useState(false);
  const [more, setMore] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ left: number; top: number; side: 'top' | 'bottom'; tailX: number } | null>(null);
  const mine = reactionBy(msg, 'user');
  const reduced = useReducedMotion();
  const { burst, layer } = useEmojiBurst('sm');

  useLayoutEffect(() => {
    if (!open) { setAt(null); return; }
    const a = ref.current?.getBoundingClientRect();
    const el = pop.current;
    if (!a || !el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const left = Math.max(EDGE, Math.min(a.left + a.width / 2 - w / 2, window.innerWidth - EDGE - w));
    const above = a.top - GAP - h;
    const side = above >= EDGE ? 'top' as const : 'bottom' as const;
    // the tail stays over the smiley wherever the pill was pushed to
    setAt({ left, top: side === 'top' ? above : a.bottom + GAP, side, tailX: a.left + a.width / 2 - left });
  }, [open, more]);

  useEffect(() => {
    if (!open) { setMore(false); return; }
    const down = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node) && !pop.current?.contains(e.target as Node)) setOpen(false); };
    const scroll = (e: Event) => { if (!pop.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    window.addEventListener('mousedown', down);
    window.addEventListener('keydown', key, true);
    window.addEventListener('scroll', scroll, true);
    return () => { window.removeEventListener('mousedown', down); window.removeEventListener('keydown', key, true); window.removeEventListener('scroll', scroll, true); };
  }, [open]);

  const pick = (emoji: string, from?: DOMRect) => {
    const taking = emoji === mine;
    // the flock rises from the emoji that was pressed, and goes on after the pill has closed
    if (!taking && from) burst(emoji, from);
    setOpen(false);
    void reactTo(msg, taking ? null : emoji);
  };
  const top = at?.side !== 'bottom';

  return (
    <span ref={ref} className={cn('relative inline-flex', open && 'opacity-100!', className)}>
      <Tooltip label="React">
        <button
          type="button"
          aria-label="React"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="ab-pill inline-flex size-6 items-center justify-center rounded-md text-muted transition-colors hover:bg-fg/5 hover:text-fg focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_var(--ab-ring)]"
        >
          <Icon icon={Smile} size={14} />
        </button>
      </Tooltip>
      {layer}
      {createPortal(
        <AnimatePresence>
          {open ? (
            <motion.div
              ref={pop}
              key="pill"
              style={at ? { left: at.left, top: at.top, originY: top ? 1 : 0 } : { left: 0, top: 0, visibility: 'hidden' }}
              className={cn('fixed z-[75] flex max-w-[calc(100vw-16px)] flex-col gap-1.5', !top && 'flex-col-reverse')}
              initial={{ opacity: 0, y: top ? 10 : -10, scale: 0.85 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: top ? 6 : -6, scale: 0.9 }}
              transition={reduced ? { duration: 0.15 } : { type: 'spring', stiffness: 520, damping: 30 }}
            >
              {more ? (
                <div className={cn('grid grid-cols-8 gap-0.5 rounded-[20px] p-1.5', EMOJI_SURFACE)}>
                  {MORE_REACTIONS.map((e) => (
                    <button
                      key={e} type="button" aria-label={`React ${e}`}
                      onClick={(ev) => pick(e, ev.currentTarget.getBoundingClientRect())}
                      className={cn('flex size-8 items-center justify-center rounded-full text-[18px] leading-none transition-transform duration-100 hover:scale-[1.2] hover:bg-black/5 dark:hover:bg-white/10', e === mine && 'bg-black/10 dark:bg-white/15')}
                    >
                      {e}
                    </button>
                  ))}
                </div>
              ) : null}
              <EmojiBar
                emojis={QUICK_REACTIONS}
                active={mine}
                size="sm"
                side={top ? 'top' : 'bottom'}
                tailX={at?.tailX}
                onPick={pick}
                trailing={(
                  <button
                    type="button" aria-label="More reactions" aria-expanded={more} onClick={() => setMore((v) => !v)}
                    className={cn('relative z-10 ml-0.5 flex size-[34px] items-center justify-center rounded-full text-[#868593] transition-colors hover:bg-black/5 hover:text-black dark:hover:bg-white/10 dark:hover:text-white', more && 'bg-black/5 text-black dark:bg-white/10 dark:text-white')}
                  >
                    <Icon icon={Plus} size={16} />
                  </button>
                )}
              />
            </motion.div>
          ) : null}
        </AnimatePresence>,
        document.body,
      )}
    </span>
  );
}

/** A reaction chip: the user's own (click to take it back) or the bot's. */
export function ReactionChip({ msg, by, botName }: { msg: Message; by: 'user' | 'bot'; botName?: string }) {
  const emoji = reactionBy(msg, by);
  if (!emoji) return null;
  const label = by === 'user' ? `You reacted ${emoji}. Click to remove` : `${botName ?? 'The bot'} reacted ${emoji}`;
  // `chat-reaction`: the Messages theme redraws it as a chip on the bubble's edge (themes/messages.css)
  const CHIP = 'chat-reaction ab-pill squircle inline-flex h-6 items-center rounded-control-sm border border-[var(--ab-hairline)] bg-[color-mix(in_srgb,var(--ab-fg)_9%,var(--ab-surface))] px-2 text-copy leading-none shadow-[0_1px_2px_rgba(0,0,0,.08)]';
  return by === 'user' ? (
    <button type="button" title={label} aria-label={label} onClick={() => void reactTo(msg, null)} className={cn(CHIP, 'transition-colors hover:bg-surface-2')}>{emoji}</button>
  ) : (
    <span title={label} aria-label={label} className={CHIP}>{emoji}</span>
  );
}
