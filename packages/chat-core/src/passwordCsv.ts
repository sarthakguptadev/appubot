/**
 * Saved passwords from a browser or password manager, read from the CSV file it exports, as Vault logins
 * (Settings › Vault › Import passwords). The file is read in the app's window and goes nowhere else: each row becomes
 * a `vault.save` login on the computer on screen.
 *
 * Read by their header row, whatever the order: Chrome, Edge, Brave and Arc (`name,url,username,password,note`),
 * Safari and iCloud Passwords (`Title,URL,Username,Password,Notes,OTPAuth`), Firefox (`url,username,password,…`),
 * 1Password, Bitwarden (`login_uri,login_username,login_password`), LastPass (`url,username,password,totp,extra,name`)
 * and Dashlane. A row with no password (a secure note, a card) is left out; one-time-code secrets are never read.
 */
import type { VaultItem } from '@appubot/protocol';

/** a login as the Vault takes it */
export interface ImportedLogin { name: string; site: string; username: string; password: string; notes?: string }

export interface PasswordFile {
  logins: ImportedLogin[];
  /** rows the file had, its header aside */
  rows: number;
  /** rows left out: no password in them */
  empty: number;
  /** rows left out: the same site, username and password as an earlier row */
  repeated: number;
}

/** the file isn't a password export: what to tell the person */
export class PasswordFileError extends Error {}

const NAME_MAX = 80;
const SITE_MAX = 200;
const USERNAME_MAX = 200;
const NOTES_MAX = 1000;
const PASSWORD_MAX = 1000;
/** more rows than any real export; a file this long is something else */
export const PASSWORD_ROWS_MAX = 5000;

const COLUMNS: Record<'url' | 'username' | 'password' | 'name' | 'notes', string[]> = {
  url: ['url', 'login_uri', 'uri', 'website', 'web site', 'login url', 'urls', 'location', 'site'],
  username: ['username', 'login_username', 'user name', 'user', 'login', 'login name', 'email', 'e-mail'],
  password: ['password', 'login_password', 'pass'],
  name: ['name', 'title', 'account', 'item name'],
  notes: ['note', 'notes', 'extra', 'comments', 'comment'],
};

/**
 * A CSV text as rows of cells (RFC 4180: quoted cells may hold commas, line breaks and `""` for a quote; a BOM and
 * empty lines are dropped). `delimiter`: found from the header when not given (comma, semicolon or tab).
 */
export function parseCsv(text: string, delimiter?: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const d = delimiter ?? guessDelimiter(src);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let wasQuoted = false;
  const endCell = () => { row.push(cell); cell = ''; wasQuoted = false; };
  const endRow = () => {
    endCell();
    if (row.length > 1 || row[0] !== '') rows.push(row);
    row = [];
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"' && cell === '' && !wasQuoted) { quoted = true; wasQuoted = true; continue; }
    if (ch === d) { endCell(); continue; }
    if (ch === '\r') { if (src[i + 1] === '\n') i++; endRow(); continue; }
    if (ch === '\n') { endRow(); continue; }
    cell += ch;
  }
  if (cell !== '' || row.length) endRow();
  return rows;
}

function guessDelimiter(src: string): string {
  const end = src.search(/\r|\n/);
  const head = end < 0 ? src : src.slice(0, end);
  const count = (c: string) => head.split(c).length - 1;
  const best = [',', ';', '\t'].map((c) => [c, count(c)] as const).sort((a, b) => b[1] - a[1])[0]!;
  return best[1] > 0 ? best[0] : ',';
}

/** A web address as the Vault's "website or app": its host without `www.`, an Android app's package, else as written. */
export function siteOf(url: string): string {
  const raw = url.trim();
  if (!raw) return '';
  // Chrome's saved Android app logins: android://<hash>@com.example.app/
  const android = /^android:\/\/[^@/]*@([^/]+)/i.exec(raw);
  if (android) return android[1]!.slice(0, SITE_MAX);
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (u.hostname) return u.hostname.replace(/^www\./i, '').toLowerCase().slice(0, SITE_MAX);
  } catch { /* not an address: kept as written */ }
  return raw.slice(0, SITE_MAX);
}

