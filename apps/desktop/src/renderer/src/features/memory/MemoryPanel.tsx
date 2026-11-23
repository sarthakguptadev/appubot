import { useEffect, useMemo, useRef, useState } from 'react';
import { Brain, FolderSearch } from '../../components/ui/icons';
import { Button, EmptyState, Spinner, Tooltip } from '../../components/ui';
import { call } from '../../lib/actions';
import { mod, useAutoSave } from '../../lib/hooks';
import { native } from '../../lib/native';
import { SHOW_IN_FOLDER } from '../../lib/platform';
import { useRemoteComputer } from '../cloud/remoteFiles';
import { getState, selectSelectedBot, selectSelectedThread, useStore } from '../../lib/store';
import { activeComputer } from '../../lib/gateway';
import { remember } from '../../lib/remembered';
import { MEMORY_CAP_LABEL, memoryStats } from './memoryStats';
import { MarkdownEditor } from '../../components/ui/MarkdownEditor';

/** a bot's memory as last read on a cloud computer (`remembered`, kept in its sealed saved copy; this Mac's own is read
 * at once from disk, and its remembered answers in localStorage never hold what a bot remembers) */
type KeptMemory = { memory: string; path: string };
const memoryKey = (botId: string): string => `memory:${botId}`;

/**
 * Editable MEMORY.md for the selected bot: shared by all its threads, each new thread starts with it. No buttons and
 * no explanation over it (the owner's call, 2026-11-17): edits save by themselves a moment after typing stops
 * (`useAutoSave`; ⌘S saves now), and emptying the text clears the memory. It is read again when the tab opens, the
 * connection comes up and the bot's turn ends (it may have remembered something), unless an edit is on its way.
 */
export function MemoryPanel() {
  const remote = useRemoteComputer();
  const bot = useStore(selectSelectedBot);
  const botId = bot?.id;
  const [saved, setSaved] = useState('');
  const [draft, setDraft] = useState('');
  const [path, setPath] = useState('');
  const [loading, setLoading] = useState(false);
  const loadSeq = useRef(0);
  const shown = useRef<string | undefined>(botId);
  shown.current = botId;
  const { queue, flush, busy } = useAutoSave();
  // the computer on screen's connection: right after switching computers it isn't up yet, so memory loads once it is
  const connected = useStore((s) => s.conn === 'connected');
  // the bot's turn on screen: once it ends, the bot may have added to its memory
  const working = useStore((s) => { const t = selectSelectedThread(s); return !!t && t.botId === botId && t.status === 'running'; });

  /** what the computer holds was read for this bot: until then nothing typed is saved (it would replace what couldn't be read) */
  const [ready, setReady] = useState(false);
  // an edit not saved yet: nothing read from the computer may replace it
  const editing = useRef(false);
  editing.current = busy || draft !== saved;

  /** `quiet`: a look for news while the text is on screen (no spinner, and what was typed meanwhile stands) */
  const load = async (id: string, quiet = false) => {
    const seq = ++loadSeq.current;
    if (!quiet) setLoading(true);
    const from = activeComputer();
    const res = await call('bots.memory.get', { id }, { errorTitle: 'Could not load memory' });
    if (seq !== loadSeq.current) return;
    setLoading(false);
    if (!res || (quiet && editing.current)) return;
    if (from === 'cloud') remember(memoryKey(id), { memory: res.memory ?? '', path: res.path ?? '' }, from);
    setSaved(res.memory ?? '');
    setDraft(res.memory ?? '');
    setPath(res.path ?? '');
    setReady(true);
  };

  useEffect(() => {
    // the copy read last time on this computer shows at once (lib/remembered.ts), read again behind it; nothing typed
    // is saved until that read is back (`ready`)
    const kept = botId ? (getState().remembered[memoryKey(botId)]?.value as KeptMemory | undefined) : undefined;
    setSaved(kept?.memory ?? '');
    setDraft(kept?.memory ?? '');
    setPath(kept?.path ?? '');
    setReady(false);
    if (botId && useStore.getState().conn === 'connected') void load(botId, !!kept);
    // another bot on screen: what was typed for this one is saved first
    return flush;
  }, [botId]);

  // the connection coming (back) up, and the bot's turn ending: read it again
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    if (connected && botId && !editing.current) void load(botId, ready);
  }, [connected, working]);
  const stats = useMemo(() => memoryStats(draft), [draft]);

  const edit = (value: string) => {
    if (!botId || !ready) return;
    setDraft(value);
    const id = botId;
    queue(async () => {
      const from = activeComputer();
      const res = await call('bots.memory.set', { id, memory: value }, { errorTitle: 'Could not save memory' });
      if (res && from === 'cloud') remember(memoryKey(id), { memory: value, path: (getState().remembered[memoryKey(id)]?.value as KeptMemory | undefined)?.path ?? '' }, from);
      if (res && shown.current === id) setSaved(value);
    });
  };

  if (!bot) {
    return (
      <div className="flex h-full flex-col">
        <EmptyState icon={Brain} title="No bot selected" body="Pick a bot to see what it remembers." className="flex-1" />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {stats.overCap ? (
        <p className="px-4 pb-2.5 text-note leading-snug text-warning">It is long: a new thread loads only the newest {MEMORY_CAP_LABEL} (and the lines at the top).</p>
      ) : null}

      <div className="relative flex min-h-0 flex-1 flex-col px-4">
        {loading ? (
          <div className="flex flex-1 items-center justify-center text-muted"><Spinner size={18} /></div>
        ) : !ready ? (
          <EmptyState
            icon={Brain} title="Couldn’t load the memory" className="flex-1"
            body={`${bot.name}’s memory is safe on the computer. Nothing is changed until it can be read.`}
            action={<Button size="sm" variant="secondary" onClick={() => void load(bot.id)}>Try again</Button>}
          />
        ) : (
          <MarkdownEditor
            value={draft}
            onChange={edit}
            onKeyDown={(e) => {
              if (mod(e) && e.key.toLowerCase() === 's') { e.preventDefault(); flush(); }
            }}
            label="MEMORY.md"
            accent={bot.color}
            ariaLabel={`${bot.name} memory`}
            placeholder={`# Memory - ${bot.name}\n\n- Facts ${bot.name} should keep in mind in every thread.`}
            className="min-h-0 flex-1"
          />
        )}
      </div>

      <div className="flex h-11 shrink-0 items-center gap-2 px-4">
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted select-text" title={path}>
          {path || ' '}
        </span>
        {busy ? <span role="status" className="shrink-0 text-[11px] text-muted">Saving…</span>
          : !loading && !stats.empty ? <span className="shrink-0 text-[11px] tabular-nums text-muted">{stats.entries} entr{stats.entries === 1 ? 'y' : 'ies'} · {stats.size}</span> : null}
        {/* a remote computer's memory file isn't in this Mac's Finder */}
        {path && !remote ? (
          <Tooltip label={SHOW_IN_FOLDER}>
            <Button variant="ghost" size="icon-sm" icon={FolderSearch} aria-label={SHOW_IN_FOLDER} onClick={() => void native().showInFolder(path)} />
          </Tooltip>
        ) : null}
      </div>
    </div>
  );
}
