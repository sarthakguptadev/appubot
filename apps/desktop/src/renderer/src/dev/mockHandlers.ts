/**
 * Dev-only: implementations of every gateway method for the mock gateway.
 * Each handler mutates the in-memory db (replacing arrays) and emits the matching events.
 */
import { appendMemory, cleanFormValues, forgetInMemory, formAnswerText, formProblems, historyPage, memoryTemplate, replaceInMemory, vaultAnswerText, withoutSecrets } from '@appubot/chat-core';
import {
  BotSchema, ProviderSchema, RoutineSchema, SettingsSchema, buildPairUrl, currentChat, messagePreview, newId, slugify,
  type Bot, type Channel, type ComputerStatus, type Device, type FileAttachment, type Group, type GroupMessage, type Message, type MethodName, type MethodParams,
  type ConnectStatus, type MethodResult, type NotificationAccess, type PairingInfo, type Part, type Provider, type Routine, type Skill, type TeachSession, type Thread,
} from '@appubot/protocol';
import { APPUBOT_AI_PROVIDER_ID, VaultContactSchema, currentGroupChat, groupChats, cardBrand, type GitSetup, type MacFilesStatus, type MacLinkStatus, type ModelEndpoint, type VaultItem } from '@appubot/protocol';
import { GatewayError } from '../lib/gateway';
import type { MockGateway } from './MockGateway';
import { GROUP_ID, mockGroupMessages, newThreadFor } from './mockData';
import { HOST_NAME, IDS, LAN_IP, MODES, PORT, TS_DNS, TS_IP } from './mockIds';
import { resumeAfterPermission, simulateReply } from './mockChat';
import { createAppsHandlers } from './mockApps';
import { createVoiceHandlers } from './mockVoice';
import { createCharacterHandlers } from './mockCharacters';
import { createCloudHandlers, createDeviceLoginHandlers } from './mockCloud';
import { mockUsageSummary } from './mockUsage';
import { mockLimits } from './mockLimits';
import { MOCK_FOUND_PROFILES, MOCK_REGISTRY } from './mockRegistry';

/** AppuBot Connect in the mock: up, with an address of its own. */
let mockConnect: ConnectStatus = { state: 'up', connectId: 'yj5mla3axvehyrfiphyv447zuu', connectKey: 'mock-key-not-real-0000000000000000000000000', since: Date.now() - 3600_000 };

export type Handlers = { [M in MethodName]: (p: MethodParams<M>) => MethodResult<M> | Promise<MethodResult<M>> };

