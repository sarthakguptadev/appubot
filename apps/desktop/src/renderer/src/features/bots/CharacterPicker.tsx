/**
 * A bot's look, picked from the avatar in the side panel (a popover: features/bots/BotHero.tsx): what it wears, a
 * built-in shape or a custom character from the computer's library (`characters.*`, chat-core characters.ts) drawn by
 * the bot's own agent (Generate), plus the colour. Every pick applies at once, so the avatar above the popover is the
 * preview. Saved characters rename or delete from their right-click, in place. A computer that predates characters
 * gets the shapes only.
 */
import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import { importSvg } from '@appubot/chat-core';
import { BOT_COLORS, BotShape, botShapesOf, CHARACTER_NAME_MAX, CHARACTER_PROMPT_MAX, newId, type Character, type CharacterDraft } from '@appubot/protocol';
import { Image, Pencil, Sparkles, X } from '../../components/ui/icons';
import { PanelTabs } from '../../components/ui/PanelTabs';
import { BotAvatar, Button, Icon, Input, SETTINGS_CARD, cn } from '../../components/ui';
import { GatewayError, errorMessage, rpc } from '../../lib/gateway';
import { setState, useStore } from '../../lib/store';
import { SHAPE_LABEL } from './botForm';
import { LookTile } from './LookTile';

export { SHAPE_LABEL };


export interface Look { shape: BotShape; characterId: string; color: string }
export type LookTab = 'bot' | 'generate' | 'image';
type Tab = LookTab;
/** the look pickers' switcher (New bot, the side panel's avatar): the side panel's own tabs */
export const LOOK_TABS: { id: LookTab; label: string }[] = [{ id: 'bot', label: 'Shapes' }, { id: 'generate', label: 'Generate' }, { id: 'image', label: 'Image' }];

/** How long Generate may take on the computer (its own limit is 90 s), with room for the trip. */
const GENERATE_WAIT_MS = 110_000;

/** A computer that predates characters says so: from then on only shapes show. */
function unsupported(e: unknown): boolean {
  if (e instanceof GatewayError && e.code === 'unknown_method') {
    setState({ charactersSupported: false });
    return true;
  }
  return false;
}

export function CharacterPicker({ value, onChange, providerId, modelId, botId, open }: {
  value: Look;
  onChange: (patch: Partial<Look>) => void;
  /** the agent and model that draw: the bot's own */
  providerId: string;
  modelId?: string;
  botId?: string;
  /** the picker is open (closing it stops a drawing) */
  open: boolean;
}) {
  const characters = useStore((s) => s.characters);
  const supported = useStore((s) => s.charactersSupported);
  const [tab, setTab] = useState<Tab>('bot');
  const worn = value.characterId ? characters.find((c) => c.id === value.characterId) : undefined;

  useEffect(() => { if (open) setTab('bot'); }, [open]);
  // the character it wore was deleted (here or on another device): back to its shape
  useEffect(() => {
    if (value.characterId && supported && !worn) onChange({ characterId: '' });
  }, [value.characterId, worn, supported]);
  useEffect(() => { if (!supported) setTab('bot'); }, [supported]);

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {supported ? <div className="self-start"><PanelTabs<Tab> items={LOOK_TABS} value={tab} onChange={setTab} /></div> : null}

      {/* one height for the three tabs, so the popover never changes size between them */}
      <div className={cn(supported && '-m-1 h-[184px] overflow-y-auto p-1')}>
      {tab === 'bot' || !supported ? (
        <BotTab value={value} characters={supported ? characters : []} supported={supported} onChange={onChange} />
      ) : tab === 'generate' ? (
        <GenerateTab color={value.color} providerId={providerId} modelId={modelId} botId={botId} open={open} onPicked={(id) => { onChange({ characterId: id }); setTab('bot'); }} />
      ) : (
        <ImageTab onPicked={(id) => { onChange({ characterId: id }); setTab('bot'); }} />
      )}
      </div>

      <div role="radiogroup" aria-label="Colour" className="flex flex-wrap items-center gap-2.5 px-1 py-1">
        {BOT_COLORS.map((c) => {
          const on = value.color.toLowerCase() === c.toLowerCase();
          return (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={on}
              aria-label={`Colour ${c}`}
              onClick={() => onChange({ color: c })}
              className={cn(
                'size-[22px] rounded-full outline-none transition-shadow duration-150 focus-visible:shadow-[0_0_0_2px_var(--ab-popover),0_0_0_4px_var(--ab-ring)]',
                on && 'shadow-[0_0_0_2px_var(--ab-popover),0_0_0_3.5px_var(--ab-fg)]',
              )}
              style={{ background: c }}
            />
          );
        })}
      </div>
    </div>
  );
}

