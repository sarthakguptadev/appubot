// The Messages theme's bubble (themes/messages.css; lib/appearance.ts `useMessagesTheme`): a hairlined bubble with a
// tail on its sender's side and the time inside at the bottom right, your own with its ticks. Used by the chat
// (UserMessage, AgentTurn's reply bubbles) and a group's room. The classic theme keeps its own bubbles.
import type { CSSProperties, ReactNode } from 'react';
import { clockTime } from '@appubot/chat-core';
import { cn } from '../../components/ui';

/** Where a bubble sits in a run of bubbles from one side: the run's last (or only) one carries the tail. */
export type BubbleSpot = 'only' | 'first' | 'middle' | 'last';

/**
 * The tail's outline from the bubble's side edge to its bottom edge, for a bubble on the left (the right one is
 * mirrored), in px from the border box's bottom corner on the border's centre line: down the side, round a tight
 * corner, a notch, the point hanging under the bubble, and back up into the bottom edge.
 */
const TAIL_LINE = 'M0 -20V-11C0 -5.2 2.6 -1.9 6.4 -.5C7.4 -.1 7.7 .5 7.3 1.5C6.9 2.9 6.3 4.1 5.5 5.1C5.1 5.6 5.3 6 5.9 5.9C9.7 5.5 13.2 3.8 15.4 1.6C16.3 .6 17.4 0 18.8 0H24';

function Tail() {
  return (
    <svg className="chat-bubble-tail" viewBox="0 -20 24 28" aria-hidden>
      <g>
        <path className="fill" d={`${TAIL_LINE}V-20Z`} />
        <path className="line" d={TAIL_LINE} />
      </g>
    </svg>
  );
}

/** Two ticks (delivered) or a small clock (still on its way). */
function Ticks({ pending }: { pending?: boolean }) {
  if (pending) {
    return (
      <svg data-pending width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" aria-hidden>
        <circle cx="6" cy="6" r="4.6" /><path d="M6 3.6V6l1.6 1" />
      </svg>
    );
  }
  return (
    <svg width="16" height="11" viewBox="0 0 16 11" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M1 6.2l2.9 2.9L10 1.6" /><path d="M7.6 8.3l.9.8L14.6 1.6" />
    </svg>
  );
}

/** "12:29 pm": the clock time in the chosen style and language, in small letters as a messaging app sets it. */
export function stampText(at: number): string {
  return clockTime(at).toLowerCase();
}

export function Bubble({ side, spot = 'only', at, pending, tail, className, style, children }: {
  /** `out`: your own message, at the right; `in`: the bot's, at the left */
  side: 'in' | 'out';
  spot?: BubbleSpot;
  /** when it was sent: shown inside, at the bottom right (none while a reply still streams) */
  at?: number;
  /** your own message still on its way: a clock in the ticks' place */
  pending?: boolean;
  /** whether it carries the tail; by default a run's last (or only) bubble does */
  tail?: boolean;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  const tailed = tail ?? (spot === 'only' || spot === 'last');
  const stamp = at === undefined ? null : stampText(at);
  return (
    <div
      className={cn('chat-bubble', side === 'in' ? 'chat-bubble--in' : 'chat-bubble--out', className)}
      data-spot={spot}
      data-tail={tailed ? '' : undefined}
      data-stamp={stamp ? '' : undefined}
      // the invisible copy of the time that ends the last paragraph (messages.css)
      style={stamp ? { ...style, '--stamp': JSON.stringify(stamp) } as CSSProperties : style}
    >
      {children}
      {stamp ? (
        <span className="chat-bubble-stamp">
          {stamp}
          {side === 'out' ? <Ticks pending={pending} /> : null}
        </span>
      ) : null}
      {tailed ? <Tail /> : null}
    </div>
  );
}