const OK = { ok: true } as const;
/** `cloudAccount.cacheGet`/`cacheSet` in the mock, by team ('' = the person's own) */
const mockCloudCopies = new Map<string, { data: string; savedAt: number }>();
/** the Vault (Settings › Vault); `?vault=1` starts with one of each kind */
type MockVaultItem = VaultItem & { secretValues: Record<string, string> };
let mockVault: MockVaultItem[] = typeof location !== 'undefined' && new URLSearchParams(location.search).has('vault') ? [
  { id: 'vlt_gh', kind: 'login', name: 'GitHub', site: 'github.com', username: 'sarthak@example.com', secrets: ['password'], secretValues: { password: 'hunter2' }, createdAt: 1, updatedAt: 1 },
  { id: 'vlt_card', kind: 'card', name: 'Work card', cardholder: 'Sarthak Gupta', expiry: '08/29', secrets: ['number', 'cvc'], hint: '4242', brand: 'Visa', secretValues: { number: '4242424242424242', cvc: '123' }, createdAt: 1, updatedAt: 1 },
  { id: 'vlt_home', kind: 'contact', name: 'Home', contact: { fullName: 'Sarthak Gupta', email: 'sarthak@example.com', phone: '+91 98765 43210', company: '', address1: '12 MG Road', address2: '', city: 'Bengaluru', region: 'Karnataka', postalCode: '560001', country: 'India' }, secrets: [], secretValues: {}, createdAt: 1, updatedAt: 1 },
  { id: 'vlt_oai', kind: 'apiKey', name: 'OpenAI', envName: 'OPENAI_API_KEY', secrets: ['key'], hint: 'x9Qa', secretValues: { key: 'sk-test-x9Qa' }, createdAt: 1, updatedAt: 1 },
] : [];
/** custom model endpoints (Settings › Agents › Add custom); `?endpoints=1` starts with an Ollama one */
let mockEndpoints: ModelEndpoint[] = typeof location !== 'undefined' && new URLSearchParams(location.search).has('endpoints')
  ? [{ id: 'ep_ollama', kind: 'ollama', name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', models: ['gemma3:12b', 'qwen3-coder:30b'], keySaved: false, providerKey: 'ollama', createdAt: Date.now() }]
  : [];
const MOCK_STORAGE = {
  items: [
    { id: 'files' as const, bytes: 486_000_000, count: 312, path: '/Users/you/Library/Application Support/AppuBot/files' },
    { id: 'logs' as const, bytes: 12_400_000, count: 14, path: '/Users/you/Library/Logs/AppuBot' },
    { id: 'voice' as const, bytes: 1_020_000_000, path: '/Users/you/Library/Application Support/AppuBot/voice-models' },
    { id: 'agents' as const, bytes: 214_000_000, path: '/Users/you/Library/Application Support/AppuBot/agents' },
  ],
};
const notFound = (what: string): GatewayError => new GatewayError('not_found', `${what} not found`);

/** teach mode records everywhere but a browser preview of Linux (`?platform=linux`), which shows the Wayland fallback */
const mockTeachRecords = (): boolean => typeof window === 'undefined' || new URLSearchParams(window.location.search).get('platform') !== 'linux';
const MOCK_NO_RECORDING = 'Recording needs an X11 (Xorg) session: on Wayland, AppuBot can\'t see clicks and keys in other apps.';

export function createHandlers(g: MockGateway): Handlers {
  let registry = MOCK_REGISTRY.map((a) => ({ ...a }));
  let teach: TeachSession | null = null;
  let teachTimer: ReturnType<typeof setInterval> | null = null;
  let pairingTimer: ReturnType<typeof setTimeout> | null = null;

  const bot = (id: string): Bot => {
    const b = g.db.bots.find((x) => x.id === id);
    if (!b) throw notFound('Bot');
    return b;
  };
  const putBot = (b: Bot): Bot => { g.db.bots = g.db.bots.some((x) => x.id === b.id) ? g.db.bots.map((x) => (x.id === b.id ? b : x)) : [...g.db.bots, b]; g.emit('bot.updated', b); return b; };
  const putProvider = (p: Provider): Provider => { g.db.providers = g.db.providers.some((x) => x.id === p.id) ? g.db.providers.map((x) => (x.id === p.id ? p : x)) : [...g.db.providers, p]; g.emit('provider.updated', p); return p; };
  const groupMessages: Record<string, GroupMessage[]> = g.opts.groups ? { [GROUP_ID]: mockGroupMessages(g.opts.groupsFilm) } : {};
  const putGroup = (grp: Group): Group => { g.db.groups = (g.db.groups ?? []).some((x) => x.id === grp.id) ? (g.db.groups ?? []).map((x) => (x.id === grp.id ? grp : x)) : [...(g.db.groups ?? []), grp]; g.emit('group.updated', grp); return grp; };
  const putRoutine = (r: Routine): Routine => { g.db.routines = g.db.routines.some((x) => x.id === r.id) ? g.db.routines.map((x) => (x.id === r.id ? r : x)) : [...g.db.routines, r]; g.emit('routine.updated', r); return r; };
  const putDevice = (d: Device): Device => { g.db.devices = g.db.devices.some((x) => x.id === d.id) ? g.db.devices.map((x) => (x.id === d.id ? d : x)) : [...g.db.devices, d]; g.emit('device.updated', d); return d; };
  const putSkill = (k: Skill): Skill => {
    const same = (x: Skill): boolean => x.name === k.name && x.botId === k.botId;
    g.db.skills = g.db.skills.some(same) ? g.db.skills.map((x) => (same(x) ? k : x)) : [...g.db.skills, k];
    g.emit('skill.updated', k);
    return k;
  };
  const putComputer = (patch: Partial<ComputerStatus>): ComputerStatus => { g.db.computer = { ...g.db.computer, ...patch }; g.emit('computer.status', g.db.computer); return g.db.computer; };
  const putTeach = (t: TeachSession): TeachSession => { teach = t; g.emit('teach.updated', t); return t; };
  const addFile = (path: string, caption?: string): FileAttachment => {
    const id = newId('f');
    const name = path.split('/').pop() || 'file';
    const ext = name.split('.').pop()?.toLowerCase() ?? '';
    const mime: Record<string, string> = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', csv: 'text/csv', md: 'text/markdown', txt: 'text/plain' };
    const f: FileAttachment = { id, name, mimeType: mime[ext] ?? 'application/octet-stream', size: 10_000 + Math.round(Math.random() * 90_000), url: `/files/${id}`, path, caption };
    g.files = [f, ...g.files];
    g.emit('file.created', f);
    return f;
  };
  const saveSkill = (botId: string, name: string, description: string, body: string, source?: Skill['source']): Skill => {
    const b = bot(botId);
    const slug = slugify(name);
    const prev = g.db.skills.find((x) => x.name === slug && x.botId === botId);
    return putSkill({ name: slug, description, body, botId, source: source ?? prev?.source ?? 'user', path: `${b.workspace}/.claude/skills/${slug}/SKILL.md`, updatedAt: Date.now() });
  };
  const userMessage = (threadId: string, text: string, images: { mimeType: string; data: string }[], via: Message['via'] = 'desktop', extra: Part[] = []): Message => {
    const now = Date.now();
    const parts: Part[] = [{ type: 'text', text }, ...extra, ...images.map((i): Part => ({ type: 'image', mimeType: i.mimeType, data: i.data }))];
    return { id: newId('msg'), threadId, role: 'user', parts, status: 'complete', via, createdAt: now, updatedAt: now };
  };
  const newThread = (botId: string): Thread => {
    const t = newThreadFor(bot(botId), newId('th'), 'New thread', { lastActiveAt: Date.now() });
    g.db.threads = [...g.db.threads, t];
    g.messages[t.id] = [];
    g.emit('thread.updated', t);
    return t;
  };
  /** Where turns that name no thread go (the gateway's `threads.chatFor`): the bot's current thread, made on first use. */
  const chatFor = (botId: string): Thread => currentChat(g.db.threads, botId) ?? newThread(botId);
  const today = (): string => new Date().toISOString().slice(0, 10);
  /** the agent-only memory tools act as Appu */
  const memPath = (): string => `${bot(IDS.appu).workspace}/MEMORY.md`;
  const appuMemory = (): string => g.memory[IDS.appu] ?? memoryTemplate(bot(IDS.appu).name);
  const startRun = (threadId: string, text: string, via: Message['via'], images: { mimeType: string; data: string }[] = [], extra: Part[] = []): { userMessage: Message; agentMessageId: string } => {
    g.thread(threadId);
    const um = userMessage(threadId, text, images, via, extra);
    g.addMessage(um);
    g.patchThread(threadId, { status: 'running', lastMessagePreview: messagePreview(um) });
    const agentMessageId = newId('msg');
    simulateReply(g, threadId, agentMessageId, text);
    return { userMessage: um, agentMessageId };
  };
  const stopTeachTimer = (): void => { if (teachTimer) clearInterval(teachTimer); teachTimer = null; };
  /** writes the skill a little later, like the bot would */
  const learnTeach = (cur: TeachSession): TeachSession => {
    const summarizing = putTeach({ ...cur, status: 'summarizing' });
    g.later(() => {
      const skill = saveSkill(cur.botId, cur.name, cur.goal || `Taught workflow: ${cur.name}`,
        `# ${cur.name}\n\n${cur.goal ? `Goal: ${cur.goal}\n\n` : ''}${Array.from({ length: Math.max(3, cur.stepCount) }, (_, i) => `${i + 1}. Recorded step ${i + 1}`).join('\n')}\n`, 'taught');
      putTeach({ ...summarizing, status: 'done', endedAt: Date.now(), skillName: skill.name });
    }, 2500);
    return summarizing;
  };

  return {
    /* ---------- the window's saved copies of cloud computers (in memory here; the Mac keeps them sealed on disk) ---------- */
    'cloudAccount.cacheGet': (p) => mockCloudCopies.get(p.team ?? '') ?? null,
    'cloudAccount.cacheSet': (p) => {
      if (p.data) mockCloudCopies.set(p.team ?? '', { data: p.data, savedAt: Date.now() }); else mockCloudCopies.delete(p.team ?? '');
      return OK;
    },
    // the mock has no gateway to frame a kept page from: its cloud pages show their "can't be shown" line
    'cloudAccount.pageGet': () => null,
    'cloudAccount.pageSet': () => { throw new Error('Pages aren’t kept in the mock.'); },

    /* ---------- bots ---------- */
    'bots.list': () => g.db.bots,
    'bots.create': (p) => {
      const now = Date.now();
      const slug = slugify(p.name);
      const b = BotSchema.parse({ ...p, fast: p.fast ?? g.db.settings.defaultFast, id: newId('bot'), slug, workspace: `/Users/sarthak/AppuBot/${slug}`, createdAt: now, updatedAt: now });
      g.memory[b.id] = memoryTemplate(b.name);
      return putBot(b);
    },
    'bots.update': (p) => {
      const next = BotSchema.parse({ ...bot(p.id), ...p.patch, id: p.id, updatedAt: Date.now() });
      // '' takes a character off
      if (!next.characterId) delete next.characterId;
      return putBot(next);
    },
    'bots.delete': (p) => {
      bot(p.id);
      g.db.bots = g.db.bots.filter((b) => b.id !== p.id);
      g.db.threads = g.db.threads.filter((t) => t.botId !== p.id);
      g.db.skills = g.db.skills.filter((k) => k.botId !== p.id);
      g.db.routines = g.db.routines.filter((r) => r.botId !== p.id);
      g.emit('bot.deleted', { id: p.id });
      return OK;
    },
    'bots.memory.get': (p) => ({ memory: g.memory[p.id] ?? '', path: `${bot(p.id).workspace}/MEMORY.md` }),
    'bots.memory.set': (p) => { const b = bot(p.id); g.memory[p.id] = p.memory.trim() ? p.memory : memoryTemplate(b.name); return OK; },
    'bots.history': (p) => {
      bot(p.id);
      const lists = g.db.threads.filter((t) => t.botId === p.id && t.source !== 'channel').map((t) => g.threadMessages(t.id));
      const page = historyPage(lists.flat(), { before: p.before, limit: p.limit ?? 100, since: p.since, max: 1000 });
      return structuredClone(page);
    },

    /* ---------- threads ---------- */
    'threads.list': (p) => g.db.threads.filter((t) => !p?.botId || t.botId === p.botId).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, p?.limit ?? 100),
    'threads.create': (p) => chatFor(p.botId),
    'threads.start': (p) => {
      const cur = currentChat(g.db.threads, p.botId);
      // an empty current thread is reused
      if (cur && !g.threadMessages(cur.id).length) return g.patchThread(cur.id, { lastActiveAt: Date.now() });
      return newThread(p.botId);
    },
    'threads.history': (p) => {
      g.thread(p.id);
      return structuredClone(historyPage(g.threadMessages(p.id), { before: p.before, limit: p.limit ?? 100 }));
    },
    'threads.get': (p) => ({ thread: g.thread(p.id), messages: structuredClone(g.threadMessages(p.id)) }),
    'threads.commands': (p) => ({ commands: g.db.threads.find((t) => t.id === p.id)?.commands ?? [] }),
    'threads.messages': (p) => {
      g.thread(p.id);
      const list = g.threadMessages(p.id).filter((m) => p.before === undefined || m.createdAt < p.before);
      return structuredClone(list.slice(-(p.limit ?? 200)));
    },
    'threads.rename': (p) => g.patchThread(p.id, { title: p.title }),
    'threads.delete': (p) => {
      g.thread(p.id);
      g.runs.drop(p.id);
      g.db.threads = g.db.threads.filter((t) => t.id !== p.id);
      g.db.pendingPermissions = g.db.pendingPermissions.filter((x) => x.threadId !== p.id);
      delete g.messages[p.id];
      g.emit('thread.deleted', { id: p.id });
      return OK;
    },
    'threads.setMode': (p) => g.patchThread(p.id, { modeId: p.modeId }),
    'threads.setModel': (p) => g.patchThread(p.id, { modelId: p.modelId }),
    'threads.setEffort': (p) => g.patchThread(p.id, { effortId: p.effortId }),
    // a thread's goal (?goal=active|paused|done|blocked seeds one on the first chat)
    'threads.goal': (p) => {
      const cur = g.db.threads.find((x) => x.id === p.id);
      if (!cur?.goal) throw notFound('Goal');
      const now = Date.now();
      const goal = p.action === 'clear' ? undefined
        : { ...cur.goal, status: p.action === 'pause' ? 'paused' as const : p.action === 'stop' ? 'stopped' as const : 'active' as const, note: p.action === 'pause' ? 'Paused by you' : undefined, updatedAt: now };
      return g.patchThread(p.id, { goal });
    },
    'threads.setFast': (p) => {
      const t = g.patchThread(p.id, { fast: p.fast });
      putBot(BotSchema.parse({ ...bot(t.botId), fast: p.fast, updatedAt: Date.now() }));
      return t;
    },
    'threads.warm': (p) => {
      if (p.threadId) g.thread(p.threadId); else chatFor(p.botId);
      return OK;
    },

    /* ---------- chat ---------- */
    'chat.send': (p) => {
      // a named thread continues (and becomes the bot's current one); else the current thread takes it
      const named = p.threadId ? g.thread(p.threadId) : undefined;
      const t = named ?? chatFor(p.botId ?? '');
      if (t.source !== 'channel') g.patchThread(t.id, { lastActiveAt: Date.now() });
      // a spoken message keeps its recording (voice mode)
      const rec = p.voice ? g.files.find((f) => f.id === p.voice!.recordingId) : undefined;
      if (p.voice && !rec) throw notFound('File');
      const voice: Part[] = rec ? [{ type: 'voice', file: rec, durationMs: p.voice!.durationMs, kind: 'recording', transcript: p.text }] : [];
      return startRun(t.id, p.text, 'desktop', p.images ?? [], voice);
    },
    'chat.cancel': (p) => {
      g.thread(p.threadId);
      if (!g.runs.cancel(p.threadId)) g.patchThread(p.threadId, { status: 'idle' });
      return OK;
    },
    'chat.answer': (p) => {
      for (const [threadId, list] of Object.entries(g.messages)) {
        for (const m of list) {
          const idx = m.parts.findIndex((x) => x.type === 'question' && x.questionId === p.questionId);
          const part = m.parts[idx];
          if (part && part.type === 'question') {
            g.setMessagePart(threadId, m.id, idx, { ...part, answer: p.answer });
            return OK;
          }
        }
      }
      throw notFound('Question');
    },
    'chat.answerForm': (p) => {
      for (const [threadId, list] of Object.entries(g.messages)) {
        for (const m of list) {
          const idx = m.parts.findIndex((x) => x.type === 'question' && x.questionId === p.questionId);
          const part = m.parts[idx];
          if (!part || part.type !== 'question' || !part.form) continue;
          const form = part.form;
          if (p.decline) { g.setMessagePart(threadId, m.id, idx, { ...part, answer: 'Declined', declined: true }); return OK; }
          if (p.savedId) { g.setMessagePart(threadId, m.id, idx, { ...part, answer: vaultAnswerText('picked', form.vault?.saved.find((x) => x.id === p.savedId)?.name ?? 'it'), savedId: p.savedId }); return OK; }
          const values = cleanFormValues(form.fields, p.values ?? {});
          const problems = formProblems(form, values);
          if (Object.keys(problems).length) throw new GatewayError('invalid_params', Object.values(problems)[0]!, { problems });
          const answer = form.kind === 'vault' ? vaultAnswerText('saved', String(values.name ?? 'it')) : formAnswerText(form.fields, values);
          g.setMessagePart(threadId, m.id, idx, { ...part, answer, values: withoutSecrets(form.fields, values), ...(form.kind === 'vault' ? { savedId: 'vlt_mock_new' } : {}) });
          return OK;
        }
      }
      throw notFound('Question');
    },

    /* ---------- permissions ---------- */
    'permissions.list': () => g.db.pendingPermissions,
    'permissions.respond': (p) => {
      const perm = g.db.pendingPermissions.find((x) => x.id === p.id);
      if (!perm) throw notFound('Permission request');
      const option = perm.options.find((o) => o.optionId === p.optionId);
      if (!option) throw new GatewayError('bad_request', `Unknown option ${p.optionId}`);
      g.db.pendingPermissions = g.db.pendingPermissions.filter((x) => x.id !== p.id);
      g.emit('permission.resolved', { id: p.id, optionId: p.optionId, by: 'desktop' });
      g.patchThread(perm.threadId, { status: 'running' });
      resumeAfterPermission(g, perm, option.kind === 'allow_once' || option.kind === 'allow_always');
      return OK;
    },

    /* ---------- providers ---------- */
    'providers.list': () => g.db.providers,
    'providers.choices': (p) => (p.id === 'codex' ? { models: [{ id: 'gpt-5.5', name: 'GPT-5.5' }, { id: 'gpt-5.5-mini', name: 'GPT-5.5 mini' }], efforts: [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }], modes: [] } : { models: [], efforts: [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }], modes: MODES }),
    'providers.refresh': () => {
      const now = Date.now();
      g.db.providers = g.db.providers.map((p) => (p.auth ? { ...p, auth: { ...p.auth, checkedAt: now } } : p));
      g.emit('providers.updated', g.db.providers);
      return g.db.providers;
    },
    'providers.upsert': (p) => {
      const prev = g.db.providers.find((x) => x.id === p.id);
      return putProvider(ProviderSchema.parse({ ...prev, ...p, installed: prev?.installed ?? true, authStatus: prev?.authStatus ?? 'unknown' }));
    },
    'endpoints.list': () => mockEndpoints,
    'endpoints.probe': (p) => {
      const base = p.baseUrl.replace(/\/+$/, '');
      const baseUrl = /\/v1$/.test(base) ? base : `${base}/v1`;
      return base.includes('11434')
        ? { ok: true, models: ['gemma3:12b', 'llama3.2:3b', 'qwen3-coder:30b'], baseUrl }
        : base.includes('1234')
          ? { ok: true, models: ['openai/gpt-oss-20b', 'qwen/qwen3-coder-30b'], baseUrl }
          : { ok: false, models: [], baseUrl, error: 'Nothing answers at that address. Is the server running?' };
    },
    'endpoints.save': (p) => {
      const prev = mockEndpoints.find((e) => e.id === p.id);
      const e = {
        id: prev?.id ?? `ep_${Date.now().toString(36)}`, kind: p.kind, name: p.name, baseUrl: p.baseUrl, models: p.models,
        keySaved: p.apiKey === undefined ? !!prev?.keySaved : !!p.apiKey, providerKey: prev?.providerKey ?? (p.kind === 'openai' ? p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') : p.kind),
        createdAt: prev?.createdAt ?? Date.now(),
      };
      mockEndpoints = prev ? mockEndpoints.map((x) => (x.id === e.id ? e : x)) : [...mockEndpoints, e];
      return e;
    },
    'endpoints.delete': (p) => {
      mockEndpoints = mockEndpoints.filter((e) => e.id !== p.id);
      return OK;
    },
    'providers.delete': (p) => {
      g.db.providers = g.db.providers.filter((x) => x.id !== p.id);
      g.emit('providers.updated', g.db.providers);
      return OK;
    },
    'providers.install': (p) => {
      const prev = g.db.providers.find((x) => x.id === p.id);
      if (!prev) throw notFound('Provider');
      g.later(() => putProvider({ ...prev, installed: true, authStatus: 'needs_auth', version: prev.version ?? '0.18.4', lastError: undefined, auth: { state: 'logged_out', checkedAt: Date.now() } }), 1200);
      return { ok: true, output: `$ ${prev.installHint ?? `install ${prev.command}`}\n\nadded 1 package in 3.1s\n${prev.command} is ready.` };
    },
    'providers.authenticate': (p) => {
      const prev = g.db.providers.find((x) => x.id === p.id);
      if (!prev) throw notFound('Provider');
      g.later(() => putProvider({ ...prev, authStatus: 'authenticated', lastError: undefined, auth: { state: 'logged_in', account: 's***@example.com', checkedAt: Date.now() } }), 900);
      return { ok: true, message: `Signed in to ${prev.name}.` };
    },
    'providers.setKeys': (p) => {
      const prev = g.db.providers.find((x) => x.id === p.id);
      if (!prev) throw notFound('Provider');
      g.later(() => putProvider({ ...prev, authStatus: 'authenticated', lastError: undefined, keysSaved: Object.keys(p.values) }), 600);
      return { ok: true, message: `${prev.name} is signed in with your key.` };
    },
    'providers.clearKeys': (p) => {
      const prev = g.db.providers.find((x) => x.id === p.id);
      if (!prev) throw notFound('Provider');
      putProvider({ ...prev, keysSaved: [] });
      return { ok: true };
    },
    'providers.profiles': () => ({
      found: MOCK_FOUND_PROFILES.filter((f) => !g.db.providers.some((p) => p.profile?.home === f.home)),
    }),
    'providers.addProfile': (p) => {
      const base = g.db.providers.find((x) => x.id === p.of);
      if (!base) throw notFound('Provider');
      const slug = p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'profile';
      const home = p.home ?? `/Users/sarthak/Library/Application Support/AppuBot/profiles/${p.of}/${slug}`;
      const found = MOCK_FOUND_PROFILES.find((f) => f.home === home);
      return putProvider(ProviderSchema.parse({
        ...base, id: `${p.of}@${slug}`, name: `${base.name} · ${p.name.trim()}`, builtin: false, enabled: true,
        profile: { of: p.of, name: p.name.trim(), home, source: found?.source ?? 'appubot' },
        ...(found
          ? { authStatus: 'authenticated', auth: { state: 'logged_in', account: 's***@appgrowthkit.com', plan: 'Team', checkedAt: Date.now() } }
          : { authStatus: 'needs_auth', auth: { state: 'logged_out', checkedAt: Date.now() } }),
        latestVersion: undefined, updateAvailable: undefined, update: undefined,
      }));
    },
    'providers.renameProfile': (p) => {
      const prev = g.db.providers.find((x) => x.id === p.id);
      if (prev?.builtin) return putProvider({ ...prev, profileName: p.name.trim() });
      if (!prev?.profile) throw notFound('Profile');
      const base = g.db.providers.find((x) => x.id === prev.profile!.of);
      return putProvider({ ...prev, name: `${base?.name ?? prev.profile.of} · ${p.name.trim()}`, profile: { ...prev.profile, name: p.name.trim() } });
    },
    'providers.registry': () => ({ agents: registry.map((a) => ({ ...a, ...(g.db.providers.some((x) => x.id === a.providerId) ? {} : { providerId: undefined, installedVersion: undefined }) })), fetchedAt: Date.now() }),
    'providers.addFromRegistry': async (p) => {
      const a = registry.find((x) => x.id === p.id);
      if (!a) throw notFound('Registry agent');
      await new Promise((r) => setTimeout(r, 900));
      const prev = g.db.providers.find((x) => x.id === a.id);
      registry = registry.map((x) => (x.id === a.id ? { ...x, providerId: a.id, installedVersion: a.version } : x));
      return putProvider(ProviderSchema.parse({
        ...prev, id: a.id, name: a.name, description: a.description, enabled: prev?.enabled ?? true, installed: true, authStatus: prev?.authStatus ?? 'needs_auth',
        command: a.install === 'binary' ? `~/Library/Application Support/AppuBot/agents/${a.id}/${a.version}/${a.id}` : a.install, args: [], env: {},
        authMethods: [{ id: 'oauth', name: 'Sign in', kind: 'agent' }], registry: { id: a.id, version: a.version }, iconSvg: a.iconSvg, version: a.version,
      }));
    },
    'providers.checkUpdates': async () => {
      await new Promise((r) => setTimeout(r, 700));
      const now = Date.now();
      g.db.providers = g.db.providers.map((p) => (p.update ? { ...p, update: { ...p.update, checkedAt: now } } : p));
      g.emit('providers.updated', g.db.providers);
      return g.db.providers;
    },
    'providers.update': async (p) => {
      const prev = g.db.providers.find((x) => x.id === p.id);
      if (!prev) throw notFound('Provider');
      if (!prev.update) throw new GatewayError('invalid_params', `AppuBot can't update ${prev.name}.`);
      if (!prev.registry && !prev.update.via) return { ok: false, output: '', message: `AppuBot can't tell how ${prev.name} was installed. Update it the way you installed it, then check again.` };
      putProvider({ ...prev, update: { ...prev.update, running: true } });
      await new Promise((r) => setTimeout(r, 2200));
      const to = prev.latestVersion ?? prev.update.current;
      if (prev.registry && to) registry = registry.map((x) => (x.id === prev.registry!.id ? { ...x, installedVersion: to } : x));
      putProvider({
        ...prev, updateAvailable: false,
        ...(prev.registry && to ? { registry: { ...prev.registry, version: to }, version: to } : {}),
        update: { ...prev.update, ...(to ? { current: to } : {}), running: false, checkedAt: Date.now() },
      });
      return { ok: true, output: `$ ${prev.update.via}\nUpdated to ${to}`, message: `${prev.name} updated from ${prev.update.current} to ${to}.` };
    },
    'providers.logout': (p) => {
      const prev = g.db.providers.find((x) => x.id === p.id);
      if (!prev) throw notFound('Provider');
      if (!prev.canLogOut) return { ok: false, message: `${prev.name} can't be logged out from AppuBot.` };
      g.later(() => putProvider({ ...prev, authStatus: 'needs_auth', auth: { state: 'logged_out', checkedAt: Date.now() } }), 500);
      return { ok: true };
    },

    /* ---------- computer ---------- */
    'computer.status': () => g.db.computer,
    'computer.screenshot': () => {
      const frame = g.makeFrame(Math.floor(Math.random() * 5));
      g.emit('computer.frame', frame);
      return frame;
    },
    'computer.act': (p) => {
      const ts = Date.now();
      const frame = g.makeFrame(1 + Math.floor(Math.random() * 4), { threadId: p.threadId, action: p.action, ts });
      const summary = p.action.type === 'click' ? `Clicked at ${p.action.x ?? 0}, ${p.action.y ?? 0}` : `Performed ${p.action.type.replace('_', ' ')}`;
      g.emit('computer.action', { threadId: p.threadId, action: p.action, ts, ok: true, summary });
      g.emit('computer.frame', frame);
      return { ok: true, frame, text: summary };
    },
    'computer.batch': (p) => {
      const ts = Date.now();
      for (const action of p.steps) g.emit('computer.action', { threadId: p.threadId, action, ts, ok: true, summary: `Performed ${action.type.replace('_', ' ')}` });
      const frame = p.look === 'none' ? undefined : g.makeFrame(1 + Math.floor(Math.random() * 4), { threadId: p.threadId, ts });
      if (frame) g.emit('computer.frame', frame);
      return { ok: true, done: p.steps.length, frame, text: `Did all ${p.steps.length} steps.` };
    },
    'computer.pause': () => putComputer({ paused: true, busy: false }),
    'computer.resume': () => putComputer({ paused: false }),
    'computer.setLiveView': (p) => putComputer({ liveView: p.enabled }),
    // live view is a phone's: the mock has nothing to stream
    'computer.watch': () => ({ ok: true as const, live: false }),
    'computer.liveAck': () => ({ ok: true as const }),
    'computer.liveKey': () => ({ ok: true as const }),
    'computer.control': (p) => ({ ok: true as const, control: p.on ? { id: 'ctl_mock', name: 'This Mac', via: 'live' as const, since: Date.now(), expiresAt: Date.now() + 120_000, left: 120_000 } : null, mine: p.on }),
    'computer.liveInput': () => ({ ok: true as const }),
    'computer.requestPermissions': () => putComputer({ permissions: { accessibility: true, screenRecording: true, inputMonitoring: true }, available: true }),
    'computer.openSettings': () => OK,

    /* ---------- skills & teach ---------- */
    'skills.list': (p) => g.db.skills.filter((k) => !p?.botId || k.botId === p.botId),
    'skills.get': (p) => {
      const k = g.db.skills.find((x) => x.botId === p.botId && x.name === p.name);
      if (!k) throw notFound('Skill');
      return k;
    },
    'skills.save': (p) => saveSkill(p.botId, p.name, p.description ?? '', p.body),
    'skills.delete': (p) => {
      g.db.skills = g.db.skills.filter((k) => !(k.botId === p.botId && k.name === p.name));
      g.emit('skill.deleted', { botId: p.botId, name: p.name });
      return OK;
    },
    'teach.start': (p) => {
      bot(p.botId);
      if (teach?.status === 'recording') throw new GatewayError('busy', 'Already recording a lesson');
      stopTeachTimer();
      const fresh: TeachSession = { id: newId('teach'), botId: p.botId, name: p.name, goal: p.goal ?? '', status: 'recording', startedAt: Date.now(), stepCount: 0 };
      // nothing records (teach.support): straight to writing the skill from the description, like the core's manual mode
      if (!mockTeachRecords()) return learnTeach(fresh);
      const t = putTeach(fresh);
      teachTimer = setInterval(() => {
        if (teach && teach.id === t.id && teach.status === 'recording') putTeach({ ...teach, stepCount: teach.stepCount + 1 });
        else stopTeachTimer();
      }, 2000);
      return t;
    },
    'teach.stop': (p) => {
      if (!teach || teach.id !== p.id) throw notFound('Teach session');
      stopTeachTimer();
      const cur = teach;
      if (p.cancel) return putTeach({ ...cur, status: 'cancelled', endedAt: Date.now() });
      return learnTeach(cur);
    },
    'teach.status': () => teach,
    // a browser preview of Linux (?platform=linux) shows the Wayland fallback
    'teach.support': () => (mockTeachRecords() ? { recording: true } : { recording: false, reason: MOCK_NO_RECORDING }),
    'teach.input': () => ({ ok: true as const }),
    'bots.export': (p) => {
      const bot = g.db.bots.find((b) => b.id === p.id);
      if (!bot) throw notFound('Bot');
      return {
        // something the window can really fetch (its own page: the CSP allows nothing else here), so a mock transfer runs to its end
        file: { id: `file_export_${bot.id}`, name: `${bot.slug}.appubot-bot.zip`, mimeType: 'application/zip', size: 123_456, url: typeof location !== 'undefined' ? new URL('index.html', location.href).href : `/files/file_export_${bot.id}` },
        manifest: { version: 1 as const, exportedAt: Date.now(), from: { hostName: 'Mock', platform: 'darwin', cloud: false }, bot: { name: bot.name, job: bot.job, color: bot.color, shape: bot.shape, providerId: bot.providerId, effort: bot.effort, computerUse: bot.computerUse }, counts: { threads: 3, messages: 42, routines: 1, skills: 2, files: 4, workspaceFiles: 9, bytes: 123_456 }, apps: [] },
        included: { memory: p.include?.memory !== false, skills: p.include?.skills !== false, files: p.include?.files !== false, routines: p.include?.routines !== false, chats: p.include?.chats !== false, sharedSkills: p.sharedSkills ?? [] },
      };
    },
    // Settings › Transfer: what this (mock) Mac could carry over
    'bots.exportable': () => ({
      hostName: 'Sarthak’s MacBook Pro',
      bots: g.db.bots.map((bot, i) => ({
        bot,
        memory: { bytes: 1_200 + i * 800 },
        skills: { names: g.db.skills.filter((k) => k.botId === bot.id).map((k) => k.name), bytes: 4_096 },
        files: { count: i * 3, bytes: i * 2_400_000 },
        routines: { count: g.db.routines.filter((r) => r.botId === bot.id).length },
        // the second bot is too big to send whole to a computer from before (300 MB): its row says what stays behind
        chats: { threads: 2 + i, messages: 40 + i * 25, bytes: i === 1 ? 312_000_000 : 380_000 + i * 9_500_000 },
      })),
      sharedSkills: [
        { name: 'tidy-desk', description: 'Tidies the desktop into folders', from: 'claude' as const, files: 2, bytes: 3_100 },
        { name: 'write-mail', description: 'Writes short, kind emails', from: 'agents' as const, files: 1, bytes: 900 },
      ],
    }),
    'skills.getShared': (p) => ({ name: p.name, description: p.name, body: 'Do it neatly.', files: 1 }),
    'bots.import': () => {
      const bot = g.db.bots[0]!;
      return { bot, manifest: { version: 1 as const, exportedAt: Date.now(), from: { hostName: 'Mock', platform: 'darwin', cloud: false }, bot: { name: bot.name, job: bot.job, color: bot.color, shape: bot.shape, providerId: bot.providerId, effort: bot.effort, computerUse: bot.computerUse }, counts: { threads: 3, messages: 42, routines: 1, skills: 2, files: 4, workspaceFiles: 9, bytes: 123_456 }, apps: [] }, notes: ['Sign in to Claude Code on this computer: the bot used it there.'], counts: { threads: 3, messages: 42, routines: 1, skills: 2, files: 4 } };
    },

    /* ---------- routines ---------- */
    'routines.list': () => g.db.routines,

    // groups of bots (?groups=1 seeds one): a sent message gets a canned reply from the lead a moment later
    'groups.list': () => g.db.groups ?? [],
    'groups.history': (p) => { const grp = (g.db.groups ?? []).find((x) => x.id === p.id); const key = p.chatId ?? (grp ? currentGroupChat(grp).id : p.id); return { messages: groupMessages[key] ?? [], hasMore: false }; },
    'groups.goal': (p) => {
      const grp = (g.db.groups ?? []).find((x) => x.id === p.id);
      if (!grp) throw notFound('Group');
      const cid = p.chatId ?? currentGroupChat(grp).id;
      const chats = groupChats(grp).map((c) => {
        if (c.id !== cid || !c.goal) return c;
        if (p.action === 'clear') { const { goal: _, ...rest } = c; return rest; }
        return { ...c, goal: { ...c.goal, status: p.action === 'pause' ? 'paused' as const : p.action === 'stop' ? 'stopped' as const : 'active' as const, updatedAt: Date.now() } };
      });
      return putGroup({ ...grp, chats });
    },
    'groups.newChat': (p) => {
      const grp = (g.db.groups ?? []).find((x) => x.id === p.id);
      if (!grp) throw notFound('Group');
      if (!(groupMessages[currentGroupChat(grp).id] ?? []).length) return grp;
      const now = Date.now();
      const chat = { id: newId('gc'), title: '', lastMessagePreview: '', createdAt: now, lastActiveAt: now };
      return putGroup({ ...grp, chats: [...groupChats(grp), chat], currentChatId: chat.id, lastMessagePreview: '', lastActiveAt: now, updatedAt: now });
    },
    'groups.useChat': (p) => {
      const grp = (g.db.groups ?? []).find((x) => x.id === p.id);
      if (!grp) throw notFound('Group');
      return putGroup({ ...grp, chats: groupChats(grp), currentChatId: p.chatId });
    },
    'groups.create': (p) => {
      const now = Date.now();
      const grp: Group = { id: newId('grp'), name: p.name, botIds: p.botIds, ...(p.leadId ? { leadId: p.leadId } : {}), lastMessagePreview: '', working: [], workingIn: {}, chats: [], createdAt: now, updatedAt: now };
      return putGroup(grp);
    },
    'groups.update': (p) => {
      const prev = (g.db.groups ?? []).find((x) => x.id === p.id);
      if (!prev) throw notFound('Group');
      const next: Group = { ...prev, ...(p.patch.name !== undefined ? { name: p.patch.name } : {}), ...(p.patch.botIds ? { botIds: p.patch.botIds } : {}), updatedAt: Date.now() };
      if (p.patch.leadId !== undefined) { if (p.patch.leadId) next.leadId = p.patch.leadId; else delete next.leadId; }
      if (p.patch.pinned !== undefined) { if (p.patch.pinned) next.pinned = true; else delete next.pinned; }
      if (p.patch.providerId === '') { delete next.providerId; delete next.modelId; delete next.effort; }
      else if (p.patch.providerId !== undefined) { if (p.patch.providerId !== prev.providerId) { delete next.modelId; delete next.effort; } next.providerId = p.patch.providerId; }
      if (p.patch.modelId !== undefined) { if (p.patch.modelId) next.modelId = p.patch.modelId; else delete next.modelId; }
      if (p.patch.effort !== undefined) { if (p.patch.effort) next.effort = p.patch.effort; else delete next.effort; }
      return putGroup(next);
    },
    'groups.delete': (p) => {
      g.db.groups = (g.db.groups ?? []).filter((x) => x.id !== p.id);
      delete groupMessages[p.id];
      g.emit('group.removed', { id: p.id });
      return OK;
    },
    'groups.send': (p) => {
      const grp = (g.db.groups ?? []).find((x) => x.id === p.id);
      if (!grp) throw notFound('Group');
      const now = Date.now();
      const chatId = p.chatId ?? currentGroupChat(grp).id;
      const at = chatId !== grp.id ? { chatId } : {};
      const msg: GroupMessage = { id: newId('gm'), groupId: grp.id, ...at, from: { kind: 'user' }, text: p.text, mentions: [], hop: 0, ...(p.clientId ? { clientId: p.clientId } : {}), createdAt: now };
      groupMessages[chatId] = [...(groupMessages[chatId] ?? []), msg];
      g.emit('group.message', msg);
      const chats = groupChats(grp).map((c) => (c.id === chatId ? { ...c, title: c.title || p.text.slice(0, 48), lastMessagePreview: `You: ${p.text}`.slice(0, 200), lastActiveAt: now } : c));
      const lead = g.db.bots.find((b) => b.id === (grp.leadId ?? grp.botIds.find((id) => g.db.bots.find((b) => b.id === id)?.chief) ?? grp.botIds[0]));
      if (lead) {
        putGroup({ ...grp, chats, currentChatId: chatId, lastMessagePreview: `You: ${p.text}`.slice(0, 200), lastActiveAt: now, working: [lead.id], workingIn: { [lead.id]: chatId } });
        g.later(() => {
          const reply: GroupMessage = { id: newId('gm'), groupId: grp.id, ...at, from: { kind: 'bot', botId: lead.id, name: lead.name }, text: `Looking into "${p.text.slice(0, 60)}" now.`, mentions: [], hop: 1, createdAt: Date.now() };
          groupMessages[chatId] = [...(groupMessages[chatId] ?? []), reply];
          g.emit('group.message', reply);
          const cur = (g.db.groups ?? []).find((x) => x.id === grp.id);
          if (cur) putGroup({ ...cur, lastMessagePreview: `${lead.name}: ${reply.text}`.slice(0, 200), lastActiveAt: reply.createdAt, working: [], workingIn: {} });
        }, 1500);
      }
      return msg;
    },
    'groups.restore': (p) => {
      const grp = (g.db.groups ?? []).find((x) => x.id === p.id);
      if (!grp) throw notFound('Group');
      const chats = p.chats.map((c, i) => {
        const id = i === 0 ? grp.id : newId('gc');
        groupMessages[id] = c.messages.map((m) => ({ ...m, mentions: m.mentions ?? [], hop: m.hop ?? 0, id: newId('gm'), groupId: grp.id, ...(id !== grp.id ? { chatId: id } : {}) }));
        return { id, title: c.title ?? '', lastMessagePreview: '', createdAt: c.createdAt };
      });
      return putGroup({ ...grp, chats, currentChatId: chats[chats.length - 1]!.id, updatedAt: Date.now() });
    },
    'groups.stop': (p) => {
      const cur = (g.db.groups ?? []).find((x) => x.id === p.id);
      if (cur) putGroup({ ...cur, working: [] });
      return OK;
    },
    'routines.create': (p) => {
      bot(p.botId);
      const now = Date.now();
      return putRoutine(RoutineSchema.parse({ ...p, id: newId('rt'), nextRunAt: now + 86_400_000, createdAt: now, updatedAt: now }));
    },
    'routines.update': (p) => {
      const prev = g.db.routines.find((r) => r.id === p.id);
      if (!prev) throw notFound('Routine');
      return putRoutine(RoutineSchema.parse({ ...prev, ...p.patch, id: p.id, updatedAt: Date.now() }));
    },
    'routines.delete': (p) => {
      g.db.routines = g.db.routines.filter((r) => r.id !== p.id);
      g.emit('routine.deleted', { id: p.id });
      return OK;
    },
    'routines.runNow': (p) => {
      const r = g.db.routines.find((x) => x.id === p.id);
      if (!r) throw notFound('Routine');
      // a routine posts into its bot's current thread, like the gateway
      const t = chatFor(r.botId);
      putRoutine({ ...r, lastRunAt: Date.now(), lastThreadId: t.id, updatedAt: Date.now() });
      g.later(() => startRun(t.id, r.prompt, 'routine'), 50);
      return t;
    },

    /* ---------- channels ---------- */
    'channels.list': () => g.db.channels,
    'channels.configure': (p) => {
      const prev: Channel = g.db.channels.find((c) => c.id === p.id) ?? { id: p.id, enabled: false, status: 'stopped', allowedUsers: [] };
      const enabled = p.enabled ?? prev.enabled;
      const next: Channel = {
        ...prev, enabled, botId: p.botId ?? prev.botId, allowedUsers: p.allowedUsers ?? prev.allowedUsers,
        status: enabled ? 'running' : 'stopped', botUsername: p.token ? 'appu_desk_bot' : prev.botUsername,
        pairingCode: prev.pairingCode ?? String(100_000 + Math.floor(Math.random() * 900_000)), error: undefined,
      };
      g.db.channels = g.db.channels.some((c) => c.id === p.id) ? g.db.channels.map((c) => (c.id === p.id ? next : c)) : [...g.db.channels, next];
      g.emit('channel.updated', next);
      return next;
    },
    'channels.add': (p) => {
      const taken = new Set(g.db.channels.map((c) => c.botId));
      const next: Channel = { id: `tg_${Date.now().toString(36)}`, enabled: false, status: 'stopped', allowedUsers: [], botId: p.botId ?? g.db.bots.find((b) => !taken.has(b.id))?.id ?? g.db.bots[0]?.id };
      g.db.channels = [...g.db.channels, next];
      g.emit('channel.updated', next);
      return next;
    },
    'channels.remove': (p) => {
      g.db.channels = g.db.channels.filter((c) => c.id !== p.id);
      g.emit('channel.removed', { id: p.id });
      return { ok: true as const };
    },

    /* ---------- apps (Composio) ---------- */
    ...createAppsHandlers(g),
    ...createVoiceHandlers(g),
    ...createCharacterHandlers(g),
    ...createCloudHandlers(g),
    ...createDeviceLoginHandlers(g),
    'usage.summary': (p) => mockUsageSummary(p),
    'providers.limits': async (p = {}) => { if (p.refresh) await new Promise((r) => setTimeout(r, 600)); const limits = g.opts.limits === 'none' ? [] : mockLimits(g.opts.limits, g.db.providers); if (g.opts.limits !== 'none') g.db.limits = limits; return { limits: p.ids ? limits.filter((l) => p.ids!.includes(l.providerId)) : limits }; },
    'storage.summary': () => MOCK_STORAGE,
    'storage.clean': () => ({ ...MOCK_STORAGE, cleanedAt: Date.now(), freedBytes: 0 }),

    /* ---------- devices & pairing ---------- */
    'devices.list': () => g.db.devices,
    'devices.revoke': (p) => {
      g.db.devices = g.db.devices.filter((d) => d.id !== p.id);
      g.emit('device.deleted', { id: p.id });
      return OK;
    },
    'devices.rename': (p) => {
      const d = g.db.devices.find((x) => x.id === p.id);
      if (!d) throw notFound('Device');
      return putDevice({ ...d, name: p.name });
    },
    // the window is no phone: it never registers for notifications itself
    'devices.setPush': () => ({ pushOn: false }),
    'devices.setNotifications': (p) => {
      const d = g.db.devices.find((x) => x.id === p.id);
      if (!d) throw notFound('Device');
      const registered = !!d.pushOn || !!d.pushOff;
      return putDevice({ ...d, ...(registered ? { pushOn: p.on } : {}), pushOff: p.on ? undefined : true });
    },
    'devices.presence': () => OK,
    'pairing.start': (p) => {
      const hosts: PairingInfo['hosts'] = [
        { host: TS_IP, port: PORT, kind: 'tailscale' },
        { host: TS_DNS, port: PORT, kind: 'magicdns' },
        { host: LAN_IP, port: PORT, kind: 'lan' },
      ];
      const code = '482913';
      const info: PairingInfo = {
        code, expiresAt: Date.now() + (p?.ttlSec ?? 300) * 1000, hosts, hostName: HOST_NAME,
        url: buildPairUrl({ hosts: hosts.map((h) => h.host), port: PORT, code, hostName: HOST_NAME }),
      };
      g.emit('pairing.updated', info);
      if (pairingTimer) clearTimeout(pairingTimer);
      pairingTimer = g.later(() => {
        pairingTimer = null;
        const now = Date.now();
        putDevice({ id: newId('dev'), name: "Sarthak's iPad", platform: 'ios', role: 'full', pairedAt: now, lastSeenAt: now, lastIp: '100.88.20.7', tailscaleUser: 'sarthak@github', online: true });
        g.emit('pairing.updated', null);
        g.emit('notification', { id: newId('n'), title: 'New device paired', body: "Sarthak's iPad can now talk to your bots.", level: 'success', ts: now });
      }, 6000);
      return info;
    },
    'connect.status': () => mockConnect,
    'connect.set': (p) => { mockConnect = { ...mockConnect, state: p.enabled ? 'up' : 'off', since: Date.now() }; return mockConnect; },
    'connect.reset': () => { mockConnect = { ...mockConnect, state: 'starting', connectId: 'k2d7q4m9xz3b6n8p5r2t7v4w9y', since: Date.now() }; return mockConnect; },
    'pairing.cancel': () => {
      if (pairingTimer) clearTimeout(pairingTimer);
      pairingTimer = null;
      g.emit('pairing.updated', null);
      return OK;
    },

    /* ---------- files ---------- */
    'files.open': () => ({ ok: true as const }),
    'voice.convert': (p) => addFile(`voice-${p.fileId}.wav`),
    // no gateway to serve pages here: the chat says the page can't be shown and offers its file
    'files.pageView': (p) => ({ path: `/pages/${p.id}?v=mock` }),
    'files.list': (p) => g.files.slice(0, p?.limit ?? 50),
    'files.sendToDevices': (p) => addFile(p.path, p.caption),

    /* ---------- agent bridge ---------- */
    'agent.ask': (p) => ({ answer: p.options?.[0] ?? null }),
    'agent.askForm': () => ({ values: null }),
    'agent.say': () => ({ ok: true as const }),
    'agent.apps.search': () => ({ text: 'Your apps: Gmail (gmail), GitHub (github).' }),
    'agent.apps.schemas': () => ({ text: '{}' }),
    'agent.apps.execute': () => ({ text: '{"successful":true}' }),
    'agent.notify': (p) => {
      g.emit('notification', { id: newId('n'), title: p.title, body: p.body ?? '', level: 'info', ts: Date.now() });
      return OK;
    },
    'agent.sendFile': (p) => addFile(p.path, p.caption),
    'agent.showPage': (p) => ({ ok: true as const, bytes: p.html.length }),
    'agent.remember': (p) => {
      const res = appendMemory(appuMemory(), p.text, today());
      g.memory[IDS.appu] = res.memory;
      return { ok: true, path: memPath(), added: res.added, chars: res.memory.length };
    },
    'agent.memory.read': () => { const memory = appuMemory(); return { memory, path: memPath(), chars: memory.length }; },
    'agent.memory.update': (p) => {
      const res = replaceInMemory(appuMemory(), p.find, p.text, today());
      if (!res.ok) throw new GatewayError('invalid_params', res.reason === 'many' ? `${res.matches.length} lines match “${p.find}”: be more precise.` : `No line matches “${p.find}”.`);
      g.memory[IDS.appu] = res.memory;
      return { ok: true, path: memPath(), removed: res.removed[0] ?? '', ...(res.added ? { added: res.added } : {}), chars: res.memory.length };
    },
    'agent.memory.forget': (p) => {
      const res = forgetInMemory(appuMemory(), p.text);
      g.memory[IDS.appu] = res.memory;
      return { ok: true, path: memPath(), removed: res.removed, chars: res.memory.length };
    },
    'agent.saveSkill': (p) => saveSkill(IDS.appu, p.name, p.description ?? '', p.body),
    'agent.context': () => {
      const b = bot(IDS.appu);
      return { botId: b.id, threadId: IDS.main, botName: b.name, workspace: b.workspace, computerUse: b.computerUse };
    },
    // the agent-only bot tools are never called by the UI; enough to type-check and poke at
    'agent.bots.message': (p) => { const b = g.db.bots.find((x) => x.id === p.bot || x.name === p.bot) ?? bot(IDS.ledger); return { bot: { id: b.id, name: b.name }, threadId: IDS.main, reply: 'Sure.', timedOut: false }; },
    'agent.bots.broadcast': (p) => ({ replies: g.db.bots.filter((b) => b.id !== IDS.appu).map((b) => ({ bot: { id: b.id, name: b.name }, reply: `Heard: ${p.text}`, timedOut: false })) }),
    'agent.groups.list': () => (g.db.groups ?? []).map((grp) => ({ ...grp, members: grp.botIds.map((id) => g.db.bots.find((b) => b.id === id)).filter((b): b is Bot => !!b).map((b) => ({ id: b.id, name: b.name, chief: b.chief })) })),
    'agent.groups.post': (p) => { const grp = (g.db.groups ?? []).find((x) => x.id === p.group || x.name === p.group); if (!grp) throw notFound('Group'); const msg: GroupMessage = { id: newId('gm'), groupId: grp.id, from: { kind: 'bot', botId: IDS.appu, name: 'Appu' }, text: p.text, mentions: [], hop: 1, createdAt: Date.now() }; groupMessages[grp.id] = [...(groupMessages[grp.id] ?? []), msg]; g.emit('group.message', msg); return msg; },
    'agent.goal.start': (p) => { const now = Date.now(); return { goal: { objective: p.objective, status: 'active' as const, turns: 0, maxTurns: p.maxTurns ?? 20, startedAt: now, updatedAt: now } }; },
    'agent.goal.finish': (p) => { const now = Date.now(); return { goal: { objective: 'Mock goal', status: p.status, turns: 3, maxTurns: 20, note: p.note, startedAt: now - 300_000, updatedAt: now } }; },
    'agent.groups.create': (p) => { const now = Date.now(); return putGroup({ id: newId('grp'), name: p.name, botIds: p.botIds, ...(p.leadId ? { leadId: p.leadId } : {}), lastMessagePreview: '', working: [], workingIn: {}, chats: [], createdAt: now, updatedAt: now }); },
    'agent.bots.list': () => g.db.bots.map((b) => ({ id: b.id, name: b.name, job: b.job, providerId: b.providerId, agent: b.providerId, isYou: b.id === IDS.appu, status: 'idle' as const, chief: b.chief })),
    'agent.bots.get': (p) => { const { autoApprove: _a, emoji: _e, ...b } = bot(p.id ?? IDS.appu); return { bot: b, isYou: b.id === IDS.appu, agent: b.providerId, models: [], efforts: [], fastAvailable: false, modes: [], agents: [], apps: [], characters: [] }; },
    'agent.bots.update': (p) => {
      const { autoApprove: _a, emoji: _e, ...b } = bot(p.id ?? IDS.appu);
      const { appsTurnOn: _on, appsTurnOff: _off, ...patch } = p.patch;
      return { bot: { ...b, ...patch }, isYou: b.id === IDS.appu, agent: b.providerId, models: [], efforts: [], fastAvailable: false, modes: [], agents: [], apps: [], characters: [] };
    },
    'agent.routines.list': () => { throw new GatewayError('forbidden', 'Not in the mock'); },
    'agent.routines.create': () => { throw new GatewayError('forbidden', 'Not in the mock'); },
    'agent.routines.update': () => { throw new GatewayError('forbidden', 'Not in the mock'); },
    'agent.routines.delete': () => { throw new GatewayError('forbidden', 'Not in the mock'); },
    'agent.bots.create': () => { throw new GatewayError('forbidden', 'Not in the mock'); },
    'agent.react': () => { throw new GatewayError('forbidden', 'Not in the mock'); },
    'agent.vault.list': () => { throw new GatewayError('forbidden', 'Not in the mock'); },
    'agent.vault.fill': () => { throw new GatewayError('forbidden', 'Not in the mock'); },
    'agent.vault.key': () => { throw new GatewayError('forbidden', 'Not in the mock'); },
    'agent.vault.request': () => { throw new GatewayError('forbidden', 'Not in the mock'); },
    'agent.apps.request': () => { throw new GatewayError('forbidden', 'Not in the mock'); },
    'agent.telegram.request': () => { throw new GatewayError('forbidden', 'Not in the mock'); },
    'vault.list': () => ({ items: mockVault.map(({ secretValues: _s, ...i }) => i), encrypted: true }),
    'vault.save': (p) => mockVaultSave(p),
    'vault.saveMany': (p) => ({ items: p.items.map(mockVaultSave) }),
    /* git and GitHub, and a computer's lent folders (Settings › Transfer): the one mock stands for both computers */
    'github.local': () => ({ git: true, name: 'Ada Lovelace', email: 'ada@example.com', hasToken: true, via: 'gh' as const }),
    'github.localToken': () => ({ token: 'gho_mockmockmockmockmockmockmockmock' }),
    'github.status': () => mockGit,
    'github.setup': (p) => {
      mockGit = {
        ...mockGit, ...(p.name ? { name: p.name } : {}), ...(p.email ? { email: p.email } : {}), ...(p.token ? { login: 'ada' } : {}),
        ...(p.sshKey ? { sshKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMockMockMockMockMockMockMockMockMockMockMock ada@example.com (cloud)' } : {}),
      };
      return mockGit;
    },
    'macLink.status': () => mockLink,
    'macLink.setFolders': (p) => { mockLink = { ...mockLink, folders: p.folders, writable: (mockLink.writable ?? []).filter((w) => p.folders.includes(w)) }; return mockLink; },
    'macLink.setWritable': (p) => { mockLink = { ...mockLink, writable: [...(mockLink.writable ?? []).filter((w) => w !== p.folder), ...(p.on ? [p.folder] : [])] }; return mockLink; },
    'macLink.create': (p) => {
      const id = `lnk_${Date.now().toString(36)}`;
      mockLink = { ...mockLink, links: [...mockLink.links, { id, name: p.name, createdAt: Date.now() }] };
      return { id, token: 'mock-link-token-mock-link-token-mock', connectId: 'mockroommockroommockroom00', connectKey: 'bW9ja21vY2ttb2NrbW9ja21vY2ttb2NrbW9ja21vY2s', hostName: 'Ada’s MacBook Pro' };
    },
    'macLink.revoke': (p) => { mockLink = { ...mockLink, links: mockLink.links.filter((l) => l.id !== p.id) }; return mockLink; },
    'macFiles.status': () => mockMacFiles,
    'macFiles.link': (p) => { mockMacFiles = { linked: { linkId: p.linkId, name: p.name, since: Date.now() } }; return mockMacFiles; },
    'macFiles.unlink': () => { mockMacFiles = {}; return mockMacFiles; },
    'macFiles.check': () => (mockMacFiles.linked
      ? { ok: true, name: mockMacFiles.linked.name, folders: mockLink.folders.map((path) => ({ name: path.split('/').pop() || path, path, ...(mockLink.writable?.includes(path) ? { writable: true } : {}) })) }
      : { ok: false, error: 'No computer is linked.' }),
    'agent.mac.list': () => { throw new GatewayError('forbidden', 'Not in the mock'); },
    'agent.mac.find': () => { throw new GatewayError('forbidden', 'Not in the mock'); },
    'agent.mac.fetch': () => { throw new GatewayError('forbidden', 'Not in the mock'); },
    'agent.mac.put': () => { throw new GatewayError('forbidden', 'Not in the mock'); },
    'vault.delete': (p) => { mockVault = mockVault.filter((i) => i.id !== p.id); return OK; },
    'vault.reveal': (p) => ({ value: mockVault.find((i) => i.id === p.id)?.secretValues[p.field] ?? '' }),
    'agent.transcribe': () => { throw new GatewayError('forbidden', 'Not in the mock'); },
    'agent.speak': () => { throw new GatewayError('forbidden', 'Not in the mock'); },
    'chat.react': (p) => {
      const conv = g.messages[p.threadId] ?? [];
      const m = conv.find((x) => x.id === p.messageId);
      if (!m) throw notFound('Message');
      m.reactions = [...(m.reactions ?? []).filter((r) => r.by !== 'user'), ...(p.emoji ? [{ emoji: p.emoji, by: 'user' as const, at: Date.now() }] : [])];
      g.emit('message.reactions', { threadId: p.threadId, messageId: p.messageId, reactions: m.reactions });
      return OK;
    },
    'agent.bots.history': () => ({ messages: [], hasMore: false }),

    /* ---------- settings & system ---------- */
    'settings.get': () => g.db.settings,
    'settings.update': (p) => {
      const cur = g.db.settings;
      const next = SettingsSchema.parse({
        ...cur, ...p,
        gateway: { ...cur.gateway, ...p.gateway },
        computer: { ...cur.computer, ...p.computer },
        approvals: { ...cur.approvals, ...p.approvals },
        notifications: { ...cur.notifications, ...p.notifications },
        power: { ...cur.power, ...p.power },
        voice: { ...cur.voice, ...p.voice },
      });
      g.db.settings = next;
      g.emit('settings.updated', next);
      if (next.computer.background !== g.db.computer.background) putComputer({ background: next.computer.background });
      return next;
    },
    'system.info': () => ({ ...g.db.system, uptimeSec: g.db.system.uptimeSec + Math.round(performance.now() / 1000) }),
    'system.openPath': () => OK,
    'system.ping': () => ({ pong: true, ts: Date.now() }),
    'system.testNotification': () => ({ shown: true }),
    'system.openNotificationSettings': () => ({ ok: true as const }),
    // ?notifications=off|not-asked previews the chat's "notifications are off" notice
    'system.notificationAccess': () => ({ access: mockNotificationAccess() }),
    'system.requestNotifications': () => { notifyAccess = 'on'; return { access: 'on' as const }; },
    // the launch gift: Start sets Claude up in a few steps, then it is on
    'promo.start': async () => {
      const set = (promo: NonNullable<typeof g.db.system.promo>) => { g.db.system = { ...g.db.system, promo }; g.emit('system.updated', g.db.system); return promo; };
      const base = g.db.system.promo ?? { id: 'free-claude-day', model: 'claude-haiku-5-5', state: 'offer' as const, signedIn: true };
      for (const step of ['account', 'install'] as const) { set({ ...base, state: 'starting', step }); await new Promise((r) => setTimeout(r, 900)); }
      return set({ ...base, state: 'on', bots: 0 });
    },
    'promo.use': (p) => {
      const was = bot(p.botId);
      // on: the gift's agent; off: plain Claude Code (the mock keeps no record of what it used)
      return putBot(BotSchema.parse({ ...was, providerId: p.on ? APPUBOT_AI_PROVIDER_ID : 'claude-code', modelId: p.on ? 'claude-haiku-5-5' : undefined, updatedAt: Date.now() }));
    },
    'promo.dismiss': () => {
      const { promo: _gone, ...rest } = g.db.system;
      g.db.system = rest;
      g.emit('system.updated', g.db.system);
      return { ok: true as const };
    },
    // "Check for updates" finds 0.2.0 and downloads it in a few steps
    'system.checkForUpdate': () => {
      const setUpdate = (update: NonNullable<typeof g.db.system.update>) => {
        const required = g.db.system.update?.required;
        g.db.system = { ...g.db.system, update: required ? { ...update, required } : update };
        g.emit('system.updated', g.db.system);
      };
      if (g.db.system.update?.state === 'ready') return g.db.system.update;
      setUpdate({ state: 'downloading', version: '0.2.0', percent: 0, checkedAt: Date.now() });
      for (const [i, percent] of [18, 47, 76, 100].entries()) {
        setTimeout(() => setUpdate(percent < 100
          ? { state: 'downloading', version: '0.2.0', percent, checkedAt: Date.now() }
          : { state: 'ready', version: '0.2.0', checkedAt: Date.now() }), 500 * (i + 1));
      }
      return g.db.system.update!;
    },
    // "restarts" into the new version: no longer stopped
    'system.installUpdate': () => {
      g.db.system = { ...g.db.system, update: { state: 'up-to-date', checkedAt: Date.now() } };
      g.emit('system.updated', g.db.system);
      return { ok: true as const };
    },
    'power.setLidClosed': (p) => {
      g.db.settings = SettingsSchema.parse({ ...g.db.settings, power: { ...g.db.settings.power, lidClosed: p.on } });
      g.emit('settings.updated', g.db.settings);
      return { keepingAwake: g.db.settings.power.keepAwake, lidClosed: p.on ? 'on' : 'off', lidRule: p.on || !p.forgetRule };
    },
  };
}

/** `?notifications=off|not-asked|unknown`; first-run setup (`?onboarding=1`) starts not asked; Allow turns it on */
let notifyAccess: NotificationAccess | null = null;
function mockNotificationAccess(): NotificationAccess {
  if (notifyAccess) return notifyAccess;
  const q = new URLSearchParams(location.search);
  const v = q.get('notifications');
  return v === 'off' || v === 'not-asked' || v === 'unknown' || v === 'on' ? v : q.get('onboarding') === '1' ? 'not-asked' : 'on';
}

/** `vault.save` in the mock (also each item of `vault.saveMany`) */
function mockVaultSave(p: MethodParams<'vault.save'>): VaultItem {
  const prev = mockVault.find((i) => i.id === p.id);
  const secretValues = { ...prev?.secretValues };
  for (const [k, v] of Object.entries(p.secrets ?? {})) { if (v) secretValues[k] = v; else delete secretValues[k]; }
  const now = Date.now();
  const { secrets: _in, ...fields } = p;
  const item: MockVaultItem = {
    ...fields, contact: fields.contact ? VaultContactSchema.parse(fields.contact) : undefined, id: prev?.id ?? `vlt_${now.toString(36)}`, secrets: Object.keys(secretValues) as VaultItem['secrets'], secretValues,
    hint: secretValues.number?.slice(-4) ?? secretValues.key?.slice(-4), brand: secretValues.number ? cardBrand(secretValues.number) : undefined,
    createdAt: prev?.createdAt ?? now, updatedAt: now,
  };
  mockVault = prev ? mockVault.map((i) => (i.id === item.id ? item : i)) : [...mockVault, item];
  const { secretValues: _s, ...out } = item;
  return out;
}
/** git and GitHub as the mock's computers have them, and the folders one lends the other (Settings › Transfer) */
let mockGit: GitSetup = { git: true };
/** linked, Documents taking the bots' changes, a file saved this morning: every row of "Files on your Mac" shows */
let mockLink: MacLinkStatus = {
  folders: ['/Users/ada/Desktop', '/Users/ada/Documents/MARKETING'],
  writable: ['/Users/ada/Documents/MARKETING'],
  links: [{ id: 'lnk_mock', name: 'Ada’s Cloud Computer', createdAt: Date.now() - 3 * 86_400_000, lastUsedAt: Date.now() - 40 * 60_000, lastSavedAt: Date.now() - 38 * 60_000, lastSavedName: 'launch-article.md' }],
};
let mockMacFiles: MacFilesStatus = { linked: { linkId: 'lnk_mock', name: 'Ada’s MacBook Pro', since: Date.now() - 3 * 86_400_000 } };