function BotTab({ value, characters, supported, onChange }: {
  value: Look; characters: Character[]; supported: boolean; onChange: (patch: Partial<Look>) => void;
}) {
  const [managing, setManaging] = useState<string | null>(null);
  const managed = managing ? characters.find((c) => c.id === managing) : undefined;
  // only the shapes the computer on screen takes (one from before 2026-11-18 refuses the newer ones)
  const listed = useStore((s) => s.system?.botShapes);
  const shapes = useMemo(() => botShapesOf({ botShapes: listed }), [listed]);
  return (
    <div className="flex flex-col gap-2">
      {/* every look at once, seven to a row (scrolling past a few rows of saved characters); Generate and Image are tabs */}
      <div className="grid grid-cols-7 items-center gap-1" role="radiogroup" aria-label="Look">
        {shapes.map((s) => (
          <LookTile key={s} figure={s} color={value.color} size={30} label={SHAPE_LABEL[s]}
            selected={!value.characterId && s === value.shape} onClick={() => onChange({ shape: s, characterId: '' })} />
        ))}
        {characters.map((c) => {
          const on = value.characterId === c.id;
          return (
            <span key={c.id} className="group/ch relative inline-flex">
              <LookTile figure={c} color={value.color} size={30} label={c.name} title={`${c.name} (right-click to rename or delete)`}
                selected={on || managing === c.id} onClick={() => onChange({ characterId: c.id })}
                onContextMenu={(e) => { e.preventDefault(); setManaging(c.id); }} />
              <button type="button" aria-label={`Rename or delete ${c.name}`} onClick={() => setManaging(c.id)}
                className="absolute -top-1 -right-1 hidden size-[18px] items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--ab-fg)_12%,var(--ab-surface))] text-muted shadow-[0_0_0_.5px_var(--ab-hairline),0_1px_3px_rgba(0,0,0,.15)] hover:text-fg group-hover/ch:flex">
                <Icon icon={Pencil} size={10} />
              </button>
            </span>
          );
        })}
      </div>
      {managed ? <ManageCharacter key={managed.id} character={managed} wornHere={value.characterId === managed.id} onClose={() => setManaging(null)}
        onDeleted={() => { if (value.characterId === managed.id) onChange({ characterId: '' }); setManaging(null); }} /> : null}
    </div>
  );
}