const clean = (v: string | undefined) => (v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim();

/**
 * The logins in a password export. Throws `PasswordFileError` (with words for the person) when the text has no
 * header row naming a password column, or more rows than any export.
 */
export function readPasswordFile(text: string): PasswordFile {
  const table = parseCsv(text);
  const header = (table[0] ?? []).map((h) => h.trim().toLowerCase());
  const col = (kind: keyof typeof COLUMNS) => {
    for (const want of COLUMNS[kind]) {
      const i = header.indexOf(want);
      if (i >= 0) return i;
    }
    return -1;
  };
  const at = { url: col('url'), username: col('username'), password: col('password'), name: col('name'), notes: col('notes') };
  if (at.password < 0 || (at.url < 0 && at.name < 0)) {
    throw new PasswordFileError('This doesn’t look like a passwords file. Export your passwords as a CSV file from your browser or password manager, then choose that file.');
  }
  const body = table.slice(1);
  if (body.length > PASSWORD_ROWS_MAX) throw new PasswordFileError(`This file has ${body.length.toLocaleString('en-US')} rows, more than AppuBot brings in at once (${PASSWORD_ROWS_MAX.toLocaleString('en-US')}).`);

  const logins: ImportedLogin[] = [];
  const seen = new Set<string>();
  let empty = 0;
  let repeated = 0;
  for (const r of body) {
    const cell = (i: number) => (i >= 0 ? clean(r[i]) : '');
    const password = (at.password >= 0 ? r[at.password] ?? '' : '').replace(/\r?\n/g, '');
    if (!password.trim()) { empty++; continue; }
    const site = siteOf(cell(at.url));
    const username = cell(at.username).slice(0, USERNAME_MAX);
    const key = `${site.toLowerCase()}\n${username.toLowerCase()}\n${password}`;
    if (seen.has(key)) { repeated++; continue; }
    seen.add(key);
    const name = (cell(at.name) || site || username || 'Login').replace(/\s+/g, ' ').slice(0, NAME_MAX);
    const notes = cell(at.notes).slice(0, NOTES_MAX);
    logins.push({ name, site, username, password: password.slice(0, PASSWORD_MAX), ...(notes ? { notes } : {}) });
  }
  return { logins: nameApart(logins), rows: body.length, empty, repeated };
}

/** Logins that share a name are told apart by their username ("GitHub (me@work.com)"). */
function nameApart(logins: ImportedLogin[]): ImportedLogin[] {
  const count = new Map<string, number>();
  for (const l of logins) count.set(l.name.toLowerCase(), (count.get(l.name.toLowerCase()) ?? 0) + 1);
  return logins.map((l) => {
    if ((count.get(l.name.toLowerCase()) ?? 0) < 2 || !l.username) return l;
    const tail = ` (${l.username})`;
    return { ...l, name: `${l.name.slice(0, Math.max(1, NAME_MAX - tail.length))}${tail}`.slice(0, NAME_MAX) };
  });
}

/** one login of a file against the Vault: new, or the same site and username as a login already saved (`id`) */
export interface LoginPlanRow { login: ImportedLogin; existing?: { id: string; name: string } }

const sameLogin = (site: string, username: string) => `${site.trim().replace(/^www\./i, '').toLowerCase()}\n${username.trim().toLowerCase()}`;

/** Which of a file's logins are new to this Vault, and which are already there (same site and username). */
export function planLoginImport(logins: readonly ImportedLogin[], vault: readonly Pick<VaultItem, 'id' | 'kind' | 'name' | 'site' | 'username'>[]): LoginPlanRow[] {
  const have = new Map<string, { id: string; name: string }>();
  for (const i of vault) {
    if (i.kind !== 'login') continue;
    const key = sameLogin(i.site ?? '', i.username ?? '');
    // a login with neither can't be matched: it never stands for another
    if (key !== '\n' && !have.has(key)) have.set(key, { id: i.id, name: i.name });
  }
  return logins.map((login) => {
    const existing = have.get(sameLogin(login.site, login.username));
    return existing && sameLogin(login.site, login.username) !== '\n' ? { login, existing } : { login };
  });
}

/** "214 logins" / "1 login" */
export const loginsCount = (n: number): string => `${n.toLocaleString('en-US')} ${n === 1 ? 'login' : 'logins'}`;

/** What a file held, in a line: "214 logins · 3 already in the Vault · 12 rows without a password left out". */
export function passwordFileSummary(file: PasswordFile, plan: readonly LoginPlanRow[]): string {
  const there = plan.filter((r) => r.existing).length;
  return [
    loginsCount(file.logins.length),
    there ? `${there.toLocaleString('en-US')} already in the Vault` : '',
    file.empty ? `${file.empty.toLocaleString('en-US')} ${file.empty === 1 ? 'row' : 'rows'} without a password left out` : '',
    file.repeated ? `${file.repeated.toLocaleString('en-US')} repeated` : '',
  ].filter(Boolean).join(' · ');
}

/** where each app keeps its export, for the dialog */
export const PASSWORD_EXPORT_STEPS: { app: string; steps: string }[] = [
  { app: 'Chrome, Edge, Brave, Arc', steps: 'Settings › Passwords (Google Password Manager) › Settings › Export passwords' },
  { app: 'Safari', steps: 'File › Export Browsing Data to File… › Passwords (or Passwords app › File › Export All Passwords)' },
  { app: 'Firefox', steps: 'Passwords › ⋯ › Export Passwords…' },
  { app: '1Password, Bitwarden, others', steps: 'Export › CSV' },
];
