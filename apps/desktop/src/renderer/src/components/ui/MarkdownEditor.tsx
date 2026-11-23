import { memo, useMemo, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { CodeFrame } from '../rare/CodeBlock';
import { markdownTokens } from './markdownTokens';
import './markdownEditor.css';

/** One line of the picture under the text field: its pieces, coloured. Kept per line, so typing redraws one. */
const Line = memo(function Line({ text }: { text: string }) {
  const tokens = useMemo(() => markdownTokens(text), [text]);
  return (
    <span className="line">
      {tokens.map((t, i) => (t.kind === 'plain' ? t.text : <span key={i} data-t={t.kind}>{t.text}</span>))}
    </span>
  );
});

/**
 * Markdown you edit, in the chat's code view (Rare UI's CodeBlock frame: a label in the header, Copy, line numbers,
 * colours made from the bot's own or the accent): a bot's memory, its instructions, the instructions for every bot,
 * a skill's SKILL.md. Still a text field: a transparent `<textarea>` lies exactly over the coloured lines (same face,
 * size, line height, wrapping and indent: markdownEditor.css keeps the two in step), so the caret, selection, undo
 * and the keyboard are the field's own and the colours follow each keystroke. Long lines wrap under their own text,
 * clear of the numbers. Size it with `className` (a min and max height: the frame scrolls inside).
 */
export function MarkdownEditor({ value, onChange, onKeyDown, label, ariaLabel, placeholder, accent, className, lineNumbers = true, spellCheck = false, maxLength, footer, disabled }: {
  value: string;
  onChange: (value: string) => void;
  onKeyDown?: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  /** the header's label: the file's name, or what the text is */
  label: string;
  ariaLabel: string;
  placeholder?: string;
  /** the colour the code view's theme is made from: the bot's (outside a chat nothing sets `--ab-bot`) */
  accent?: string;
  className?: string;
  /** off for plain-language text, where a paragraph is one long wrapped line */
  lineNumbers?: boolean;
  spellCheck?: boolean;
  maxLength?: number;
  /** a row under the text, inside the frame (a count, Save) */
  footer?: ReactNode;
  disabled?: boolean;
}) {
  const lines = useMemo(() => value.split('\n'), [value]);
  return (
    <CodeFrame
      code={value}
      label={label}
      wrap
      showLineNumbers={lineNumbers}
      data-edit
      className={className}
      style={accent ? ({ '--ab-bot': accent } as CSSProperties) : undefined}
      footer={footer}
    >
      <div className="md-edit">
        <pre aria-hidden><code>{lines.map((l, i) => <Line key={i} text={l} />)}</code></pre>
        <textarea
          value={value}
          onChange={(e) => onChange(maxLength ? e.target.value.slice(0, maxLength) : e.target.value)}
          onKeyDown={onKeyDown}
          spellCheck={spellCheck}
          autoCapitalize="off"
          autoCorrect="off"
          aria-label={ariaLabel}
          placeholder={placeholder}
          disabled={disabled}
        />
      </div>
    </CodeFrame>
  );
}