/** Rename or delete a saved character, in place (a confirm dialog would close the picker). */
function ManageCharacter({ character, wornHere, onClose, onDeleted }: { character: Character; wornHere: boolean; onClose: () => void; onDeleted: () => void }) {
  const [name, setName] = useState(character.name);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wearers = useStore((s) => s.bots.filter((b) => b.characterId === character.id).length);
  const rename = async () => {
    const next = name.trim();
    if (!next || next === character.name) return onClose();
    setBusy(true);
    try {
      const c = await rpc('characters.rename', { id: character.id, name: next });
      setState((s) => ({ characters: s.characters.map((x) => (x.id === c.id ? c : x)) }));
      onClose();
    } catch (e) { if (!unsupported(e)) setError(errorMessage(e)); } finally { setBusy(false); }
  };
  const remove = async () => {
    setBusy(true);
    try {
      await rpc('characters.delete', { id: character.id });
      setState((s) => ({ characters: s.characters.filter((x) => x.id !== character.id) }));
      onDeleted();
    } catch (e) { if (!unsupported(e)) setError(errorMessage(e)); setBusy(false); }
  };
  return (
    <div className={cn(SETTINGS_CARD, 'flex flex-col gap-2 px-3 py-2.5')}>
      {asking ? (
        <>
          <div className="text-ui leading-snug text-fg">
            Delete “{character.name}”? {wearers ? `${wearers === 1 ? 'The bot' : `The ${wearers} bots`} wearing it go${wearers === 1 ? 'es' : ''} back to ${wearers === 1 ? 'its shape' : 'their shapes'}.` : wornHere ? 'This bot goes back to its shape.' : 'No bot is wearing it.'}
          </div>
          <div className="flex justify-end gap-1">
            <Button size="xs" variant="ghost" disabled={busy} onClick={() => setAsking(false)}>Cancel</Button>
            <Button size="xs" variant="danger" loading={busy} onClick={() => void remove()}>Delete</Button>
          </div>
        </>
      ) : (
        <div className="flex items-center gap-1.5">
          <Input
            value={name}
            maxLength={CHARACTER_NAME_MAX}
            aria-label="Character name"
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); void rename(); }
              if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
            }}
            className="h-7 flex-1"
          />
          <Button size="xs" variant="secondary" loading={busy} onClick={() => void rename()}>Rename</Button>
          <Button size="xs" variant="ghost" className="text-muted hover:text-danger" disabled={busy} onClick={() => setAsking(true)}>Delete</Button>
          <Button size="icon-xs" variant="ghost" icon={X} aria-label="Close" onClick={onClose} />
        </div>
      )}
      {error ? <div className="text-note leading-snug text-danger">{error}</div> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ Generate */

type Drawing =
  | { phase: 'idle' }
  | { phase: 'drawing'; requestId: string; startedAt: number }
  | { phase: 'done'; candidates: CharacterDraft[] }
  | { phase: 'error'; message: string };

/**
 * A bot from an SVG file: dropped or chosen, read here (never rendered: chat-core `importSvg` keeps only its filled
 * outline), saved in the library (`characters.save {source: 'imported'}`) and worn. A PNG or JPEG is refused in words,
 * since a bot's body is an outline.
 */
export function ImageTab({ onPicked }: { onPicked: (id: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const take = async (file: File | undefined) => {
    if (!file || busy) return;
    setError(null);
    if (!/\.svg$/i.test(file.name) && file.type !== 'image/svg+xml') { setError('Pick an SVG file: its outline becomes the bot.'); return; }
    const read = importSvg(await file.text());
    if (!read.ok) { setError(read.error); return; }
    setBusy(true);
    try {
      const name = file.name.replace(/\.svg$/i, '').slice(0, CHARACTER_NAME_MAX) || 'Image';
      const c = await rpc('characters.save', { name, body: read.body, face: read.face, source: 'imported' });
      setState((s) => ({ characters: s.characters.some((x) => x.id === c.id) ? s.characters : [...s.characters, c] }));
      onPicked(c.id);
    } catch (e) { if (!unsupported(e)) setError(errorMessage(e)); } finally { setBusy(false); }
  };
  const onDrop = (e: DragEvent) => { e.preventDefault(); setOver(false); void take(e.dataTransfer.files[0]); };
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={() => input.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        disabled={busy}
        className={cn(
          'squircle flex min-h-[132px] w-full flex-col items-center justify-center gap-2 rounded-card border border-dashed px-4 py-5 text-center outline-none transition-colors focus-visible:shadow-[0_0_0_2px_var(--ab-ring)]',
          over ? 'border-[color-mix(in_srgb,var(--ab-fg)_40%,transparent)] bg-fg/[.05]' : 'border-[color-mix(in_srgb,var(--ab-fg)_16%,transparent)] hover:bg-fg/[.03]',
        )}
      >
        <Icon icon={Image} size={22} className="text-muted" />
        <span className="text-ui font-medium text-fg">{busy ? 'Reading it…' : 'Drop an SVG here, or choose one'}</span>
        <span className="max-w-[300px] text-note leading-snug text-muted">Its outline becomes the bot, with the visor on it.</span>
      </button>
      <input ref={input} type="file" accept=".svg,image/svg+xml" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; void take(f); }} />
      {error ? <span className="text-note leading-snug text-danger">{error}</span> : null}
    </div>
  );
}

export function GenerateTab({ color, providerId, modelId, botId, open, onPicked }: { color: string; providerId: string; modelId?: string; botId?: string; open: boolean; onPicked: (id: string) => void }) {
  const [prompt, setPrompt] = useState('');
  const [state, setDrawing] = useState<Drawing>({ phase: 'idle' });
  const [saving, setSaving] = useState<number | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const live = useRef<string | null>(null);

  // a drawing still going when the picker closes (or this tab goes) is stopped
  const stop = () => {
    const id = live.current;
    live.current = null;
    if (id) void rpc('characters.cancel', { requestId: id }).catch(() => undefined);
  };
  useEffect(() => stop, []);
  useEffect(() => { if (!open) stop(); }, [open]);

  const generate = async () => {
    const text = prompt.trim();
    if (!text || state.phase === 'drawing') return;
    const requestId = newId('gen');
    live.current = requestId;
    setSaveError(null);
    setDrawing({ phase: 'drawing', requestId, startedAt: Date.now() });
    try {
      const r = await rpc('characters.generate', { prompt: text, providerId, ...(modelId ? { modelId } : {}), ...(botId ? { botId } : {}), requestId }, { timeoutMs: GENERATE_WAIT_MS });
      if (live.current !== requestId) return;
      setDrawing({ phase: 'done', candidates: r.candidates });
    } catch (e) {
      // stopped here: `cancel` let go of it first, so nothing is said
      if (live.current !== requestId) return;
      if (unsupported(e)) { setDrawing({ phase: 'error', message: 'This computer can’t draw characters yet. Update it, then try again.' }); return; }
      // stopped there without anyone here pressing Stop (the computer restarted, another device stopped it): say so,
      // never fall back to the empty box as if nothing had been asked
      if (e instanceof GatewayError && e.code === 'cancelled') { setDrawing({ phase: 'error', message: 'The drawing stopped before it was done. Try again.' }); return; }
      setDrawing({ phase: 'error', message: errorMessage(e) });
    } finally {
      if (live.current === requestId) live.current = null;
    }
  };
  const cancel = () => { stop(); setDrawing({ phase: 'idle' }); };

  const pick = async (d: CharacterDraft, i: number) => {
    setSaving(i);
    setSaveError(null);
    try {
      const c = await rpc('characters.save', { name: d.name, body: d.body, face: d.face, source: 'generated' });
      setState((s) => ({ characters: s.characters.some((x) => x.id === c.id) ? s.characters : [...s.characters, c] }));
      onPicked(c.id);
    } catch (e) { if (!unsupported(e)) setSaveError(errorMessage(e)); } finally { setSaving(null); }
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); void generate(); }
  };
  const drawing = state.phase === 'drawing';
  return (
    <div className="flex flex-col gap-3">
      {/* the description and its one button: Generate, Stop while drawing, Try again once there are drawings */}
      <div className="flex items-center gap-2">
        <Input
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={onKey}
          maxLength={CHARACTER_PROMPT_MAX}
          placeholder="A sleepy cat, a cactus, a teapot…"
          aria-label="Describe a character"
          disabled={drawing}
          className="min-w-0 flex-1"
        />
        {drawing
          ? <Button size="md" variant="secondary" onClick={cancel} className="shrink-0">Stop</Button>
          // quiet until there is something to draw (a disabled filled button read as a grey block)
          : <Button size="md" variant={prompt.trim() ? 'primary' : 'secondary'} icon={Sparkles} disabled={!prompt.trim()} onClick={() => void generate()} className="shrink-0">{state.phase === 'done' ? 'Again' : 'Generate'}</Button>}
      </div>

      {/* three slots, the width of the row, in every state: outlines while idle, waiting while it draws, then the
          drawings to pick from; so the tab keeps one shape and is never a blank box */}
      {state.phase === 'idle' || state.phase === 'error' ? (
        <div className="flex flex-col gap-1.5">
          <div className="grid grid-cols-3 gap-2" aria-hidden>
            {[0, 1, 2].map((i) => (
              <span key={i} className="squircle flex h-[84px] items-center justify-center rounded-card border border-dashed border-[color-mix(in_srgb,var(--ab-fg)_12%,transparent)]">
                <BotAvatar shape={(['circle', 'cloud', 'drop'] as const)[i]} color={color} size={32} still className="opacity-[.18]" />
              </span>
            ))}
          </div>
          {state.phase === 'error'
            ? <p className="text-center text-note leading-snug text-danger">{state.message}</p>
            : <p className="text-center text-note leading-snug text-muted">Describe anything and your agent draws three bots shaped like it.</p>}
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          <div className="grid grid-cols-3 gap-2" role={state.phase === 'done' ? 'radiogroup' : undefined} aria-label={state.phase === 'done' ? 'Drawings' : undefined}>
            {state.phase === 'drawing'
              ? [0, 1, 2].map((i) => (
                <span key={i} className="squircle flex h-[84px] animate-pulse items-center justify-center rounded-card bg-surface-2" style={{ animationDelay: `${i * 180}ms` }}>
                  <BotAvatar shape="circle" color={color} size={36} mood="working" className="opacity-30" />
                </span>
              ))
              : state.candidates.map((d, i) => (
                <button key={i} type="button" disabled={saving !== null} onClick={() => void pick(d, i)} title={d.name}
                  className={cn('squircle flex h-[84px] min-w-0 flex-col items-center justify-center gap-1 rounded-card bg-surface-2 px-1.5 outline-none transition-colors hover:bg-surface-3 focus-visible:shadow-[0_0_0_2px_var(--ab-ring)]', saving === i && 'bg-surface-3')}>
                  <BotAvatar figure={d} color={color} size={44} still={saving !== i} mood={saving === i ? 'working' : 'rest'} />
                  <span className="max-w-full truncate text-note text-fg-2">{d.name}</span>
                </button>
              ))}
          </div>
          <span className="text-center text-note text-muted">
            {state.phase === 'drawing' ? <DrawingFor since={state.startedAt} /> : saveError ? <span className="text-danger">{saveError}</span> : 'Pick one to use it.'}
          </span>
        </div>
      )}
    </div>
  );
}

/** "Drawing… 12s": how long the agent has been at it (it takes up to a minute or two). */
function DrawingFor({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  return <>Drawing… {Math.max(0, Math.round((now - since) / 1000))}s</>;
}
