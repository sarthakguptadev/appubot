/**
 * Settings › Usage: the agents whose history is a SQLite database, OpenCode's `opencode.db` and GitHub Copilot CLI's
 * `session-store.db`, read with Node's own `node:sqlite` (Electron 44 runs Node 24, which has it: no native
 * dependency). A database is opened read-only and never written. Both agents keep theirs in WAL mode, where a reader
 * gets in beside a running writer; a lock held anyway (a checkpoint) fails within `BUSY_MS` and that database is
 * skipped until the next look. Rows are read a page at a time with a yield between pages. Parsing is usageLogs.ts'.
 *
 * OpenCode's reading is ported from T3 Code's (MIT; packages/provider-opencode/src/server/usage.ts): both its tables
 * (`message`, and `session_message` since its v2 sessions, which repeat migrated messages under the same ids) plus
 * the JSON files of its storage before the database.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { parseCopilotRow, parseOpenCodeMessage, type CopilotUsageRow, type UsageRecord } from './usageLogs';

type Sqlite = typeof import('node:sqlite');

/** how long a read waits for a lock before giving up */
const BUSY_MS = 100;
/** rows per statement: `all()` holds a page's rows (an OpenCode row is a whole message) in memory at once */
const PAGE = 64;

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

let sqlite: Sqlite | null | undefined;
/** `node:sqlite`, or null where this Node has none. Loaded on first use: it only exists under the `node:` prefix. */
export function loadSqlite(): Sqlite | null {
  if (sqlite === undefined) {
    try { sqlite = (process.getBuiltinModule('node:sqlite') as Sqlite | undefined) ?? null; } catch { sqlite = null; }
  }
  return sqlite;
}

function openReadOnly(path: string): DatabaseSync {
  const s = loadSqlite();
  if (!s) throw new Error('This version of Node has no SQLite');
  return new s.DatabaseSync(path, { readOnly: true, timeout: BUSY_MS });
}

const tablesOf = (db: DatabaseSync): Set<string> =>
  new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => String(r.name)));
const columnsOf = (db: DatabaseSync, table: string): Set<string> =>
  new Set(db.prepare(`PRAGMA table_info("${table}")`).all().map((r) => String(r.name)));

/**
 * Hands every row of `select … FROM table WHERE <where>` to `onRow`, a page of rowids at a time. Rows added while it
 * reads are left for the next look.
 */
async function eachRow(
  db: DatabaseSync, table: string, select: string, where: string[], params: SQLInputValue[], onRow: (row: Record<string, unknown>) => void,
): Promise<void> {
  const range = db.prepare(`SELECT MIN(rowid) AS first, MAX(rowid) AS last FROM "${table}"`).get();
  const first = range?.first;
  const last = range?.last;
  if (typeof first !== 'number' || typeof last !== 'number') return;
  const stmt = db.prepare(`SELECT ${select} FROM "${table}" WHERE ${[...where, 'rowid > ?', 'rowid <= ?'].join(' AND ')} ORDER BY rowid`);
  for (let after = first - 1; after < last; after += PAGE) {
    for (const row of stmt.all(...params, after, Math.min(after + PAGE, last))) onRow(row);
    await tick();
  }
}

/** the folder of each session, by id, from the tables that have one */
function sessionFolders(db: DatabaseSync, tables: Set<string>, names: string[], column: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const t of names) {
    if (!tables.has(t) || !columnsOf(db, t).has(column)) continue;
    for (const r of db.prepare(`SELECT id, "${column}" AS dir FROM "${t}"`).iterate()) {
      if (typeof r.id === 'string' && typeof r.dir === 'string') out.set(r.id, r.dir);
    }
  }
  return out;
}

