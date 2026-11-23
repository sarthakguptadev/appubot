// Settings › Import: bring bots over from another assistant (Grok Bot, dots, Muse, OpenBot, MausBot, OpenClaw,
// Hermes Agent, Manus). None of them exports its setup, so the person asks
// it: this page hands them a prompt to send there (chat-core `importPrompt`), the other assistant answers with its
// bots, memory, routines and skills as JSON, and that file (or the answer pasted) is read back here (`parseImport`)
// and made into bots on the computer on screen with its ordinary calls. What arrives is another model's writing:
// text only, nothing that grants power is read, and routines come switched off.
import { useMemo, useRef, useState } from 'react';
import {
  IMPORT_FILE_NAME, IMPORT_SOURCES, IMPORT_TEXT_MAX, ImportError, importMemoryText, importName, importPrompt, importSource, importSummary, parseImport,
  type ImportBot, type ImportFile,
} from '@appubot/chat-core';
import { BOT_COLORS, BOT_SHAPES_V1, BotShape, type Bot } from '@appubot/protocol';
import { BotAvatar, Button, Checkbox, Icon, Spinner, cn } from '../../../components/ui';
import { AlertTriangle, ClipboardPaste, RotateCw, Upload } from '../../../components/ui/icons';
import { CodeFrame } from '../../../components/rare/CodeBlock';
import { TaskCheck } from '../../../components/rare/TaskCheck';
import { openBot } from '../../../lib/actions';
import { rpc } from '../../../lib/gateway';
import { ui, useStore } from '../../../lib/store';
import { ImportLogo } from '../importLogos';
import { SETTINGS_ROW, SETTINGS_ROW_DESCRIPTION, SETTINGS_ROW_TITLE, SettingsCard, SettingsGroup } from './shared';

export const IMPORT_FROM_TITLE = 'Where are your bots now?';
export const IMPORT_PROMPT_TITLE = 'Ask it for your setup';
export const IMPORT_FILE_TITLE = 'Bring its answer here';

// the eight every computer takes (one from before 2026-11-18 refuses the newer ones)
const SHAPES = BOT_SHAPES_V1;
/** a look for each newcomer, so a batch doesn't arrive as identical orange circles */
const lookFor = (i: number) => ({ color: BOT_COLORS[(i * 3 + 1) % BOT_COLORS.length]!, shape: SHAPES[i % SHAPES.length]! });

type RowState = { status: 'idle' } | { status: 'running'; step: string } | { status: 'done'; botId: string; name: string; skipped: string[] } | { status: 'failed'; error: string };

const errorText = (e: unknown): string => (e instanceof Error && e.message ? e.message : 'Something went wrong.');

/** One source to pick: its own mark on a tile and its name. */
function SourceChip({ id, name, on, onPick }: { id: string; name: string; on: boolean; onPick: () => void }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      onClick={onPick}
      className={cn(
        'ab-press squircle flex h-12 min-w-0 items-center gap-2.5 rounded-control-lg px-2.5 text-left outline-none [--press:.98] focus-visible:shadow-[0_0_0_2px_var(--ab-ring)]',
        on ? 'bg-[color-mix(in_srgb,var(--ab-accent)_10%,var(--ab-surface-2))] shadow-[inset_0_0_0_2px_var(--ab-accent)]' : 'bg-surface-2 hover:bg-surface-3',
      )}
    >
      <ImportLogo id={id} name={name} />
      <span className="min-w-0 truncate text-ui font-semibold tracking-ui text-fg">{name}</span>
    </button>
  );
}

/** Text in the code view's frame (its header's Copy copies it), in the plain shape the frame's CSS expects. */
function PromptBlock({ label, text }: { label: string; text: string }) {
  const lines = text.split('\n');
  return (
    <CodeFrame code={text} label={label} wrap showLineNumbers={false} className="max-h-[320px]">
      <pre className="shiki"><code>{lines.map((l, i) => <span key={i}><span className="line">{l}</span>{i < lines.length - 1 ? '\n' : null}</span>)}</code></pre>
    </CodeFrame>
  );
}

