/** RPC method table + role gating + hello snapshot. */
import type { z } from 'zod';
import { ACP_REGISTRY, VOICE_PCM_RATE, providerBase, type MethodName, type MethodResult, type Methods, type Snapshot } from '@appubot/protocol';
import type { AgentContext, Role } from './auth';
import type { CoreCtx } from './context';
import { agentKind } from './services/analytics';
import { RpcError } from './util';
import { controlKey, type Watcher } from './services/liveView';
import { encodeOggOpus } from './audio/opus';

export interface CallCtx {
  role: Role;
  deviceId: string;
  agent?: AgentContext;
  /** the host:port the device reached the gateway at (its WebSocket's Host header), for links it opens itself */
  host?: string;
  /** the connection the call came on: live view sends its pictures to it alone */
  conn?: Watcher;
  /** a paired phone's connection: notes whether its app is in front (`devices.presence`) */
  presence?: (foreground: boolean, desk?: boolean) => void;
  /** a team's cloud computer: the team member this device belongs to (§6.11); absent elsewhere */
  member?: string;
}

/**
 * The agent sign-ins a team member's device may make on the team's shared computer, and only for an agent profile of
 * their own (`<agent>@<slug>`): the agents' own logins are the team's, set by an admin.
 */
/** gateway connections that have called computer.control: a phone with the Take control pill (the rest predate it) */
const controlAware = new WeakSet<object>();

const MEMBER_PROFILE_METHODS = new Set<MethodName>([
  'providers.authenticate', 'providers.logout', 'providers.setKeys', 'providers.clearKeys', 'providers.renameProfile', 'providers.delete',
  'providers.deviceLogin.start', 'providers.deviceLogin.code', 'providers.deviceLogin.cancel', 'providers.deviceLogin.finish',
]);
/** the provider id a call names (`id`), when it is an agent profile's */
function profileIdOf(params: unknown): string | null {
  const id = params && typeof params === 'object' ? (params as Record<string, unknown>).id : undefined;
  return typeof id === 'string' && providerBase(id) !== id ? id : null;
}

type Params<M extends MethodName> = z.output<(typeof Methods)[M]['params']>;
export type Handlers = { [M in MethodName]: (p: Params<M>, cx: CallCtx) => MethodResult<M> | Promise<MethodResult<M>> };

const LIMITED_ALLOWED = new Set<MethodName>([
  'bots.list', 'bots.memory.get', 'bots.history', 'characters.list', 'threads.list', 'threads.get', 'threads.commands', 'threads.messages', 'threads.history', 'threads.create',
  'threads.start', 'threads.warm', 'threads.goal',
  'chat.send', 'chat.cancel', 'chat.answer', 'chat.answerForm', 'chat.react', 'permissions.list', 'permissions.respond', 'providers.list', 'providers.choices', 'providers.limits',
  'computer.status', 'computer.pause', 'computer.resume', 'skills.list', 'skills.get', 'teach.status',
  // watching the screen (using it from afar stays with full access)
  'computer.watch', 'computer.liveAck', 'computer.liveKey',
  'routines.list', 'groups.list', 'groups.history', 'groups.send', 'groups.stop', 'groups.goal', 'groups.newChat', 'groups.useChat', 'channels.list', 'apps.status', 'apps.catalog', 'apps.connections', 'devices.list', 'files.list', 'files.pageView',
  // its own notifications, and whether its app is in front
  'devices.setPush', 'devices.presence',
  'settings.get', 'system.info', 'system.ping',
  // talking to a bot: hear a recording, read a reply aloud (downloading the models stays with full access)
  'voice.status', 'voice.transcribe', 'voice.speak', 'voice.warm', 'voice.convert',
]);
const AGENT_ALLOWED = new Set<MethodName>([
  'agent.ask', 'agent.askForm', 'agent.say', 'agent.notify', 'agent.sendFile', 'agent.showPage', 'agent.transcribe', 'agent.speak', 'agent.remember', 'agent.memory.read', 'agent.memory.update', 'agent.memory.forget',
  'agent.saveSkill', 'agent.context', 'agent.apps.search', 'agent.apps.schemas', 'agent.apps.execute', 'agent.apps.request', 'agent.telegram.request',
  'agent.bots.list', 'agent.bots.get', 'agent.bots.update', 'agent.bots.history', 'agent.bots.create', 'agent.react',
  'agent.routines.list', 'agent.routines.create', 'agent.routines.update', 'agent.routines.delete',
  'agent.bots.message', 'agent.bots.broadcast', 'agent.groups.list', 'agent.groups.post', 'agent.groups.create', 'agent.goal.start', 'agent.goal.finish',
  'agent.vault.list', 'agent.vault.fill', 'agent.vault.key', 'agent.vault.request',
  'agent.mac.list', 'agent.mac.find', 'agent.mac.fetch', 'agent.mac.put',
  'computer.act', 'computer.batch', 'computer.screenshot', 'computer.status', 'files.sendToDevices', 'system.ping',
]);

/** whether `params[key]` holds a secret to save: a non-empty string, or an object with one ('' only clears) */
function carriesSecret(params: unknown, key: string): boolean {
  const v = params && typeof params === 'object' ? (params as Record<string, unknown>)[key] : undefined;
  if (typeof v === 'string') return v !== '';
  return !!v && typeof v === 'object' && Object.values(v).some((x) => typeof x === 'string' && x !== '');
}

