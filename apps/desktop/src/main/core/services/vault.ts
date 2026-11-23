/**
 * The Vault (Settings › Vault): logins, cards, contact info and API keys every bot can use without seeing the secrets.
 * A bot lists items (`agent.vault.list`: names and what's not secret), has AppuBot type a password, card number or
 * security code into an app window (`agent.vault.fill`, a computer-use typing step whose text is masked everywhere and
 * after which nothing of the window comes back), or gets an API key in a private file it reads (`agent.vault.key`:
 * `<dataDir>/vault-keys/<botId>.env`, `KEY=value` lines). The first use of an item in a chat waits for the user's
 * "Allow". Items live in `<dataDir>/vault.json` (0600), secrets sealed with the OS keychain (`deps.secretBox`).
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ENV_NAME, VAULT_SECRETS, VaultContactSchema, cardBrand, computerUseSupported, newId,
  type MethodParams, type MethodResult, type QuestionForm, type VaultContact, type VaultItem, type VaultKind, type VaultSecretField,
} from '@appubot/protocol';
import { VAULT_CONTACT_FIELDS, VAULT_FORM_WHAT, cleanFormValues, formProblems, vaultAnswerText, vaultFormFields } from '@appubot/chat-core';
import type { AgentContext } from '../auth';
import type { CoreCtx } from '../context';
import { errMsg, notFound, RpcError } from '../util';

const FILE = 'vault.json';
const ALLOW = 'Allow';
const DONT_ALLOW = "Don't allow";

/** A saved secret: sealed by the keychain (`enc`), else as typed (the file is this user's only). */
interface Sealed { v: string; enc?: boolean }

interface StoredItem extends Omit<VaultItem, 'secrets'> {
  secrets: Partial<Record<VaultSecretField, Sealed>>;
}

const KIND_NAME: Record<VaultKind, string> = { login: 'login', card: 'card', contact: 'contact info', apiKey: 'API key' };
const FIELD_NAME: Record<string, string> = {
  username: 'username', password: 'password', number: 'card number', cvc: 'security code', expiry: 'expiry date', cardholder: 'cardholder name',
  fullName: 'name', email: 'email', phone: 'phone number', company: 'company', address1: 'address', address2: 'address (line 2)',
  city: 'city', region: 'state or region', postalCode: 'postal code', country: 'country',
};

type FillField = MethodParams<'agent.vault.fill'>['field'];

/** What a field of an item is, for typing: its value and whether it is a secret (which asks first). */
export function fieldValue(item: StoredItem, field: FillField, open: (s: Sealed) => string): { value: string; secret: boolean } | undefined {
  const sealed = (f: VaultSecretField) => (item.secrets[f] ? { value: open(item.secrets[f]!), secret: true } : undefined);
  const plain = (v: string | undefined) => (v ? { value: v, secret: false } : undefined);
  switch (item.kind) {
    case 'login':
      return field === 'password' ? sealed('password') : field === 'username' ? plain(item.username) : undefined;
    case 'card':
      if (field === 'number' || field === 'cvc') return sealed(field);
      return field === 'expiry' ? plain(item.expiry) : field === 'cardholder' ? plain(item.cardholder) : undefined;
    case 'contact':
      return field in (item.contact ?? {}) ? plain(item.contact?.[field as keyof VaultContact]) : undefined;
    case 'apiKey':
      return undefined;
  }
}

/** A saved item in a line for a Vault card's "Use one you saved" list (never a secret). */
export function itemDetail(i: VaultItem): string {
  switch (i.kind) {
    case 'login': return [i.username, i.site].filter(Boolean).join(' · ');
    case 'card': return [i.brand, i.hint ? `•••• ${i.hint}` : '', i.expiry].filter(Boolean).join(' · ');
    case 'apiKey': return [i.envName, i.hint ? `…${i.hint}` : ''].filter(Boolean).join(' · ');
    case 'contact': return [i.contact?.fullName, i.contact?.email, i.contact?.city].filter(Boolean).join(' · ');
  }
}

