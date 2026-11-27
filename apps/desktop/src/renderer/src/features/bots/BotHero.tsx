/**
 * The top of a bot's side panel: its avatar, name and job, each changed where it stands (there is no editor dialog).
 * Under the pointer the avatar's own outline lights up (no pencil, no tile behind it: the owner's call, 2026-11-17)
 * and a click opens the look picker (shape, a saved or generated character, colour) in a popover under it; every pick
 * applies at once, so the avatar is its own preview. The name and the job turn into a field on a click: Enter or
 * leaving saves, Esc puts it back.
 */
import { useEffect, useRef, useState } from 'react';
import type { Bot } from '@appubot/protocol';
import type { BotFigure } from '@appubot/chat-core';
import { BotAvatar, Popover, cn } from '../../components/ui';
import { updateBot } from '../../lib/actions';
import { useStore } from '../../lib/store';
import { CharacterPicker, type Look } from './CharacterPicker';
import { OutlineRing } from './LookTile';

const NAME_MAX = 60;
const JOB_MAX = 120;

function HeroAvatar({ bot, working }: { bot: Bot; working: boolean }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);
  // the avatar cheers at each pick
  const [cheer, setCheer] = useState<number | undefined>(undefined);
  useEffect(() => { setOpen(false); setCheer(undefined); }, [bot.id]);
  // what it wears: a saved character, else its shape
  const worn = useStore((st) => (bot.characterId ? st.characters.find((c) => c.id === bot.characterId) : undefined));
  const figure: BotFigure = worn ?? bot.shape;
  const pick = (patch: Partial<Look>) => {
    void updateBot(bot, patch, { errorTitle: 'Could not change the look' });
    setCheer((n) => (n ?? 0) + 1);
  };
  return (
    <span ref={anchor} className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={`Change ${bot.name}’s look`}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="group/avatar no-drag relative inline-flex rounded-[24px] p-2 outline-none"
      >
        {/* the highlight is the avatar's own outline, a few px out (LookTile's ring): faint under the pointer,
            darker while its picker is open or it has the keyboard; no pencil and no tile behind it */}
        <OutlineRing
          figure={figure}
          size={72}
          gap={4}
          line={1.5}
          className={cn(
            'top-2 left-2 text-fg transition-opacity duration-150',
            open ? 'opacity-50' : 'opacity-0 group-hover/avatar:opacity-30 group-focus-visible/avatar:opacity-50',
          )}
        />
        <BotAvatar bot={bot} size={72} mood={working ? 'working' : 'rest'} cheerKey={cheer} className="ab-bot-calm" />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} side="bottom" align="start" label={`${bot.name}’s look`} className="squircle w-[348px] rounded-card">
        <div className="overflow-y-auto p-3.5">
          <CharacterPicker
            value={{ shape: bot.shape, characterId: bot.characterId ?? '', color: bot.color }}
            onChange={pick}
            providerId={bot.providerId}
            modelId={bot.modelId}
            botId={bot.id}
            open={open}
          />
        </div>
      </Popover>
    </span>
  );
}

/** A line of the hero that is a field once clicked: the name, the job. */
function InlineField({ value, placeholder, label, max, required, onSave, className }: {
  value: string;
  /** what an empty one reads (a job not written yet) */
  placeholder?: string;
  label: string;
  max: number;
  /** an empty edit is put back instead of saved (a bot keeps its name) */
  required?: boolean;
  onSave: (next: string) => void;
  /** the line's type, on both the text and the field */
  className: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const input = useRef<HTMLInputElement>(null);
  /** the edit ended (saved or cancelled): the blur of the field going away must not save it again */
  const ended = useRef(false);
  const start = () => { ended.current = false; setDraft(value); setEditing(true); };
  useEffect(() => { if (editing) requestAnimationFrame(() => input.current?.select()); }, [editing]);
  const end = (save: boolean) => {
    if (ended.current) return;
    ended.current = true;
    setEditing(false);
    const next = draft.replace(/\s+/g, ' ').trim();
    if (save && next !== value && (next || !required)) onSave(next);
  };
  if (editing) {
    return (
      <input
        ref={input}
        value={draft}
        maxLength={max}
        aria-label={label}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => end(true)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); end(true); }
          else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); end(false); }
        }}
        className={cn('ab-pill no-drag squircle h-7 w-full rounded-control-sm bg-fg/[.06] px-3 text-center outline-none placeholder:text-muted/70 focus:shadow-[inset_0_0_0_1.5px_color-mix(in_srgb,var(--ab-fg)_22%,transparent)]', className)}
      />
    );
  }
  return (
    <button
      type="button"
      onClick={start}
      aria-label={`${label}: ${value || placeholder || ''}. Change`}
      className={cn('no-drag squircle min-h-7 max-w-full rounded-control-sm px-2 py-0.5 text-center outline-none hover:bg-fg/5 focus-visible:shadow-[0_0_0_2px_var(--ab-ring)]', className)}
    >
      {value ? <span className="line-clamp-2 [overflow-wrap:anywhere]">{value}</span> : <span className="text-muted/70">{placeholder}</span>}
    </button>
  );
}

export function BotHero({ bot, working }: { bot: Bot; working: boolean }) {
  return (
    <div className="flex w-full flex-col items-center">
      <HeroAvatar bot={bot} working={working} />
      <div className="mt-1.5 flex w-full max-w-[20rem] flex-col items-center gap-0.5">
        <InlineField
          key={`name:${bot.id}`}
          value={bot.name}
          label="Name"
          max={NAME_MAX}
          required
          onSave={(name) => void updateBot(bot, { name }, { errorTitle: 'Could not rename the bot' })}
          className="font-display text-title font-medium tracking-heading text-fg"
        />
        <InlineField
          key={`job:${bot.id}`}
          value={bot.job ?? ''}
          placeholder="Add what it does"
          label="Job"
          max={JOB_MAX}
          onSave={(job) => void updateBot(bot, { job }, { errorTitle: 'Could not save the job' })}
          className="text-ui leading-snug text-muted"
        />
      </div>
    </div>
  );
}
