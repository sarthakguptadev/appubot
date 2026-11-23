// A thread with nothing in it yet. It doesn't stay so: the bot opens every thread itself (2026-11-17, the owner's
// "remove the dither animation in a new thread and the other stuff; a thread shouldn't be new any time, the agent
// should send a message to initiate": core `ChatService.openThread`), so there is no landing any more, no animated
// field, no "Message <bot>" and no suggestions to press: only the bot, at rest, for the moment before its first words
// (or where no turn can run: its agent not signed in), and what the system still has to allow as chips under it.
import type { ReactNode } from 'react';
import type { Bot } from '@appubot/protocol';
import { BotAvatar } from '../../components/ui';

/** The empty chat's chip (the system's asks sit in a centred row of them): Suggestions.tsx `SetupPill chip` wears it. */
export const LANDING_CHIP = 'ab-press ab-pill squircle inline-flex h-9 items-center rounded-control bg-[color-mix(in_srgb,var(--ab-fg)_5%,var(--ab-content))] px-3.5 text-copy font-medium text-fg-2 shadow-edge hover:bg-[color-mix(in_srgb,var(--ab-fg)_9%,var(--ab-content))] hover:text-fg focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_var(--ab-bg),0_0_0_4px_var(--ab-ring)]';

export function EmptyThread({ bot, setup }: {
  bot: Bot | undefined;
  /** what the system still has to allow (computer access, notifications), as chips */
  setup?: ReactNode;
}) {
  return (
    <div className="relative flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-6 pb-8">
      <div className="flex max-w-[46rem] animate-[message-enter_240ms_var(--ease-out-quint)_both] flex-col items-center text-center">
        <BotAvatar bot={bot} size={40} />
        {setup ? <div className="mt-6 flex flex-wrap justify-center gap-2">{setup}</div> : null}
      </div>
    </div>
  );
}
