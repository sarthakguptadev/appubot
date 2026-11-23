/**
 * Settings › Usage (`usage.summary`): how much the agents on this computer were used, read from their own logs.
 * Claude Code's transcripts (`~/.claude/projects/**\/*.jsonl`) and Codex's rollouts (`~/.codex/sessions/**\/*.jsonl`),
 * plus each Claude Code / Codex profile's own folder (`Provider.profile.home`); Grok's session updates
 * (`~/.grok/sessions/<cwd>/<session>/updates.jsonl`), Pi's sessions (`~/.pi/agent/sessions/**\/*.jsonl`), Gemini CLI's
 * chats (`~/.gemini/tmp/<project>/chats/`); OpenCode's database (`~/.local/share/opencode/opencode.db`) and Copilot
 * CLI's (`~/.copilot/session-store.db`), through usageSqlite.ts. Nothing leaves the computer, nothing is written, and
 * only token counts are read (never what was said). Parsing, prices and adding up live in usageLogs.ts.
 *
 * Files are read lazily on the first summary and kept parsed per path; a file seen before is skipped when its size and
 * mtime are the same, and read on from where it stopped when it grew (the JSONL logs are only appended to; Gemini
 * CLI's older `.json` chats are rewritten whole, so they're read again whole). A database is read again (its last 31
 * days) when it or its WAL changed. Only files touched in the last 31 days are read, and only their records from then
 * on are kept. Files are streamed in chunks, yielding to the event loop between them, so a first scan of gigabytes of
 * logs never blocks the gateway.
 */
import { homedir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { open, readFile, readdir, realpath, stat } from 'node:fs/promises';
import type { Provider, UsageRange, UsageScope, UsageSummary } from '@appubot/protocol';
import type { CoreCtx } from '../context';
import { errMsg } from '../util';
import {
  KEEP_MS, MODEL_PRICES, codexState, inBotsRoot, parseClaudeLine, parseCodexLine, parseGeminiFile, parseGeminiLine, parseGrokLine, parsePiLine, piState, summarize,
  type CodexState, type PiState, type UsageRecord,
} from './usageLogs';
import { loadSqlite, openCodeDatabases, readCopilotDb, readOpenCodeDb, readOpenCodeLegacy } from './usageSqlite';

/** agents whose logs are files of lines, read as they grow */
type LogKind = 'claude' | 'codex' | 'grok' | 'pi' | 'gemini';
/** agents whose history is a SQLite database */
type DbKind = 'opencode' | 'copilot';
type Kind = LogKind | DbKind;

/** one agent's log folder */
interface Source { id: string; name: string; kind: Kind; dir: string }

interface FileEntry {
  size: number;
  mtimeMs: number;
  /** bytes read up to the end of the last whole line */
  offset: number;
  records: UsageRecord[];
  /** Codex / Pi: what the log carries forward (the model, the session, the bot) to read on from `offset` */
  state?: CodexState | PiState;
  /** a database: its file's and its WAL's size and mtime when read */
  sig?: string;
}

const isDb = (k: Kind): k is DbKind => k === 'opencode' || k === 'copilot';

const CHUNK = 1 << 20;
/** yield to the event loop every this many bytes inside a big file */
const YIELD_EVERY = 8 * CHUNK;
const NL = 0x0a;

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

/** the lines worth parsing (everything else is skipped without JSON.parse) */
const MARKERS: Record<LogKind, string[]> = {
  claude: ['"usage"'],
  codex: ['"token_count"', '"turn_context"', '"session_meta"'],
  grok: ['"turn_completed"'],
  pi: ['"usage"', '"session"'],
  gemini: ['"tokens"'],
};

/** which files under a source's folder are its logs */
const LOG_FILES: Record<LogKind, (path: string) => boolean> = {
  claude: (p) => p.endsWith('.jsonl'),
  codex: (p) => p.endsWith('.jsonl'),
  pi: (p) => p.endsWith('.jsonl'),
  // only updates.jsonl carries usage (chat_history and events logs are large and don't)
  grok: (p) => basename(p) === 'updates.jsonl',
  gemini: (p) => p.includes(`${sep}chats${sep}`) && (p.endsWith('.jsonl') || p.endsWith('.json')),
};

/**
 * Reads `path` from `start`, handing each whole line that contains a marker to `onLine`. Returns the offset after the
 * last line handed over: a last line without its newline is only taken when it parses (else it's still being written).
 */
export async function readJsonLines(path: string, start: number, markers: string[], onLine: (line: string) => void): Promise<number> {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.allocUnsafe(CHUNK);
    let pos = start;
    let consumed = start;
    let carry: Buffer | null = null;
    let sinceYield = 0;
    const take = (line: Buffer): void => {
      if (line.length && markers.some((m) => line.includes(m))) onLine(line.toString('utf8'));
    };
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, CHUNK, pos);
      if (!bytesRead) break;
      pos += bytesRead;
      let data = buf.subarray(0, bytesRead);
      if (carry) { data = Buffer.concat([carry, data]); carry = null; }
      let from = 0;
      for (let nl = data.indexOf(NL, from); nl >= 0; nl = data.indexOf(NL, from)) {
        take(data.subarray(from, nl));
        consumed += nl + 1 - from;
        from = nl + 1;
      }
      // copy: `buf` is reused by the next read
      if (from < data.length) carry = Buffer.from(data.subarray(from));
      sinceYield += bytesRead;
      if (sinceYield >= YIELD_EVERY) { sinceYield = 0; await tick(); }
    }
    if (carry?.length) {
      const text = carry.toString('utf8');
      try {
        JSON.parse(text);
        take(carry);
        consumed += carry.length;
      } catch { /* still being written: read it next time */ }
    }
    return consumed;
  } finally {
    await fh.close();
  }
}