/** Throws `forbidden` when the role may not call the method with these params. */
export function checkRole(method: MethodName, params: unknown, cx: CallCtx): void {
  const deny = () => { throw new RpcError('forbidden', `Your device is not allowed to call ${method}`); };
  const isAgentMethod = method.startsWith('agent.');
  switch (cx.role) {
    case 'owner':
      if (isAgentMethod) deny();
      return;
    case 'agent':
      if (!AGENT_ALLOWED.has(method)) deny();
      return;
    case 'limited':
      if (!LIMITED_ALLOWED.has(method)) deny();
      return;
    case 'full': {
      // the Mac's AppuBot Cloud account is the Mac's own: a phone has its own account with the backend
      if (method.startsWith('cloudAccount.') || method.startsWith('promo.')) deny();
      // a team member on the team's shared computer signs in only agent profiles of their own; the shared logins are
      // the admins' (their keys too: a member's own profile's keys are theirs to set)
      if (cx.member && MEMBER_PROFILE_METHODS.has(method)) {
        if (!profileIdOf(params)) deny();
        if (method === 'providers.setKeys' || method === 'providers.clearKeys') return;
      }
      // an agent's keys stay with the computer itself: a secret would cross the network (encrypted on every route now,
      // the same Wi-Fi's too, but kept to the computer all the same), and so do the computer's other files
      // (`files.sendToDevices` takes any path under home);
      // `providers.upsert` only switches an existing agent on or off (its handler). A full phone may remove any paired
      // device, e.g. a lost one (on a team's computer only its own member's: the handler checks).
      if (isAgentMethod || method === 'providers.setKeys' || method === 'providers.clearKeys' || method === 'files.sendToDevices') deny();
      // so do the Vault's secrets and a model server's key: typed in and shown only on the computer (clearing one, or
      // anything else about an item or a server, works from a phone too)
      if (method === 'vault.reveal' || (method === 'vault.save' && carriesSecret(params, 'secrets'))) deny();
      // what one of the person's computers hands another (a GitHub sign-in, a token to read its folders) passes
      // through the computer's own window only, like the Vault's secrets
      if (method.startsWith('github.') || method.startsWith('macLink.') || method === 'macFiles.link' || method === 'macFiles.unlink') deny();
      if (method === 'vault.saveMany' && ((params as { items?: unknown[] } | undefined)?.items ?? []).some((i) => carriesSecret(i, 'secrets'))) deny();
      // whose logins a bot runs on is an admin's call (§6.11)
      if (cx.member && method === 'bots.update' && params && typeof params === 'object' && 'memberId' in ((params as { patch?: object }).patch ?? {})) deny();
      if ((method === 'endpoints.save' || method === 'endpoints.probe') && carriesSecret(params, 'apiKey')) deny();
      // the person's shared skills are files of the computer's home: read and packed for the computer's own window only
      if (method === 'skills.getShared' || (method === 'bots.export' && Array.isArray((params as { sharedSkills?: unknown[] } | undefined)?.sharedSkills) && (params as { sharedSkills: unknown[] }).sharedSkills.length)) deny();
      // a phone can't switch off or replace the tunnel it may be talking through
      if (method === 'connect.set' || method === 'connect.reset') deny();
      if (method === 'settings.update' && params && typeof params === 'object' && 'gateway' in params) deny();
      return;
    }
  }
}

/**
 * What an agent may still do during a hidden turn (AppuBot asking what to remember, or about a reaction): its memory,
 * and reacting back to the user's message; nothing else the user would see.
 */
const HIDDEN_ALLOWED = new Set<MethodName>(['agent.remember', 'agent.memory.read', 'agent.memory.update', 'agent.memory.forget', 'agent.context', 'agent.react', 'system.ping']);

/** Throws `forbidden` for an agent's call that would act or show in the chat while its thread runs a hidden turn. */
export function checkHiddenTurn(method: MethodName, cx: CallCtx, isHidden: (threadId: string) => boolean): void {
  if (cx.role !== 'agent' || !cx.agent || HIDDEN_ALLOWED.has(method) || !isHidden(cx.agent.threadId)) return;
  throw new RpcError('forbidden', 'Not now: no tools in this turn. Reply with text only.');
}

/** What a stopped version (the version policy) still answers: what updating takes, and what the window reads to show it. */
const STOPPED_ALLOWED = new Set<MethodName>([
  'system.info', 'system.ping', 'system.checkForUpdate', 'system.installUpdate', 'system.notificationAccess', 'settings.get',
]);

/** Throws `update_required` for anything else while this version is stopped. */
export function checkWorking(method: MethodName, stopped: { message: string } | undefined): void {
  if (stopped && !STOPPED_ALLOWED.has(method)) throw new RpcError('update_required', stopped.message);
}

/** a kept recording's file extension, from what the client said it is */
function extForMime(mime: string | undefined): string {
  const m = (mime ?? '').toLowerCase();
  if (m.includes('webm')) return 'webm';
  if (m.includes('mp4') || m.includes('m4a') || m.includes('aac')) return 'm4a';
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  if (m.includes('wav')) return 'wav';
  if (m.includes('ogg') || m.includes('opus')) return 'ogg';
  return 'audio';
}