export function ImportSection() {
  const bots = useStore((s) => s.bots);
  const providerId = useStore((s) => s.settings?.defaultProviderId ?? 'claude-code');
  const [sourceId, setSourceId] = useState('grokbot');
  const source = importSource(sourceId);
  const who = source.name;
  const prompt = useMemo(() => importPrompt(sourceId), [sourceId]);

  const [file, setFile] = useState<ImportFile | null>(null);
  const [fileName, setFileName] = useState('');
  const [problem, setProblem] = useState('');
  const [picked, setPicked] = useState<boolean[]>([]);
  const [rows, setRows] = useState<RowState[]>([]);
  const [running, setRunning] = useState(false);
  const chooser = useRef<HTMLInputElement>(null);

  const take = (text: string, name: string) => {
    try {
      const f = parseImport(text);
      setFile(f);
      setFileName(name);
      setProblem('');
      setPicked(f.bots.map(() => true));
      setRows(f.bots.map(() => ({ status: 'idle' })));
    } catch (e) {
      setFile(null);
      setProblem(e instanceof ImportError ? e.message : 'That file couldn’t be read.');
    }
  };
  const onChosen = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > IMPORT_TEXT_MAX) { setFile(null); setProblem('That file is too large to be an answer to the import prompt.'); return; }
    take(await f.text(), f.name);
  };
  const paste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) { setProblem('The clipboard is empty. Copy the assistant’s whole answer first.'); return; }
      take(text, 'the pasted answer');
    } catch {
      setProblem('AppuBot couldn’t read the clipboard. Save the answer as a file and choose it instead.');
    }
  };

  const setRow = (i: number, state: RowState) => setRows((r) => r.map((x, k) => (k === i ? state : x)));

  /** Makes one bot with the computer's ordinary calls: the bot, then its memory, routines (switched off) and skills. */
  const bring = async (bot: ImportBot, i: number, taken: string[]): Promise<void> => {
    const skipped: string[] = [];
    try {
      setRow(i, { status: 'running', step: 'Making the bot…' });
      const name = importName(bot.name, taken);
      taken.push(name);
      const made: Bot = await rpc('bots.create', { name, job: bot.job, instructions: bot.instructions, providerId, ...lookFor(i) });
      if (bot.memory.length) {
        setRow(i, { status: 'running', step: 'Its memory…' });
        await rpc('bots.memory.set', { id: made.id, memory: importMemoryText(name, bot.memory, new Date().toISOString().slice(0, 10)) })
          .catch(() => skipped.push('its memory'));
      }
      for (const r of bot.routines) {
        setRow(i, { status: 'running', step: `Routine: ${r.name}` });
        await rpc('routines.create', { botId: made.id, name: r.name, prompt: r.prompt, schedule: r.schedule, enabled: false })
          .catch(() => skipped.push(`the routine “${r.name}”`));
      }
      for (const s of bot.skills) {
        setRow(i, { status: 'running', step: `Skill: ${s.name}` });
        await rpc('skills.save', { botId: made.id, name: s.name, description: s.description, body: s.body })
          .catch(() => skipped.push(`the skill “${s.name}”`));
      }
      setRow(i, { status: 'done', botId: made.id, name, skipped });
    } catch (e) {
      setRow(i, { status: 'failed', error: errorText(e) });
    }
  };

  const run = async () => {
    if (!file || running) return;
    setRunning(true);
    const taken = useStore.getState().bots.map((b) => b.name);
    for (let i = 0; i < file.bots.length; i++) {
      const state = rows[i];
      if (!picked[i] || state?.status === 'done') continue;
      await bring(file.bots[i]!, i, taken);
    }
    setRunning(false);
  };

  const toBring = file ? file.bots.filter((_, i) => picked[i] && rows[i]?.status !== 'done').length : 0;
  const done = rows.filter((r) => r.status === 'done');
  const firstDone = done[0]?.status === 'done' ? done[0].botId : undefined;
  const names = bots.map((b) => b.name);

  return (
    <div className="space-y-6">
      <SettingsGroup title={IMPORT_FROM_TITLE} description="Pick the assistant you use today. AppuBot gives you one message to send it, and it answers with everything it keeps for you." bare>
        <div role="radiogroup" aria-label="Assistant" className="grid grid-cols-[repeat(auto-fill,minmax(164px,1fr))] gap-2">
          {IMPORT_SOURCES.map((s) => <SourceChip key={s.id} id={s.id} name={s.name} on={s.id === sourceId} onPick={() => setSourceId(s.id)} />)}
        </div>
      </SettingsGroup>

      <SettingsGroup title={`1. ${IMPORT_PROMPT_TITLE}`} description={`Copy this message and send it to ${who}. It answers with a block of JSON, or a file named ${IMPORT_FILE_NAME}. Passwords and keys are left out.`} bare>
        <PromptBlock label={`Message for ${who}`} text={prompt} />
      </SettingsGroup>

      <SettingsGroup title={`2. ${IMPORT_FILE_TITLE}`} description="Choose the file it gave you, or copy its whole answer and paste it. Nothing is made until you press Import." bare>
        <SettingsCard>
          <div className={cn(SETTINGS_ROW, 'flex flex-wrap items-center gap-2')}>
            <input ref={chooser} type="file" accept=".json,.txt,.md,application/json,text/plain" className="hidden" onChange={(e) => { void onChosen(e.target.files?.[0]); e.target.value = ''; }} />
            <Button variant="primary" icon={Upload} disabled={running} onClick={() => chooser.current?.click()}>Choose file…</Button>
            <Button variant="secondary" icon={ClipboardPaste} disabled={running} onClick={() => void paste()}>Paste its answer</Button>
            {file ? <span className="min-w-0 truncate text-note text-muted">Read {fileName}{file.from ? ` · from ${file.from}` : ''}</span> : null}
          </div>
          {problem ? (
            <div role="alert" className={cn(SETTINGS_ROW, 'flex items-start gap-2 text-ui text-danger')}>
              <Icon icon={AlertTriangle} size={15} className="mt-0.5 shrink-0" />
              <span>{problem}</span>
            </div>
          ) : null}
        </SettingsCard>
      </SettingsGroup>

      {file ? (
        <SettingsGroup
          title={`3. ${file.bots.length === 1 ? 'Your bot' : `Your ${file.bots.length} bots`}`}
          description="Each comes as a new bot with its instructions, memory and skills. Routines arrive switched off: turn on the ones you want. It runs on the agent you use for new bots."
          bare
        >
          <SettingsCard>
            {file.bots.map((b, i) => {
              const state = rows[i] ?? { status: 'idle' };
              const newName = state.status === 'done' ? b.name : importName(b.name, names);
              const summary = importSummary(b);
              return (
                <label key={i} className={cn(SETTINGS_ROW, 'flex items-center gap-3', state.status === 'idle' && !running ? 'cursor-pointer' : 'cursor-default')}>
                  {state.status === 'done' ? <TaskCheck checked size={18} accent="var(--ab-success)" />
                    : state.status === 'running' ? <Spinner size={16} className="shrink-0 text-muted" />
                      : <Checkbox checked={!!picked[i]} disabled={running} onChange={() => setPicked((p) => p.map((x, k) => (k === i ? !x : x)))} aria-label={`Import ${b.name}`} />}
                  <BotAvatar {...lookFor(i)} size={30} still />
                  <div className="min-w-0 flex-1">
                    <div className={cn(SETTINGS_ROW_TITLE, 'truncate')}>
                      {state.status === 'done' ? state.name : b.name}
                      {state.status !== 'done' && newName !== b.name ? <span className="font-normal text-muted"> · comes as {newName}</span> : null}
                    </div>
                    <div className={cn(SETTINGS_ROW_DESCRIPTION, 'truncate')}>
                      {state.status === 'running' ? state.step
                        : state.status === 'failed' ? <span className="text-danger">Couldn’t import it: {state.error}</span>
                          : state.status === 'done' && state.skipped.length ? <span className="text-warning">Imported, without {state.skipped.join(', ')}.</span>
                            : [b.job, summary].filter(Boolean).join(' · ') || 'Instructions only'}
                    </div>
                  </div>
                  {state.status === 'done' ? <Button size="sm" variant="secondary" onClick={(e) => { e.preventDefault(); ui.closeSettings(); openBot(state.botId); }}>Open</Button> : null}
                </label>
              );
            })}
          </SettingsCard>
          {file.notes.length ? (
            <ul className="space-y-1 px-1 text-note leading-normal text-muted">
              {file.notes.map((n, i) => <li key={i} className="flex items-start gap-1.5"><Icon icon={AlertTriangle} size={12} className="mt-[3px] shrink-0 text-warning" />{n}</li>)}
            </ul>
          ) : null}
          <div className="flex items-center gap-2">
            {toBring || running || !firstDone ? (
              <Button variant="primary" loading={running} disabled={!toBring} onClick={() => void run()} icon={rows.some((r) => r.status === 'failed') ? RotateCw : undefined}>
                {rows.some((r) => r.status === 'failed') ? 'Try again' : toBring === 1 ? 'Import 1 bot' : `Import ${toBring} bots`}
              </Button>
            ) : null}
            {firstDone && !running && !toBring ? <span className="text-ui text-muted">Done. Your bots are in the sidebar.</span> : null}
          </div>
        </SettingsGroup>
      ) : null}
    </div>
  );
}