/** every file under `dir` that `accept`s (no symlinked folders) */
async function logFiles(dir: string, accept: (path: string) => boolean): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string): Promise<void> => {
    let entries;
    try { entries = await readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile() && accept(p)) out.push(p);
    }
  };
  await walk(dir);
  return out;
}

/** a database's own file and its WAL, as a change signature ('' when it's gone) */
async function dbSig(path: string): Promise<string> {
  const part = async (p: string): Promise<string> => {
    try { const st = await stat(p); return `${st.size}:${st.mtimeMs}`; } catch { return '-'; }
  };
  const main = await part(path);
  return main === '-' ? '' : `${main}|${await part(`${path}-wal`)}`;
}

export class UsageService {
  private files = new Map<string, FileEntry>();
  /** which files each source had at its last scan */
  private sourceFiles = new Map<string, string[]>();
  private scanning: Promise<Source[]> | null = null;

  constructor(private ctx: CoreCtx) {}

  async summary(range: UsageRange, scope: UsageScope = 'all', now = Date.now()): Promise<UsageSummary> {
    const sources = await this.scan(now);
    const files = this.files;
    const records = (dir: string): Iterable<UsageRecord> => {
      const paths = this.sourceFiles.get(dir) ?? [];
      return (function* () { for (const p of paths) yield* files.get(p)?.records ?? []; })();
    };
    return summarize(sources.map((s) => ({ id: s.id, name: s.name, records: records(s.dir) })), range, now, MODEL_PRICES, scope);
  }