/** `KEY=value` lines for a keys file: a value that needs it is single-quoted (shell and dotenv both read that). */
export function envLine(name: string, value: string): string {
  return /^[A-Za-z0-9_./:@+-]*$/.test(value) ? `${name}=${value}` : `${name}='${value.replace(/'/g, `'\\''`)}'`;
}

export class VaultService {
  /** items by login scope (`''` the computer's own `vault.json`, a team member's their own) */
  private items = new Map<string, StoredItem[]>();
  /** items a chat was allowed to use, by thread id (until AppuBot quits) */
  private allowed = new Map<string, Set<string>>();
  /** while `saveMany` runs: items change in memory only */
  private holdWrites = false;

  constructor(private ctx: CoreCtx) {}

  // ---------- the owner's editor (`scope`: a team member's own Vault on a team's computer set to each person's own logins) ----------

  list(scope = ''): MethodResult<'vault.list'> {
    return { items: this.read(scope).map((i) => this.toWire(i)), encrypted: !!this.ctx.deps.secretBox };
  }

  save(p: MethodParams<'vault.save'>, scope = ''): VaultItem {
    const all = this.read(scope);
    const prev = p.id ? all.find((i) => i.id === p.id) : undefined;
    if (p.id && !prev) throw notFound('Vault item', p.id);
    if (prev && prev.kind !== p.kind) throw new RpcError('invalid_params', 'An item’s kind can’t change: make a new one.');
    const kind = p.kind;
    if (kind === 'apiKey') {
      const env = (p.envName ?? '').trim();
      if (!ENV_NAME.test(env)) throw new RpcError('invalid_params', 'Give the key a variable name, like OPENAI_API_KEY.');
      if (all.some((i) => i.id !== prev?.id && i.kind === 'apiKey' && i.envName === env)) throw new RpcError('invalid_params', `Another key already uses ${env}.`);
    }
    const secrets: StoredItem['secrets'] = { ...(prev?.secrets ?? {}) };
    for (const f of VAULT_SECRETS[kind]) {
      const v = p.secrets?.[f];
      if (v === undefined) continue;
      const clean = f === 'number' ? v.replace(/[\s-]/g, '') : v.trim();
      if (!clean) delete secrets[f];
      else secrets[f] = this.seal(clean);
    }
    if (kind === 'card' && secrets.number && !/^\d{12,19}$/.test(this.open(secrets.number))) throw new RpcError('invalid_params', 'A card number has 12 to 19 digits.');
    if (kind === 'card' && p.expiry && !/^(0[1-9]|1[0-2])\/\d{2}$/.test(p.expiry.trim())) throw new RpcError('invalid_params', 'Write the expiry date as MM/YY.');
    const now = Date.now();
    const next: StoredItem = {
      id: prev?.id ?? newId('vlt'), kind, name: p.name.trim(),
      ...(kind === 'login' ? { site: p.site?.trim() || undefined, username: p.username?.trim() || undefined } : {}),
      ...(kind === 'card' ? { cardholder: p.cardholder?.trim() || undefined, expiry: p.expiry?.trim() || undefined } : {}),
      ...(kind === 'contact' ? { contact: VaultContactSchema.parse(p.contact ?? {}) } : {}),
      ...(kind === 'apiKey' ? { envName: p.envName!.trim() } : {}),
      notes: p.notes?.trim() || undefined,
      secrets,
      createdAt: prev?.createdAt ?? now, updatedAt: now,
    };
    this.write(scope, prev ? all.map((i) => (i.id === prev.id ? next : i)) : [...all, next]);
    // a key that changed (or moved to another name) leaves the bots' keys files: they ask for it again
    if (prev?.kind === 'apiKey' && (p.secrets?.key !== undefined || prev.envName !== next.envName)) this.dropKeyEverywhere(prev.envName!);
    return this.toWire(next);
  }

  /**
   * Several items in one go (`vault.saveMany`): every one is checked and sealed as `save` does, and the file is
   * written once at the end. One that is refused leaves the Vault as it was, with its place in the list in the words.
   */
  saveMany(list: MethodParams<'vault.save'>[], scope = ''): { items: VaultItem[] } {
    const before = this.read(scope);
    const hold = this.holdWrites;
    this.holdWrites = true;
    const out: VaultItem[] = [];
    try {
      list.forEach((p, i) => {
        try { out.push(this.save(p, scope)); } catch (e) {
          throw new RpcError(e instanceof RpcError ? e.code : 'invalid_params', `Item ${i + 1} (“${p.name}”): ${errMsg(e)}`);
        }
      });
    } catch (e) {
      this.items.set(scope, before);
      this.holdWrites = hold;
      throw e;
    }
    this.holdWrites = hold;
    this.write(scope, this.read(scope));
    return { items: out };
  }

  delete(id: string, scope = ''): { ok: true } {
    const all = this.read(scope);
    const item = all.find((i) => i.id === id);
    if (!item) throw notFound('Vault item', id);
    this.write(scope, all.filter((i) => i.id !== id));
    if (item.kind === 'apiKey') this.dropKeyEverywhere(item.envName!);
    return { ok: true };
  }

  reveal(id: string, field: VaultSecretField, scope = ''): { value: string } {
    const item = this.require(id, scope);
    const s = item.secrets[field];
    if (!s) throw new RpcError('not_found', 'Nothing is saved there.');
    return { value: this.open(s) };
  }

  // ---------- bots ----------

  /** a bot sees the Vault of its own login scope (its person's, on a team's computer sorted by person) */
  agentList(a: AgentContext, kind?: VaultKind): MethodResult<'agent.vault.list'> {
    return { items: this.read(this.scopeOfBot(a)).filter((i) => !kind || i.kind === kind).map((i) => this.toWire(i)) };
  }
  private scopeOfBot(a: AgentContext): string { return this.ctx.s.logins.scopeOfBotId(a.botId); }

  /** Type a field of an item into a window, asking first (once per chat and item) for a secret. */
  async fill(a: AgentContext, p: MethodParams<'agent.vault.fill'>): Promise<MethodResult<'agent.vault.fill'>> {
    const bot = this.ctx.s.bots.require(a.botId);
    if (!bot.computerUse || !this.ctx.s.settings.get().computer.enabled || !computerUseSupported(process.platform)) {
      throw new RpcError('forbidden', `${bot.name} can't use the computer, so it can't type Vault items. The user can turn computer use on in the bot's settings.`);
    }
    const item = this.require(p.id, this.scopeOfBot(a));
    let got: { value: string; secret: boolean } | undefined;
    try { got = fieldValue(item, p.field, (s) => this.open(s)); } catch (e) { throw new RpcError('unavailable', `Couldn't unlock “${item.name}”: ${errMsg(e)}`); }
    if (!got) throw new RpcError('not_found', `“${item.name}” has no ${FIELD_NAME[p.field] ?? p.field} saved.`);
    const what = FIELD_NAME[p.field] ?? p.field;
    if (got.secret) {
      const where = this.ctx.s.computer.windowName(p.pid, p.windowId) ?? 'the window it is working in';
      const site = item.kind === 'login' && item.site ? ` (saved for ${item.site})` : '';
      await this.allowOnce(a, item, `Allow ${bot.name} to type your “${item.name}” ${what}${site} into ${where}? ${bot.name} won't see it.`);
    }
    const r = await this.ctx.s.computer.typeSecret({ type: 'type', text: got.value, pid: p.pid, windowId: p.windowId, label: p.label, element: p.element }, a.threadId);
    if (!r.ok) return { ok: false, text: `Couldn't type the ${what}: ${r.text ?? 'it failed'}` };
    return { ok: true, text: `Typed the ${what} of “${item.name}”${got.secret ? ' (hidden from you)' : ''}. Look at the window if you need to check where it went.` };
  }

  /** Put an API key in this bot's keys file, after the user's "Allow" (once per chat), and say where it is. */
  async key(a: AgentContext, id: string): Promise<MethodResult<'agent.vault.key'>> {
    const bot = this.ctx.s.bots.require(a.botId);
    const item = this.require(id, this.scopeOfBot(a));
    if (item.kind !== 'apiKey' || !item.secrets.key) throw new RpcError('invalid_params', `“${item.name}” is not an API key.`);
    await this.allowOnce(a, item, `Allow ${bot.name} to use your “${item.name}” key (${item.envName})? It goes in a private file ${bot.name} reads, not in the chat.`);
    let value: string;
    try { value = this.open(item.secrets.key); } catch (e) { throw new RpcError('unavailable', `Couldn't unlock “${item.name}”: ${errMsg(e)}`); }
    const path = this.keysFile(bot.id);
    const lines = this.readKeysFile(path).filter((l) => !l.startsWith(`${item.envName}=`));
    this.writePrivate(path, [...lines, envLine(item.envName!, value)].join('\n') + '\n');
    return { path, envName: item.envName! };
  }

  /**
   * A bot asks the user to add a Vault item on a card in its chat (`vault_request`): the card's fields are AppuBot's
   * own for the kind, its secrets go straight into this bot's Vault (never to the bot, the chat or a phone that may
   * not save secrets), or the user picks an item of that kind already saved. Either way this chat may then use it.
   */
  async request(a: AgentContext, p: MethodParams<'agent.vault.request'>): Promise<MethodResult<'agent.vault.request'>> {
    const bot = this.ctx.s.bots.require(a.botId);
    const scope = this.scopeOfBot(a);
    const saved = this.read(scope).filter((i) => i.kind === p.kind).map((i) => this.toWire(i));
    const envName = p.kind === 'apiKey' ? (p.envName?.trim().toUpperCase() || undefined) : undefined;
    const form: QuestionForm = {
      kind: 'vault',
      fields: vaultFormFields(p.kind, { name: p.name, site: p.site, username: p.username, envName }),
      vault: { kind: p.kind, ...(p.reason?.trim() ? { reason: p.reason.trim() } : {}), saved: saved.slice(0, 50).map((i) => ({ id: i.id, name: i.name, detail: itemDetail(i) })) },
    };
    let picked = false;
    const question = `${bot.name} needs ${VAULT_FORM_WHAT[p.kind]}: “${p.name.trim()}”`;
    const o = await this.ctx.s.agentBridge.open(a, { question, options: [], form }, p.timeoutSec ?? 900, (sub) => {
      if (sub.savedId) {
        const item = this.require(sub.savedId, scope);
        if (item.kind !== p.kind) throw new RpcError('invalid_params', `“${item.name}” is not ${VAULT_FORM_WHAT[p.kind]}.`);
        this.allow(a.threadId, item.id);
        picked = true;
        return { answer: vaultAnswerText('picked', item.name), savedId: item.id };
      }
      const values = cleanFormValues(form.fields, sub.values);
      const problems = formProblems(form, values);
      const first = Object.keys(problems)[0];
      if (first) throw new RpcError('invalid_params', `${form.fields.find((f) => f.id === first)?.label ?? first}: ${problems[first]}`, { problems });
      const secrets = Object.fromEntries(VAULT_SECRETS[p.kind].map((f) => [f, typeof values[f] === 'string' ? values[f] : undefined]).filter(([, v]) => v));
      // secrets are typed in only on the computer and the owner's own devices (as `vault.save`'s; `checkRole`)
      if (Object.keys(secrets).length && sub.role !== 'owner') {
        throw new RpcError('forbidden', 'Passwords, card numbers and keys can only be added on your computer: fill this card in there, or pick one already saved.');
      }
      const text = (id: string) => (typeof values[id] === 'string' ? (values[id] as string) : undefined);
      const contact = p.kind === 'contact' ? Object.fromEntries(VAULT_CONTACT_FIELDS.map((k) => [k, text(k) ?? ''])) : undefined;
      const item = this.save({
        kind: p.kind, name: text('name') ?? p.name,
        site: text('site'), username: text('username'), cardholder: text('cardholder'), expiry: text('expiry'), envName: text('envName'),
        ...(contact ? { contact: contact as VaultContact } : {}),
        secrets,
      }, scope);
      this.allow(a.threadId, item.id);
      return { answer: vaultAnswerText('saved', item.name), values, savedId: item.id };
    });
    if (!o) return { item: null };
    if (o.declined) return { item: null, declined: true };
    const item = o.savedId ? this.read(scope).find((i) => i.id === o.savedId) : undefined;
    if (!item) return { item: null };
    return { item: this.toWire(item), ...(picked ? { picked: true } : {}) };
  }

  private allow(threadId: string, itemId: string): void {
    let set = this.allowed.get(threadId);
    if (!set) this.allowed.set(threadId, (set = new Set()));
    set.add(itemId);
  }

  private async allowOnce(a: AgentContext, item: StoredItem, question: string): Promise<void> {
    if (this.allowed.get(a.threadId)?.has(item.id)) return;
    const { answer } = await this.ctx.s.agentBridge.ask(a, question, [DONT_ALLOW, ALLOW], 600);
    if (answer?.trim().toLowerCase() !== ALLOW.toLowerCase()) {
      throw new RpcError('forbidden', `${answer === null ? "The user didn't answer" : "The user didn't allow it"}, so “${item.name}” was not used. Don't ask them to type it into the chat.`);
    }
    this.allow(a.threadId, item.id);
  }

  // ---------- storage ----------

  private require(id: string, scope = ''): StoredItem {
    const item = this.read(scope).find((i) => i.id === id);
    if (!item) throw notFound('Vault item', id);
    return item;
  }

  private toWire(i: StoredItem): VaultItem {
    const { secrets, ...rest } = i;
    const saved = (Object.keys(secrets) as VaultSecretField[]).filter((f) => secrets[f]);
    let hint: string | undefined;
    let brand: string | undefined;
    try {
      if (i.kind === 'card' && secrets.number) {
        const n = this.open(secrets.number);
        hint = n.slice(-4);
        brand = cardBrand(n);
      }
      if (i.kind === 'apiKey' && secrets.key) hint = this.open(secrets.key).slice(-4);
    } catch { /* locked: no hint */ }
    return { ...rest, secrets: saved, ...(hint ? { hint } : {}), ...(brand ? { brand } : {}) };
  }

  private seal(plain: string): Sealed {
    const box = this.ctx.deps.secretBox;
    return box ? { v: box.encrypt(plain), enc: true } : { v: plain };
  }

  private open(s: Sealed): string {
    if (!s.enc) return s.v;
    const box = this.ctx.deps.secretBox;
    if (!box) throw new Error('the keychain that sealed it is not available');
    return box.decrypt(s.v);
  }

  /** the Vault file of a login scope: the data folder's, or a team member's own folder's */
  private fileOf(scope: string): string { return scope ? this.ctx.s.logins.fileOf(scope, FILE) : join(this.ctx.paths.dataDir, FILE); }

  private read(scope = ''): StoredItem[] {
    const cached = this.items.get(scope);
    if (cached) return cached;
    let items: StoredItem[];
    try {
      const raw = JSON.parse(readFileSync(this.fileOf(scope), 'utf8')) as { items?: unknown };
      items = Array.isArray(raw.items) ? (raw.items as StoredItem[]) : [];
    } catch {
      items = [];
    }
    this.items.set(scope, items);
    this.sealPlain(scope, items);
    return items;
  }

  /**
   * Secrets kept as typed (saved while this computer had nothing to seal them with: an AppuBot computer before it
   * had a key of its own, a Mac whose keychain wasn't there) are sealed the first time the file is read with a
   * `secretBox`. One that can't be sealed stays as it was: nothing is ever lost to this.
   */
  private sealPlain(scope: string, items: StoredItem[]): void {
    const box = this.ctx.deps.secretBox;
    if (!box) return;
    let sealed = 0;
    const next = items.map((i) => {
      const secrets = { ...i.secrets };
      for (const f of Object.keys(secrets) as VaultSecretField[]) {
        const s = secrets[f];
        if (!s || s.enc) continue;
        try { secrets[f] = { v: box.encrypt(s.v), enc: true }; sealed++; } catch (e) { this.ctx.log.warn('vault: a saved secret could not be sealed', errMsg(e)); }
      }
      return { ...i, secrets };
    });
    if (!sealed) return;
    try {
      this.write(scope, next);
      this.ctx.log.info(`vault: sealed ${sealed} secret${sealed === 1 ? '' : 's'} that had been kept as typed`);
    } catch (e) {
      this.items.set(scope, items);
      this.ctx.log.warn('vault: sealing the saved secrets could not be written', errMsg(e));
    }
  }

  private write(scope: string, items: StoredItem[]): void {
    this.items.set(scope, items);
    // `saveMany` writes once, after its last item
    if (this.holdWrites) return;
    try {
      this.writePrivate(this.fileOf(scope), JSON.stringify({ v: 1, items }, null, 2));
    } catch (e) {
      throw new RpcError('internal', `Could not save the Vault: ${errMsg(e)}`);
    }
  }

  private keysFile(botId: string): string { return join(this.ctx.paths.dataDir, 'vault-keys', `${botId}.env`); }

  private readKeysFile(path: string): string[] {
    try { return readFileSync(path, 'utf8').split('\n').filter((l) => l.trim()); } catch { return []; }
  }

  /** A key taken out of the Vault leaves every bot's keys file too. */
  private dropKeyEverywhere(envName: string): void {
    for (const bot of this.ctx.s.bots.list()) {
      const path = this.keysFile(bot.id);
      const lines = this.readKeysFile(path);
      const kept = lines.filter((l) => !l.startsWith(`${envName}=`));
      if (kept.length !== lines.length) {
        try { this.writePrivate(path, kept.length ? kept.join('\n') + '\n' : ''); } catch (e) { this.ctx.log.warn('vault: could not update a keys file', errMsg(e)); }
      }
    }
  }

  /** Written for this user only (0600), its folder too (0700). */
  private writePrivate(file: string, text: string): void {
    const dir = join(file, '..');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(file, text, { mode: 0o600 });
    chmodSync(file, 0o600);
  }
}
