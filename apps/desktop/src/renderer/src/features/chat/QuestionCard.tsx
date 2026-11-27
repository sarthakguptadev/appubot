// The agent's ask_user question as an inline card (adapted from Akeru's PendingUserInputChoices,
// ComposerPendingUserInputPanel and UserInputAnswerCard, MIT): a bold question over lettered rows
// (an A/B key chip each, a fill under the pointer in the frame it arrives). Answering folds the card to the chosen
// row: its chip turns the accent at once, the other rows close over 200 ms and the question dims, so what was
// asked and answered stays where it was. Styles: `.gen-q*` in index.css.
import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import type { Part } from '@appubot/protocol';
import { PenLine } from '../../components/ui/icons';
import { Icon, Kbd, cn } from '../../components/ui';
import { answerQuestion, usePendingAnswers } from '../../lib/actions';

type QuestionPart = Extract<Part, { type: 'question' }>;

/** A, B, C… for the rows (the keys that pick them too) */
const letter = (i: number) => String.fromCharCode(65 + i);
/** the rows' keys: the letters, then the old 1–9 */
const KEYS = 9;

const FOLD = { duration: 0.2, ease: [0.25, 1, 0.5, 1] } as const;

function KeyChip({ children, chosen }: { children: React.ReactNode; chosen?: boolean }) {
  return <span aria-hidden className="gen-q-key" data-chosen={chosen || undefined}>{children}</span>;
}

function OwnAnswerRow({ disabled, inputRef, onAnswer }: { disabled: boolean; inputRef: React.RefObject<HTMLInputElement | null>; onAnswer: (text: string) => void }) {
  const [text, setText] = useState('');
  const trimmed = text.trim();
  return (
    <label className="gen-q-row flex w-full cursor-text items-center gap-3">
      <KeyChip><Icon icon={PenLine} size={12} strokeWidth={2.2} /></KeyChip>
      <input
        ref={inputRef}
        type="text"
        value={text}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' || e.nativeEvent.isComposing || !trimmed) return;
          e.preventDefault();
          onAnswer(trimmed);
        }}
        placeholder="Type your own answer"
        aria-label="Type your own answer"
        className="min-w-0 flex-1 bg-transparent text-copy text-fg outline-none placeholder:text-muted"
      />
      {trimmed ? <Kbd className="shrink-0">↵</Kbd> : null}
    </label>
  );
}

const isTyping = (t: EventTarget | null) => t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || (t instanceof HTMLElement && t.isContentEditable);

/** `expired`: the turn ended without an answer, so the options no longer go anywhere. */
export function QuestionCard({ part, botName, expired }: { part: QuestionPart; botName: string; expired: boolean }) {
  // an answer shows as given the moment it's picked (lib/actions.ts `answerQuestion`: back, with an error, if refused)
  const pendingAnswer = usePendingAnswers((s) => s[part.questionId]);
  const own = useRef<HTMLInputElement>(null);
  const reduce = useReducedMotion();
  const answer = part.answer ?? pendingAnswer ?? null;
  const open = !answer && !expired;

  const submit = (value: string) => {
    if (!open) return;
    void answerQuestion(part.questionId, value);
  };

  // a row's letter (or its number) picks it while focus is not in a text field
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      const key = e.key.toUpperCase();
      const i = /^[A-Z]$/.test(key) ? key.charCodeAt(0) - 65 : Number(e.key) - 1;
      const option = Number.isInteger(i) && i >= 0 && i < KEYS ? part.options[i] : undefined;
      if (option) { e.preventDefault(); submit(option); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  const chosen = answer ? part.options.indexOf(answer) : -1;
  const exit = reduce ? { opacity: 0, transition: { duration: 0 } } : { height: 0, opacity: 0, marginTop: 0, transition: FOLD };
  return (
    <section aria-label={part.question} className="gen-q chat-generative squircle w-full max-w-[34rem]" data-answered={answer ? true : undefined}>
      <div className="flex flex-col gap-0.5 px-2 pb-2">
        <span className="text-note text-muted">{expired && !answer ? `${botName} asked` : `${botName} asks`}</span>
        {/* questions can be several lines (a bot asking to change another bot shows the whole new text): keep them */}
        <span className={cn('block max-h-[22rem] overflow-y-auto text-copy leading-snug font-bold whitespace-pre-wrap break-words', answer ? 'text-muted' : 'text-fg')}>{part.question}</span>
      </div>
      <div className="flex flex-col" data-unavailable={expired && !answer ? true : undefined}>
        {/* an answer from before (a restart, another window) shows folded straight away */}
        <AnimatePresence initial={false}>
          {part.options.map((o, i) => (!answer || i === chosen ? (
            <motion.div key={o} exit={exit} className="overflow-hidden">
              <button
                type="button"
                disabled={!open}
                aria-pressed={i === chosen}
                onClick={() => submit(o)}
                className="gen-q-row flex w-full items-center gap-3 text-left text-copy text-fg"
              >
                <KeyChip chosen={i === chosen}>{letter(i)}</KeyChip>
                <span className="min-w-0 flex-1 break-words">{o}</span>
              </button>
            </motion.div>
          ) : null))}
          {answer && chosen < 0 ? (
            <div key="own-answer" className="gen-q-row flex w-full items-center gap-3 text-copy text-fg" aria-pressed>
              <KeyChip chosen><Icon icon={PenLine} size={12} strokeWidth={2.2} /></KeyChip>
              <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{answer}</span>
            </div>
          ) : null}
          {open ? (
            <motion.div key="own" exit={exit} className="overflow-hidden">
              <OwnAnswerRow disabled={!open} inputRef={own} onAnswer={submit} />
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
      {expired && !answer ? <p className="px-2 pt-1 text-note text-muted">This question ended without an answer.</p> : null}
    </section>
  );
}