  /** the agents' log folders that exist: the built-ins' own, then each profile's (one folder counts once) */
  async sources(): Promise<Source[]> {
    const home = this.ctx.deps.homeDir ?? homedir();
    // a test home ignores the developer's own variables
    const env: NodeJS.ProcessEnv = this.ctx.deps.homeDir ? {} : process.env;
    const v = (name: string): string | undefined => env[name]?.trim() || undefined;
    let providers: Provider[] = [];
    try { providers = this.ctx.s.providers.list(); } catch (e) { this.ctx.log.warn('usage: providers', errMsg(e)); }
    const builtins: { id: string; kind: Kind; name: string; dir: string }[] = [
      { id: 'claude-code', kind: 'claude', name: 'Claude Code', dir: join(home, '.claude', 'projects') },
      { id: 'codex', kind: 'codex', name: 'Codex', dir: join(home, '.codex', 'sessions') },
    ];
    const all: Source[] = [];
    for (const b of builtins) {
      const p = providers.find((x) => x.id === b.id);
      const name = p?.name ?? b.name;
      const hasProfiles = providers.some((x) => x.profile?.of === b.id);
      all.push({ id: b.id, kind: b.kind, dir: b.dir, name: hasProfiles ? `${name} · ${p?.profileName ?? 'Main'}` : name });
      for (const x of providers) {
        if (x.profile?.of !== b.id) continue;
        all.push({ id: x.id, kind: b.kind, name: x.name, dir: join(x.profile.home, b.kind === 'claude' ? 'projects' : 'sessions') });
      }
    }
    // where each agent keeps its history by default, or where its own variables move it
    const piDir = v('PI_CODING_AGENT_DIR');
    const others: Source[] = [
      { id: 'grok', kind: 'grok', name: 'Grok', dir: join(v('GROK_HOME') ?? join(home, '.grok'), 'sessions') },
      { id: 'opencode', kind: 'opencode', name: 'OpenCode', dir: v('OPENCODE_DATA_DIR')?.split(',')[0]?.trim() || join(v('XDG_DATA_HOME') ?? join(home, '.local', 'share'), 'opencode') },
      { id: 'copilot', kind: 'copilot', name: 'GitHub Copilot', dir: join(home, '.copilot') },
      { id: 'gemini', kind: 'gemini', name: 'Gemini CLI', dir: join(home, '.gemini', 'tmp') },
      { id: 'pi', kind: 'pi', name: 'Pi', dir: v('PI_CODING_AGENT_SESSION_DIR') ?? join(piDir ?? join(home, '.pi', 'agent'), 'sessions') },
    ];
    const sqlite = loadSqlite() !== null;
    for (const o of others) {
      // a database needs node:sqlite (every Electron AppuBot ships with has it)
      if (isDb(o.kind) && !sqlite) continue;
      all.push({ ...o, name: providers.find((x) => x.id === o.id)?.name ?? o.name });
    }
    const seen = new Set<string>();
    const out: Source[] = [];
    for (const s of all) {
      let real: string;
      try {
        if (!(await stat(s.dir)).isDirectory()) continue;
        real = await realpath(s.dir);
      } catch { continue; }
      if (seen.has(real)) continue;
      seen.add(real);
      out.push(s);
    }
    return out;
  }

  /** brings the parsed files up to date (one scan at a time; a caller during one waits for it) */
  private scan(now: number): Promise<Source[]> {
    if (!this.scanning) {
      this.scanning = this.doScan(now).finally(() => { this.scanning = null; });
    }
    return this.scanning;
  }

  private async doScan(now: number): Promise<Source[]> {
    const sources = await this.sources();
    const keepFrom = now - KEEP_MS;
    const live = new Set<string>();
    this.sourceFiles.clear();
    for (const s of sources) {
      const paths = isDb(s.kind) ? await this.scanDb(s, s.kind, keepFrom) : await this.scanLogs(s, s.kind, keepFrom);
      for (const p of paths) live.add(p);
      this.sourceFiles.set(s.dir, paths);
    }
    for (const p of this.files.keys()) if (!live.has(p)) this.files.delete(p);
    return sources;
  }

