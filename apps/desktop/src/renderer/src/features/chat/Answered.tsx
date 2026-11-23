// What an interactive card leaves behind once it is answered (2026-11-17, the owner's "after the answer is put, don't
// show it; the same for every other interactive card, it should go"): no card. What was asked and answered in words
// reads as the conversation it was: the bot's question as its bubble, your answer as yours (`AnsweredExchange`). A
// card that was a decision or a setup step (a bot or routine allowed, a Vault item, an app or Telegram connected, any
// of them declined) leaves one quiet line (`AnsweredLine`), so what was allowed stays on the record.
import { sentBubble } from '@appubot/chat-core';
import { Check, X } from '../../components/ui/icons';
import { Icon, cn } from '../../components/ui';

/** the reply bubble's fill, sheen, padding and type, and the sent bubble's (AgentTurn.tsx `REPLY_BUBBLE`, UserMessage.tsx `SENT_BUBBLE`: both import the cards, so the classes are named here) */
const ASKED = 'chat-bubble-reply squircle w-fit max-w-[88%] min-w-9 rounded-[18px] bg-agent-bubble px-3 py-[7px] text-[15px] leading-[22px] tracking-[.01em] text-fg';
const SAID = 'chat-bubble-sent squircle w-fit max-w-[88%] min-w-9 rounded-[18px] px-3 py-[7px] text-lead leading-5';

/** The bot's question and your answer, as two messages. `ask` left out: only what you answered. */
export function AnsweredExchange({ ask, answer, botColor, secret }: { ask?: string; answer: string; botColor?: string; secret?: boolean }) {
  const bubble = sentBubble(botColor ?? '#8e8e93');
  return (
    <div className="flex w-full min-w-0 flex-col gap-1.5">
      {ask?.trim() ? <div className={cn(ASKED, 'max-h-[22rem] overflow-y-auto whitespace-pre-wrap break-words')}>{ask.trim()}</div> : null}
      <div className="flex min-w-0 justify-end">
        <div
          className={cn(SAID, 'whitespace-pre-wrap break-words', secret && 'tracking-widest')}
          style={{ backgroundColor: bubble.fill, color: bubble.ink }}
        >
          {answer}
        </div>
      </div>
    </div>
  );
}

/** One quiet line where a card was: what was decided or done ("Allowed · Scout", "Connected Gmail", "Declined"). */
export function AnsweredLine({ text, declined }: { text: string; declined?: boolean }) {
  return (
    <div className="flex w-full min-w-0 items-center justify-center gap-1.5 py-0.5 text-note text-muted">
      <Icon icon={declined ? X : Check} size={12} strokeWidth={2.4} className="shrink-0" />
      <span className="min-w-0 truncate">{text}</span>
    </div>
  );
}
