// The agent's ask_user question as an inline card (adapted from Akeru's PendingUserInputChoices,
// ComposerPendingUserInputPanel and UserInputAnswerCard, MIT). Styles: `.gen-*` in index.css.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Part } from '@appubot/protocol';
import { PenLine } from '../../components/ui/icons';
import { Icon, Kbd, cn } from '../../components/ui';
import { answerQuestion, usePendingAnswers } from '../../lib/actions';
import { AnsweredExchange } from './Answered';

type QuestionPart = Extract<Part, { type: 'question' }>;

function ChoiceMark({ checked, className }: { checked: boolean; className?: string }) {
  return (
    <span aria-hidden className={cn('gen-mark', className)} data-checked={checked || undefined}>
      <span className="gen-mark-dot" />
    </span>
  );
}

function ChoiceButton({ pressed, disabled, shortcut, onClick, children }: { pressed: boolean; disabled: boolean; shortcut: string | null; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className="gen-choice ab-press squircle flex w-full items-start gap-3 rounded-control-lg bg-surface-2 px-3 py-2.5 text-left [--press:.985] enabled:hover:bg-surface-3 disabled:cursor-default"
    >
      <ChoiceMark checked={pressed} className="mt-0.5" />
      <span className="min-w-0 flex-1 text-copy font-medium text-fg">{children}</span>
      {shortcut ? <Kbd className="mt-px shrink-0">{shortcut}</Kbd> : null}
    </button>
  );
}

function OwnAnswerRow({ disabled, inputRef, onAnswer }: { disabled: boolean; inputRef: React.RefObject<HTMLInputElement | null>; onAnswer: (text: string) => void }) {
  const [text, setText] = useState('');
  const trimmed = text.trim();
  return (
    <label className={cn('gen-choice squircle flex w-full items-center gap-3 rounded-control-lg border border-transparent px-3 py-2.5 transition-colors duration-150 ease-rare focus-within:bg-surface-2', trimmed ? 'bg-surface-2' : 'border-dashed border-border')}>
      <Icon icon={PenLine} size={16} className="text-muted" />
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
        className="min-w-0 flex-1 bg-transparent text-copy font-medium text-fg outline-none placeholder:font-normal placeholder:text-muted"
      />
      {trimmed ? <Kbd className="shrink-0">↵</Kbd> : null}
    </label>
  );
}

const isTyping = (t: EventTarget | null) => t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || (t instanceof HTMLElement && t.isContentEditable);

/** `expired`: the turn ended without an answer, so the options no longer go anywhere. */
export function QuestionCard({ part, botName, botColor, expired }: { part: QuestionPart; botName: string; botColor?: string; expired: boolean }) {
  // an answer shows as given the moment it's picked (lib/actions.ts `answerQuestion`: back, with an error, if refused)
  const pendingAnswer = usePendingAnswers((s) => s[part.questionId]);
  const own = useRef<HTMLInputElement>(null);
  const answer = part.answer ?? pendingAnswer ?? null;
  const disabled = expired;

  const submit = (value: string) => {
    if (disabled || answer) return;
    void answerQuestion(part.questionId, value);
  };

  // number keys pick an option while focus is not in a text field
  useEffect(() => {
    if (answer || disabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      const n = Number(e.key);
      const option = Number.isInteger(n) && n >= 1 ? part.options[n - 1] : undefined;
      if (option) { e.preventDefault(); void submit(option); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  // answered: the card goes, and the question and the answer read as two messages (Answered.tsx)
  if (answer) return <AnsweredExchange ask={part.question} answer={answer} botColor={botColor} />;
  return (
    <section aria-label={part.question} className="chat-generative glass-raised squircle w-full max-w-[34rem] rounded-card">
      <div className="flex flex-col gap-3 px-4 pt-3.5 pb-3.5">
        <div className="flex flex-col gap-0.5">
          <span className="text-note text-muted">{expired ? `${botName} asked` : `${botName} asks`}</span>
          {/* questions can be several lines (a bot asking to change another bot shows the whole new text): keep them */}
          <span className="block max-h-[22rem] overflow-y-auto text-copy leading-snug font-semibold whitespace-pre-wrap break-words text-fg">{part.question}</span>
        </div>
        <div className="gen-choices flex flex-col gap-2" data-unavailable={expired || undefined}>
          {part.options.map((o, i) => (
            <ChoiceButton key={o} pressed={false} disabled={disabled} shortcut={i < 9 && !expired ? String(i + 1) : null} onClick={() => void submit(o)}>{o}</ChoiceButton>
          ))}
          {!expired ? <OwnAnswerRow disabled={disabled} inputRef={own} onAnswer={(t) => void submit(t)} /> : null}
        </div>
        {expired ? <p className="text-note text-muted">This question ended without an answer.</p> : null}
      </div>
    </section>
  );
}