function agentCtx(cx: CallCtx): AgentContext {
  if (!cx.agent) throw new RpcError('forbidden', 'Only agent sessions may call agent.* methods');
  return cx.agent;
}

export function buildHandlers(ctx: CoreCtx): Handlers {
  const s = ctx.s;
  /** whose logins a device's call works with (a team member's own on a team's computer set so, §6.11; else the computer's) */
  const scopeOf = (cx: CallCtx): string => s.logins.scopeOfCall(cx);
  /** the connected apps of the caller's scope */
  const appsOf = (cx: CallCtx) => s.composioFor(scopeOf(cx));
  /** the connected apps of the calling bot's person */
  const botApps = (cx: CallCtx) => s.composioFor(s.logins.scopeOfBotId(agentCtx(cx).botId));
  return {
    'bots.list': () => s.bots.list(),
    'bots.create': (p, cx) => {
      const { greet, ...fields } = p;
      // on a team's cloud computer the bot belongs to the person whose device made it (its logins, §6.11)
      const bot = s.bots.create(fields, { ...(cx.member ? { memberId: cx.member } : {}) });
      s.analytics.capture('bot_created', { agent: agentKind(bot.providerId), computer_use: bot.computerUse });
      // the new bot says hello and asks what you'd like (only the bot editors ask for this)
      if (greet) s.chat.greet(bot.id);
      return bot;
    },
    'bots.update': (p) => s.bots.update(p.id, p.patch),
    'bots.delete': (p) => s.bots.delete(p.id, p.deleteWorkspace),
    'bots.export': (p, cx) => s.botBundle.export(p.id, cx.member, { include: p.include, sharedSkills: p.sharedSkills }),
    'bots.exportable': (_p, cx) => s.botBundle.exportable(cx.member),
    'bots.import': (p, cx) => s.botBundle.import({ fileId: p.fileId, name: p.name, routines: p.routines, ...(cx.member ? { member: cx.member } : {}) }),
    'bots.memory.get': (p) => s.bots.getMemory(p.id),
    'bots.memory.set': (p) => s.bots.setMemory(p.id, p.memory),
    'bots.history': (p) => s.threads.history(p.id, p),

    'characters.list': () => s.characters.list(),
    // drawn with the user's own agent, for whoever asks from their own devices (not bots: AGENT_ALLOWED leaves it out)
    'characters.generate': (p, cx) => s.characters.generate(p, cx.deviceId),
    'characters.cancel': (p, cx) => s.characters.cancel(cx.deviceId, p.requestId),
    'characters.save': (p) => s.characters.save(p),
    'characters.rename': (p) => s.characters.rename(p.id, p.name),
    'characters.delete': (p) => s.characters.delete(p.id),

    'threads.list': (p) => s.threads.list({ botId: p.botId, limit: p.limit }),
    // older phones call this whenever they open a bot: they get its current thread, never a new one
    'threads.create': (p) => s.threads.chatFor(s.bots.require(p.botId).id),
    'threads.start': (p, cx) => s.chat.startThread(p.botId, cx.role === 'owner' ? 'desktop' : 'mobile'),
    'threads.get': (p) => s.threads.getWithMessages(p.id),
    'threads.commands': (p) => {
      const t = s.threads.get(p.id);
      if (!t) throw new RpcError('not_found', 'No such thread');
      return { commands: t.commands ?? [] };
    },
    'threads.messages': (p) => s.threads.messages(p.id, { before: p.before, limit: p.limit }),
    'threads.history': (p) => s.threads.threadHistory(p.id, p),
    'threads.rename': (p) => s.threads.rename(p.id, p.title),
    'threads.delete': (p) => s.threads.delete(p.id),
    // a thread's picker changes run one at a time, in the order sent (quick High → Low → Medium lands on Medium)
    'threads.setMode': (p) => s.chat.inOrder(p.id, () => s.chat.setMode(p.id, p.modeId)),
    'threads.setModel': (p) => s.chat.inOrder(p.id, () => s.chat.setModel(p.id, p.modelId)),
    // the bot keeps the pick, so its next chats and restarted sessions start with it
    'threads.setEffort': (p) => s.chat.inOrder(p.id, async () => {
      const thread = await s.chat.setEffort(p.id, p.effortId);
      if (s.bots.require(thread.botId).effort !== p.effortId) s.bots.update(thread.botId, { effort: p.effortId });
      return thread;
    }),
    'threads.setFast': (p) => s.chat.inOrder(p.id, async () => {
      const thread = await s.chat.setFast(p.id, p.fast);
      if (s.bots.require(thread.botId).fast !== p.fast) s.bots.update(thread.botId, { fast: p.fast });
      return thread;
    }),
    'threads.goal': (p) => s.goals.act(p.id, p.action),
    'threads.warm': (p) => { s.chat.warm(p.botId, p.threadId, { session: p.session }); return { ok: true as const }; },

    'chat.send': (p, cx) => s.chat.send(p, cx.role === 'owner' ? 'desktop' : 'mobile', { device: cx.deviceId }),
    'chat.cancel': (p) => s.chat.cancel(p.threadId, { keepQueued: p.keepQueued }),
    'chat.answer': (p, cx) => s.chat.answer(p, cx.deviceId),
    'chat.answerForm': (p, cx) => s.chat.answerForm(p, cx.role, cx.deviceId),
    'chat.react': (p) => { s.chat.react(p.threadId, p.messageId, 'user', p.emoji); return { ok: true as const }; },

    'permissions.list': () => s.chat.listPermissions(),
    'permissions.respond': (p, cx) => s.chat.respondPermission(p.id, p.optionId, cx.deviceId),

    'providers.list': (_p, cx) => s.providers.list(scopeOf(cx)),
    'providers.choices': (p) => s.providers.choices(p.id),
    'providers.limits': (p, cx) => s.limits.request(scopeOf(cx), p.ids, p.refresh, cx.role === 'limited'),
    'providers.refresh': async (p, cx) => {
      const scope = scopeOf(cx);
      if (scope) { await s.providers.refresh(p.ids); return s.providers.refreshSignIn(p.ids, scope); }
      return p.signIn ? s.providers.refreshSignIn(p.ids) : s.providers.refresh(p.ids);
    },
    'providers.upsert': async (p, cx) => {
      if (cx.role === 'owner') return s.providers.upsert(p);
      // a phone only switches an existing agent on or off: a custom command would run anything on the computer
      const cur = (await s.providers.list()).find((x) => x.id === p.id);
      if (!cur) throw new RpcError('forbidden', 'Add agents in AppuBot on the computer');
      return s.providers.upsert({ id: cur.id, name: cur.name, description: cur.description, command: cur.command, args: cur.args, env: cur.env, icon: cur.icon, enabled: p.enabled ?? cur.enabled, installHint: cur.installHint });
    },
    'providers.delete': (p) => s.providers.delete(p.id),
    'providers.install': (p) => s.providers.install(p.id),
    'providers.registry': (p) => s.acpRegistry.list(p.refresh),
    'providers.addFromRegistry': (p) => {
      if (!(ctx.deps.acpRegistry ?? ACP_REGISTRY)) throw new RpcError('invalid_params', 'Adding agents from the ACP registry is off for now.');
      return s.acpRegistry.add(p.id);
    },
    'providers.authenticate': (p, cx) => s.providers.authenticate(p.id, p.methodId, scopeOf(cx)),
    'providers.setKeys': (p, cx) => s.providers.setKeys(p.id, p.methodId, p.values, scopeOf(cx)),
    'providers.clearKeys': (p, cx) => s.providers.clearKeys(p.id, scopeOf(cx)),
    'providers.logout': (p, cx) => s.providers.logout(p.id, scopeOf(cx)),
    'providers.deviceLogin.start': (p, cx) => s.deviceLogin.start(p.id, p.methodId, scopeOf(cx), p.here),
    'providers.deviceLogin.status': (p) => s.deviceLogin.status(p.id),
    'providers.deviceLogin.code': (p) => s.deviceLogin.code(p.id, p.code),
    'providers.deviceLogin.cancel': (p) => s.deviceLogin.cancel(p.id),
    'providers.deviceLogin.finish': (p) => s.deviceLogin.finish(p.id, p.url),
    'providers.profiles': () => s.providers.profiles(),
    'providers.addProfile': (p) => s.providers.addProfile(p),
    'vault.list': (_p, cx) => s.vault.list(scopeOf(cx)),
    'vault.save': (p, cx) => s.vault.save(p, scopeOf(cx)),
    'vault.saveMany': (p, cx) => s.vault.saveMany(p.items, scopeOf(cx)),
    'vault.delete': (p, cx) => s.vault.delete(p.id, scopeOf(cx)),
    'vault.reveal': (p, cx) => s.vault.reveal(p.id, p.field, scopeOf(cx)),

    // git and GitHub carried between the person's computers (the computer's own window: `checkRole`)
    'github.local': (_p, cx) => s.github.local(scopeOf(cx)),
    'github.localToken': (_p, cx) => s.github.localToken(scopeOf(cx)),
    'github.status': (_p, cx) => s.github.status(scopeOf(cx)),
    'github.setup': (p, cx) => s.github.setup(p, scopeOf(cx)),
    // this computer's folders lent to the bots on another of the person's computers, and the other end
    'macLink.status': () => s.macLink.status(),
    'macLink.setFolders': (p) => s.macLink.setFolders(p.folders),
    'macLink.create': (p) => s.macLink.create(p.name),
    'macLink.revoke': (p) => s.macLink.revoke(p.id),
    'macLink.setWritable': (p) => s.macLink.setWritable(p.folder, p.on),
    'macFiles.status': () => s.macFiles.status(),
    'macFiles.link': (p, cx) => {
      // one person's files for a whole team's bots is nobody's intent: a person's own AppuBot computer only
      if (cx.member || s.system.cloudLogins()) throw new RpcError('forbidden', 'A team’s computer can’t be linked to one person’s files.');
      return s.macFiles.link(p);
    },
    'macFiles.unlink': () => s.macFiles.unlink(),
    'macFiles.check': () => s.macFiles.check(),
    'endpoints.list': () => s.endpoints.list(),
    'endpoints.probe': (p) => s.endpoints.probe(p),
    'endpoints.save': (p) => s.endpoints.save(p),
    'endpoints.delete': (p) => s.endpoints.delete(p.id),
    'providers.renameProfile': (p) => s.providers.renameProfile(p.id, p.name),
    'providers.checkUpdates': (p) => s.providerUpdates.check(p.ids, true),
    'providers.update': (p) => s.providerUpdates.update(p.id),

    // the app's own ask re-checks the grants (macOS applies a new one without a restart); a bot gets what is known
    'computer.status': (_p, cx) => (cx.agent ? s.computer.status() : s.computer.refreshPermissions()),
    'computer.screenshot': (p) => s.computer.screenshot(p.maxWidth, p.quality),
    'computer.act': (p, cx) => s.computer.act(p.action, cx.agent?.threadId ?? p.threadId),
    'computer.batch': (p, cx) => s.computer.batch(p.steps, p.look, cx.agent?.threadId ?? p.threadId),
    'computer.pause': () => s.computer.pause(),
    'computer.resume': () => s.computer.resume(),
    'computer.setLiveView': (p) => s.computer.setLiveView(p.enabled),
    'computer.watch': async (p, cx) => {
      if (!cx.conn) throw new RpcError('unavailable', 'Live view needs a connection of its own');
      // leaving the view hands control back to the bots
      if (!p.on) s.computer.releaseControl(controlKey(cx.conn.id));
      return s.liveView.watch(cx.conn, p.on, p.video);
    },
    'computer.liveAck': (p, cx) => { if (cx.conn) s.liveView.ack(cx.conn.id, p.seq); return { ok: true as const }; },
    'computer.liveKey': (_p, cx) => { if (cx.conn) s.liveView.needKey(cx.conn.id); return { ok: true as const }; },
    'computer.control': (p, cx) => {
      if (!cx.conn) throw new RpcError('unavailable', 'Taking control needs a connection of its own');
      controlAware.add(cx.conn);
      const key = controlKey(cx.conn.id);
      if (!p.on) {
        s.computer.releaseControl(key);
        return { ok: true as const, control: s.computer.control.current(), mine: false };
      }
      const device = cx.deviceId ? s.devices.get(cx.deviceId) : undefined;
      const control = s.computer.takeControl({ key, name: device?.name || ctx.deps.hostName || 'Someone', via: 'live' });
      return { ok: true as const, control, mine: true };
    },
    'computer.liveInput': (p, cx) => {
      // a connection that never used Take control is a phone from before it (store builds up to 2026.11.01): its input
      // takes control while nobody holds it, as it did before control existed
      const legacy = cx.conn && !controlAware.has(cx.conn) ? { name: (cx.deviceId ? s.devices.get(cx.deviceId)?.name : undefined) || 'A phone' } : undefined;
      return s.liveView.input(p, cx.conn?.id, legacy);
    },
    'computer.requestPermissions': () => s.computer.requestPermissions(),
    'computer.openSettings': (p) => s.computer.openSettings(p.pane),

    'skills.list': (p) => s.skills.list(p.botId),
    'skills.get': (p) => s.skills.get(p.botId, p.name),
    'skills.save': (p) => s.skills.save(p.botId, p.name, p.description, p.body),
    'skills.delete': (p) => s.skills.delete(p.botId, p.name),
    'skills.getShared': (p) => s.botBundle.sharedSkill(p.name),
    'teach.start': (p) => s.teach.start(p.botId, p.name, p.goal),
    'teach.stop': (p) => s.teach.stop(p.id, p.cancel),
    'teach.status': () => s.teach.status(),
    'teach.support': () => s.teach.support(),
    'teach.input': (p) => s.teach.viewerInput(p),

    'routines.list': () => s.routines.list(),
    'routines.create': (p) => {
      const routine = s.routines.create(p);
      s.analytics.capture('routine_created', { deliver_to: routine.deliverTo });
      return routine;
    },
    'routines.update': (p) => s.routines.update(p.id, p.patch),
    'routines.delete': (p) => s.routines.delete(p.id),
    'routines.runNow': (p) => s.routines.run(p.id),

    'groups.list': () => s.groups.list(),
    'groups.create': (p) => s.groups.create(p),
    'groups.update': (p) => s.groups.update(p.id, p.patch),
    'groups.delete': (p) => s.groups.delete(p.id),
    'groups.history': (p) => s.groups.history(p.id, { chatId: p.chatId, before: p.before, limit: p.limit }),
    'groups.newChat': (p) => s.groups.newChat(p.id),
    'groups.useChat': (p) => s.groups.useChat(p.id, p.chatId),
    'groups.restore': (p) => s.groups.restore(p),
    'groups.send': (p, cx) => s.groups.send(p, cx.role === 'owner' ? 'desktop' : 'mobile'),
    'groups.stop': (p) => s.groups.stop(p.id),
    'groups.goal': (p) => s.groups.goalAct(p.id, p.chatId, p.action),

    'channels.list': () => s.channels.list(),
    'channels.configure': (p) => s.channels.configure(p),
    'channels.add': (p) => {
      const channel = s.channels.add(p);
      s.analytics.capture('telegram_added');
      return channel;
    },
    'channels.remove': (p) => s.channels.remove(p.id),

    'apps.status': (_p, cx) => appsOf(cx).status(),
    'apps.signIn': (p, cx) => appsOf(cx).signIn(p.redirectUri),
    'apps.finishSignIn': async (p, cx) => ({ ok: await appsOf(cx).finishSignIn(p), status: appsOf(cx).status() }),
    'apps.signOut': (_p, cx) => appsOf(cx).signOut(),
    'apps.catalog': (p, cx) => appsOf(cx).catalog(p),
    'apps.connections': (_p, cx) => appsOf(cx).connections(),
    'apps.connect': (p, cx) => appsOf(cx).connect(p.slug, p.open === 'caller'),
    'apps.disconnect': (p, cx) => appsOf(cx).disconnect(p.connectedAccountId, p.slug),
    'apps.setDefault': (p, cx) => appsOf(cx).setDefault(p.connectedAccountId, p.slug),

    'devices.list': () => s.devices.list(),
    'devices.revoke': (p, cx) => {
      // a team member's phone (full) may remove its own devices, never an admin's or another member's; admins (owner) any
      if (cx.role === 'full' && cx.member && s.devices.memberOf(p.id) !== cx.member) throw new RpcError('forbidden', 'Only an admin can remove another person’s device.');
      return s.devices.revoke(p.id);
    },
    'devices.rename': (p) => s.devices.rename(p.id, p.name),
    'devices.setPush': (p, cx) => {
      if (!cx.presence) throw new RpcError('forbidden', 'Only a paired phone gets notifications from here');
      return s.devices.setPush(cx.deviceId, p.push, p.turnOn);
    },
    'devices.setNotifications': (p) => s.devices.setNotifications(p.id, p.on),
    'devices.presence': (p, cx) => {
      cx.presence?.(p.foreground, p.desk);
      return { ok: true as const };
    },
    'pairing.start': (p) => s.devices.startPairing(p.ttlSec),
    'connect.status': () => s.connect.info(),
    'connect.set': (p) => s.connect.set(p.enabled),
    'connect.reset': () => s.connect.reset(),
    'pairing.cancel': () => s.devices.cancelPairing(),

    'files.list': (p) => s.files.list({ threadId: p.threadId, limit: p.limit }),
    'files.open': (p) => s.files.open(p.id),
    'files.pageView': (p) => s.files.pageView(p.id),
    'files.sendToDevices': (p, cx) => s.files.sendToDevices(p.path, p.caption, cx.agent?.threadId ?? p.threadId),

    'agent.ask': (p, cx) => s.agentBridge.ask(agentCtx(cx), p.question, p.options, p.timeoutSec),
    'agent.askForm': (p, cx) => s.agentBridge.askForm(agentCtx(cx), p),
    'agent.say': (p, cx) => {
      const text = p.text.trim();
      const { messageId } = s.chat.say(agentCtx(cx).threadId, text);
      s.channels.said(messageId, text);
      return { ok: true as const };
    },
    'agent.notify': (p, cx) => s.agentBridge.notify(agentCtx(cx), p.title, p.body),
    'agent.apps.search': (p, cx) => botApps(cx).search(agentCtx(cx).botId, p.queries),
    'agent.apps.schemas': (p, cx) => botApps(cx).schemas(agentCtx(cx).botId, p.tool_slugs),
    'agent.apps.execute': (p, cx) => botApps(cx).execute(agentCtx(cx).botId, p),
    'agent.apps.request': (p, cx) => botApps(cx).request(agentCtx(cx), p),
    'agent.telegram.request': (p, cx) => s.channels.request(agentCtx(cx), p),
    'agent.sendFile': (p, cx) => s.agentBridge.sendFile(agentCtx(cx), p.path, p.caption),
    'agent.showPage': (p, cx) => s.agentBridge.showPage(agentCtx(cx), p.title, p.html),
    'agent.transcribe': (p, cx) => s.agentBridge.transcribe(agentCtx(cx), p.path, p.language),
    'agent.speak': (p, cx) => s.agentBridge.speak(agentCtx(cx), p),
    'agent.remember': (p, cx) => s.agentBridge.remember(agentCtx(cx), p.text),
    'agent.memory.read': (_p, cx) => s.agentBridge.readMemory(agentCtx(cx)),
    'agent.memory.update': (p, cx) => s.agentBridge.updateMemory(agentCtx(cx), p.find, p.text),
    'agent.memory.forget': (p, cx) => s.agentBridge.forgetMemory(agentCtx(cx), p.text),
    'agent.saveSkill': (p, cx) => s.agentBridge.saveSkill(agentCtx(cx), p.name, p.description, p.body),
    'agent.context': (_p, cx) => s.agentBridge.context(agentCtx(cx)),
    'agent.bots.list': (_p, cx) => s.agentBridge.listBots(agentCtx(cx)),
    'agent.bots.get': (p, cx) => s.agentBridge.getBot(agentCtx(cx), p.id),
    'agent.bots.update': (p, cx) => s.agentBridge.updateBot(agentCtx(cx), p.id, p.patch),
    'agent.bots.history': (p, cx) => s.agentBridge.botHistory(agentCtx(cx), p.id, p.before, p.limit),
    'agent.bots.create': (p, cx) => s.agentBridge.createBot(agentCtx(cx), p),
    'agent.routines.list': (p, cx) => s.agentBridge.listRoutines(agentCtx(cx), p.botId),
    'agent.routines.create': (p, cx) => s.agentBridge.createRoutine(agentCtx(cx), p),
    'agent.routines.update': (p, cx) => s.agentBridge.updateRoutine(agentCtx(cx), p.id, p.patch),
    'agent.routines.delete': (p, cx) => s.agentBridge.deleteRoutine(agentCtx(cx), p.id),
    'agent.bots.message': (p, cx) => s.agentBridge.messageBot(agentCtx(cx), p),
    'agent.bots.broadcast': (p, cx) => s.agentBridge.broadcast(agentCtx(cx), p),
    'agent.groups.list': (_p, cx) => s.agentBridge.listGroups(agentCtx(cx)),
    'agent.groups.post': (p, cx) => s.agentBridge.postToGroup(agentCtx(cx), p.group, p.text),
    'agent.goal.start': (p, cx) => s.agentBridge.startGoal(agentCtx(cx), p),
    'agent.goal.finish': (p, cx) => s.agentBridge.finishGoal(agentCtx(cx), p),
    'agent.groups.create': (p, cx) => s.agentBridge.createGroup(agentCtx(cx), p),
    'agent.vault.list': (p, cx) => s.vault.agentList(agentCtx(cx), p.kind),
    'agent.vault.fill': (p, cx) => s.vault.fill(agentCtx(cx), p),
    'agent.vault.key': (p, cx) => s.vault.key(agentCtx(cx), p.id),
    'agent.mac.list': (p, cx) => s.macFiles.agentList(agentCtx(cx), p.path),
    'agent.mac.find': (p, cx) => s.macFiles.agentFind(agentCtx(cx), p.query, p.path),
    'agent.mac.fetch': (p, cx) => s.macFiles.agentFetch(agentCtx(cx), p.path),
    'agent.mac.put': (p, cx) => s.macFiles.agentPut(agentCtx(cx), p),
    'agent.vault.request': (p, cx) => s.vault.request(agentCtx(cx), p),
    'agent.react': (p, cx) => s.agentBridge.react(agentCtx(cx), p.emoji, p.messageId),

    'settings.get': () => s.settings.get(),
    'settings.update': (p) => s.settings.update(p),
    'system.info': () => s.system.info(),
    'system.openPath': (p) => s.system.openPath(p.path),
    'system.ping': () => s.system.ping(),
    'system.testNotification': () => s.notifications.test(),
    'system.openNotificationSettings': () => s.notifications.openSettings(),
    'system.notificationAccess': () => s.notifications.access(),
    'system.requestNotifications': () => s.notifications.request(),
    'promo.start': () => s.promo.begin(),
    'promo.dismiss': () => s.promo.dismiss(),
    'promo.use': (p) => s.promo.useBot(p.botId, p.on),
    'system.checkForUpdate': () => s.appUpdate.check(),
    'system.installUpdate': () => s.appUpdate.install(),
    'usage.summary': (p) => s.usage.summary(p.range, p.scope),
    'storage.summary': () => s.storage.summary(),
    'storage.clean': () => s.storage.clean(),

    // the first switch-on asks for the Mac's password, so only the Mac itself can do that part
    'power.setLidClosed': (p, cx) => s.power.setLidClosed(p.on, { forgetRule: p.forgetRule, onMac: cx.role === 'owner' }),

    // AppuBot Cloud: the Mac's account (owner only, see checkRole) and the cloud computer's export
    'cloudAccount.status': (p) => s.cloudAccount.status(p.refresh),
    'cloudAccount.signIn': () => s.cloudAccount.startSignIn(),
    'cloudAccount.finishSignIn': (p) => s.cloudAccount.finishSignIn(p),
    'cloudAccount.signOut': () => s.cloudAccount.signOut(),
    'cloudAccount.checkout': (p) => s.cloudAccount.checkout(p),
    'cloudAccount.portal': (p) => s.cloudAccount.portal(p.team),
    'cloudAccount.accountPage': (p) => s.cloudAccount.accountPage(p.team),
    'cloudAccount.previewPlanChange': (p) => s.cloudAccount.previewPlanChange(p),
    'cloudAccount.changePlan': (p) => s.cloudAccount.changePlan(p),
    'cloudAccount.cancelPlanChange': (p) => s.cloudAccount.cancelPlanChange(p.team),
    'cloudAccount.pair': (p) => s.cloudAccount.pair(p.team),
    'cloudAccount.devices': (p) => s.cloudAccount.devices(p.team),
    'cloudAccount.removeDevice': (p) => s.cloudAccount.removeDevice(p.id, p.team),
    'cloudAccount.connection': (p) => s.cloudAccount.connection(p.team),
    'cloudAccount.cacheGet': (p) => s.cloudAccount.cacheGet(p.team),
    'cloudAccount.cacheSet': (p) => s.cloudAccount.cacheSet(p.team, p.data),
    'cloudAccount.pageGet': (p) => s.cloudAccount.pageGet(p.team, p.id),
    'cloudAccount.pageSet': (p) => s.cloudAccount.pageSet(p.team, p.id, p.html),
    'cloudAccount.desktopLink': (p) => s.cloudAccount.desktopLink(p.team),
    'cloudAccount.start': (p) => s.cloudAccount.start(p.team),
    'cloudAccount.notices': (p) => s.cloudAccount.notices(p.after, p.team),
    'cloudAccount.accessLog': (p) => s.cloudAccount.accessLog(p.team),
    'cloudAccount.exportStart': (p) => s.cloudAccount.exportStart(p.team),
    'cloudAccount.team': (p) => s.cloudAccount.team(p.team),
    'cloudAccount.invite': (p) => s.cloudAccount.invite(p.team, p.email, p.role),
    'cloudAccount.resendInvite': (p) => s.cloudAccount.resendInvite(p.team, p.inviteId),
    'cloudAccount.revokeInvite': (p) => s.cloudAccount.revokeInvite(p.team, p.inviteId, { ...(p.dropSeat ? { dropSeat: true } : {}) }),
    'cloudAccount.setMemberRole': (p) => s.cloudAccount.setMemberRole(p.team, p.memberId, p.role),
    'cloudAccount.removeMember': (p) => s.cloudAccount.removeMember(p.team, p.memberId, { ...(p.dropSeat ? { dropSeat: true } : {}) }),
    'cloudAccount.renameTeam': (p) => s.cloudAccount.renameTeam(p.team, p.name),
    'cloudAccount.setTeamLogins': (p) => s.cloudAccount.setTeamLogins(p.team, p.logins),
    'cloudAccount.leaveTeam': (p) => s.cloudAccount.leaveTeam(p.team),
    'cloudAccount.acceptInvite': (p) => s.cloudAccount.acceptInvite({ inviteId: p.inviteId }),
    'cloudAccount.declineInvite': (p) => s.cloudAccount.declineInvite(p.inviteId),
    'cloudAccount.backups': (p) => s.cloudAccount.backups(p.team),
    'cloudAccount.repair': (p) => s.cloudAccount.repair(p),
    'cloud.export': async () => {
      if (!ctx.deps.cloud) throw new RpcError('unsupported', 'Download my bots is for an AppuBot Cloud computer; this computer’s files are on its own disk.');
      const r = await s.cloudExport.export();
      return { fileId: r.id, name: r.name, size: r.size };
    },

    'voice.status': () => s.voice.status(),
    'voice.models.download': (p) => s.voice.download(p.id),
    'voice.models.cancel': (p) => s.voice.cancel(p.id),
    'voice.models.remove': (p) => s.voice.remove(p.id),
    'voice.prepare': (p) => s.voice.prepare(p.only),
    'voice.transcribe': async (p) => {
      const audio = Buffer.from(p.audio, 'base64');
      const r = await s.voice.transcribe({ audio: new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength), format: p.format, mimeType: p.mimeType, language: p.language });
      if (!p.keep) return r;
      // the recording as a file (never copied into a bot's inbox: the bot gets only the words); PCM is kept as
      // OGG/Opus (about 4 KB a second, an eighth of WAV), a compressed recording as it came
      const ogg = p.format === 'pcm16';
      const ext = p.format === 'ogg' || ogg ? 'ogg' : extForMime(p.mimeType);
      const mime = p.format === 'ogg' || ogg ? 'audio/ogg' : p.mimeType || 'application/octet-stream';
      const bytes = ogg ? encodeOggOpus(new Int16Array(audio.buffer, audio.byteOffset, audio.byteLength >> 1), VOICE_PCM_RATE) : new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength);
      const recording = s.files.upload(bytes, `voice-${new Date().toISOString().replace(/[:.]/g, '-')}.${ext}`, mime);
      return { ...r, recording };
    },
    'voice.warm': (p) => s.voice.warm(p.only),
    'voice.convert': (p) => s.voice.convert(p.fileId),
    'voice.speak': async (p) => {
      const o = { text: p.text, language: p.language, voice: p.voice, live: p.live };
      const out = (r: Awaited<ReturnType<typeof s.voice.speak>>) => ({ audio: Buffer.from(r.audio.buffer, r.audio.byteOffset, r.audio.byteLength).toString('base64'), mimeType: r.mimeType, durationMs: r.durationMs, language: r.language });
      // a reading kept on a message is OGG whatever was asked: every client plays it again
      if (p.threadId && p.messageId) {
        const r = await s.voice.speakForMessage(p.threadId, p.messageId, o);
        return { ...out(r), file: r.file };
      }
      return out(await s.voice.speak({ ...o, format: p.format }));
    },
  };
}

export function buildSnapshot(ctx: CoreCtx, role: Role): Snapshot {
  const s = ctx.s;
  const base = { computer: s.computer.status(), settings: s.settings.get(), system: s.system.info() };
  if (role === 'agent') {
    return { bots: [], threads: [], providers: [], pendingPermissions: [], devices: [], routines: [], channels: [], skills: [], ...base };
  }
  return {
    bots: s.bots.list(),
    threads: s.threads.list({ limit: 200 }),
    providers: s.providers.list(),
    pendingPermissions: s.chat.listPermissions(),
    devices: s.devices.list(),
    routines: s.routines.list(),
    groups: s.groups.list(),
    channels: s.channels.list(),
    skills: s.skills.list(),
    voice: s.voice.status(),
    characters: s.characters.list(),
    limits: s.limits.list(),
    ...base,
  };
}