/** OpenCode's database files in its data folder: `opencode.db`, then any `opencode-<channel>.db` */
export async function openCodeDatabases(root: string): Promise<string[]> {
  let names: string[];
  try { names = await readdir(root); } catch { return []; }
  const dbs = names.filter((n) => /^opencode(?:-[a-zA-Z0-9_-]+)?\.db$/.test(n))
    .sort((a, b) => (a === 'opencode.db' ? -1 : b === 'opencode.db' ? 1 : a.localeCompare(b)));
  const out: string[] = [];
  for (const n of dbs) {
    try { if ((await stat(join(root, n))).isFile()) out.push(join(root, n)); } catch { /* gone */ }
  }
  return out;
}

/** An OpenCode database's assistant messages created since `sinceMs`. */
export async function readOpenCodeDb(path: string, sinceMs: number, botsRoot?: string): Promise<UsageRecord[]> {
  const db = openReadOnly(path);
  try {
    const tables = tablesOf(db);
    const folders = sessionFolders(db, tables, ['session', 'session_v2'], 'directory');
    const out: UsageRecord[] = [];
    for (const table of ['message', 'session_message']) {
      if (!tables.has(table)) continue;
      const cols = columnsOf(db, table);
      if (!cols.has('data')) continue;
      const timed = cols.has('time_created');
      const where = [...(table === 'session_message' && cols.has('type') ? ["type = 'assistant'"] : []), ...(timed ? ['time_created >= ?'] : [])];
      const select = `${cols.has('id') ? 'id' : 'NULL'} AS id, ${cols.has('session_id') ? 'session_id' : 'NULL'} AS session_id, data, ${timed ? 'time_created' : 'NULL'} AS created`;
      await eachRow(db, table, select, where, timed ? [sinceMs] : [], (row) => {
        if (typeof row.data !== 'string') return;
        const r = parseOpenCodeMessage(row.data, botsRoot, {
          id: typeof row.id === 'string' ? row.id : undefined,
          created: typeof row.created === 'number' ? row.created : undefined,
          cwd: typeof row.session_id === 'string' ? folders.get(row.session_id) : undefined,
        });
        if (r && r.ts >= sinceMs) out.push(r);
      });
    }
    return out;
  } finally {
    db.close();
  }
}

/**
 * OpenCode's storage from before its database: one `storage/message/<session>/<id>.json` per message. Files untouched
 * since `sinceMs` are skipped (a message is never newer than its file).
 */
export async function readOpenCodeLegacy(root: string, sinceMs: number, botsRoot?: string): Promise<UsageRecord[]> {
  const out: UsageRecord[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { await walk(p); continue; }
      if (!e.isFile() || !e.name.endsWith('.json')) continue;
      try {
        if ((await stat(p)).mtimeMs < sinceMs) continue;
        const r = parseOpenCodeMessage(await readFile(p, 'utf8'), botsRoot, { id: e.name.slice(0, -5) });
        if (r && r.ts >= sinceMs) out.push(r);
      } catch { /* gone or unreadable */ }
    }
    await tick();
  };
  await walk(join(root, 'storage', 'message'));
  return out;
}

/** Copilot CLI's model requests (`assistant_usage_events`) made since `sinceMs`. */
export async function readCopilotDb(path: string, sinceMs: number, botsRoot?: string): Promise<UsageRecord[]> {
  const db = openReadOnly(path);
  try {
    const tables = tablesOf(db);
    const table = 'assistant_usage_events';
    if (!tables.has(table)) return [];
    const cols = columnsOf(db, table);
    const want = ['id', 'session_id', 'model', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'token_details_json', 'created_at'];
    if (!cols.has('model') || !cols.has('created_at')) return [];
    const folders = sessionFolders(db, tables, ['sessions'], 'cwd');
    const select = want.map((c) => (cols.has(c) ? `"${c}"` : `NULL AS "${c}"`)).join(', ');
    const out: UsageRecord[] = [];
    await eachRow(db, table, select, [], [], (row) => {
      const r = parseCopilotRow({ ...(row as unknown as CopilotUsageRow), cwd: typeof row.session_id === 'string' ? folders.get(row.session_id) : undefined }, botsRoot);
      if (r && r.ts >= sinceMs) out.push(r);
    });
    return out;
  } finally {
    db.close();
  }
}