  /** a log folder's files, read on where they grew */
  private async scanLogs(s: Source, kind: LogKind, keepFrom: number): Promise<string[]> {
    const botsRoot = this.ctx.paths.botsRoot;
    // Grok's and Gemini CLI's lines don't say where they ran: their folders do
    const botDirs = new Map<string, boolean>();
    const fileBot = async (path: string): Promise<boolean> => {
      if (kind === 'grok') {
        // sessions/<url-encoded cwd>/<session>/updates.jsonl
        try { return inBotsRoot(decodeURIComponent(basename(dirname(dirname(path)))), botsRoot); } catch { return false; }
      }
      if (kind !== 'gemini') return false;
      // tmp/<project>/chats/…: the project's folder is in tmp/<project>/.project_root
      const project = join(s.dir, path.slice(s.dir.length + 1).split(sep)[0] ?? '');
      let bot = botDirs.get(project);
      if (bot === undefined) {
        try { bot = inBotsRoot((await readFile(join(project, '.project_root'), 'utf8')).trim(), botsRoot); } catch { bot = false; }
        botDirs.set(project, bot);
      }
      return bot;
    };
    const paths: string[] = [];
    for (const path of await logFiles(s.dir, LOG_FILES[kind])) {
      let st;
      try { st = await stat(path); } catch { continue; }
      if (st.mtimeMs < keepFrom) continue;
      paths.push(path);
      const prev = this.files.get(path);
      if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs) continue;
      try {
        const bot = await fileBot(path);
        if (kind === 'gemini' && path.endsWith('.json')) {
          // an older Gemini CLI rewrites the whole chat each time
          const records = parseGeminiFile(await readFile(path, 'utf8'), bot).filter((r) => r.ts >= keepFrom);
          this.files.set(path, { size: st.size, mtimeMs: st.mtimeMs, offset: st.size, records });
          continue;
        }
        // the logs only grow: read on from where it stopped, else (smaller: rewritten) from the start
        const resume = prev && st.size >= prev.offset ? prev : undefined;
        const records = resume ? resume.records.filter((r) => r.ts >= keepFrom) : [];
        const state = kind === 'codex' ? (resume?.state ?? codexState()) : kind === 'pi' ? (resume?.state ?? piState()) : undefined;
        const keep = (r: UsageRecord | null): void => { if (r && r.ts >= keepFrom) records.push(r); };
        const offset = await readJsonLines(path, resume?.offset ?? 0, MARKERS[kind], (line) => {
          switch (kind) {
            case 'claude': keep(parseClaudeLine(line, botsRoot)); break;
            case 'codex': keep(parseCodexLine(line, state as CodexState, botsRoot)); break;
            case 'pi': keep(parsePiLine(line, state as PiState, botsRoot)); break;
            case 'grok': for (const r of parseGrokLine(line, bot)) keep(r); break;
            case 'gemini': keep(parseGeminiLine(line, bot)); break;
          }
        });
        this.files.set(path, { size: st.size, mtimeMs: st.mtimeMs, offset, records, state });
      } catch (e) {
        this.ctx.log.warn('usage: could not read a log', errMsg(e));
      }
      await tick();
    }
    return paths;
  }

  /** an agent's database(s), read again when changed; one that's locked or unreadable keeps what was read before */
  private async scanDb(s: Source, kind: DbKind, keepFrom: number): Promise<string[]> {
    const botsRoot = this.ctx.paths.botsRoot;
    const dbs = kind === 'opencode' ? await openCodeDatabases(s.dir) : [join(s.dir, 'session-store.db')];
    const paths: string[] = [];
    for (const path of dbs) {
      const sig = await dbSig(path);
      if (!sig) continue;
      paths.push(path);
      const prev = this.files.get(path);
      if (prev?.sig === sig) continue;
      try {
        const records = kind === 'opencode' ? await readOpenCodeDb(path, keepFrom, botsRoot) : await readCopilotDb(path, keepFrom, botsRoot);
        this.files.set(path, { size: 0, mtimeMs: 0, offset: 0, records, sig });
      } catch (e) {
        this.ctx.log.warn('usage: could not read a database', errMsg(e));
      }
      await tick();
    }
    if (kind === 'opencode') {
      // its storage before the database; the same messages migrated into it count once (by id)
      const legacy = join(s.dir, 'storage', 'message');
      try {
        if ((await stat(legacy)).isDirectory()) {
          paths.push(legacy);
          this.files.set(legacy, { size: 0, mtimeMs: 0, offset: 0, records: await readOpenCodeLegacy(s.dir, keepFrom, botsRoot) });
        }
      } catch { /* none */ }
    }
    return paths;
  }
}
