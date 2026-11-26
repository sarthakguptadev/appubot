import { z } from 'zod';
import {
  BotSchema, BotShape, ThreadSchema, GoalSchema, GOAL_TURNS_MAX, GOAL_HOURS_MAX, MessageSchema, PermissionRequestSchema, ProviderSchema, FoundProfileSchema, DeviceSchema, PairingInfoSchema, ConnectStatusSchema,
  ComputerStatusSchema, ScreenControlSchema, ComputerFrameSchema, LiveFrameSchema, LiveVideoSchema, LiveInputSchema, TeachInputSchema, SkillSchema, TeachSessionSchema, BotBundleManifestSchema, BotImportResultSchema, RoutineSchema, ChannelSchema, SettingsSchema, SystemInfoSchema, NotificationAccessSchema, AppUpdateStatusSchema, PromoStatusSchema,
  FileAttachmentSchema, PowerStatusSchema, RegistryAgentSchema, SessionModelSchema, ReactionSchema, ThreadStatus, Id, Timestamp, DevicePlatform, PushRegistrationSchema, PartSchema, ComputerActionSchema, AppsStatusSchema, AppToolkitSchema, AppCategorySchema, AppConnectionSchema, PROTOCOL_VERSION,
  VoiceStatusSchema, VOICE_SPEAK_MAX_CHARS, StorageSummarySchema, MessageRev, SlashCommandSchema, FormFieldSchema, FormValue, QuestionFormSchema,
} from './entities';
import { SpeechLanguage, SpeechVoice, VoiceModelId } from './voiceModels';
import { UsageRange, UsageScope, UsageSummarySchema } from './usage';
import { ProviderLimitsSchema } from './limits';
import { CHARACTER_BODY_MAX, CHARACTER_NAME_MAX, CHARACTER_PROMPT_MAX, CharacterDraftSchema, CharacterFaceSchema, CharacterSchema } from './characters';
import { EndpointKind, ModelEndpointSchema } from './endpoints';
import { BotExportIncludeSchema, BotExportIncludedSchema, ExportableSchema, SharedSkillTextSchema } from './transfer';
import { VAULT_SAVE_MANY_MAX, VaultItemFieldsSchema, VaultItemSchema, VaultKind, VaultSecretField } from './vault';
import { CloudGatewayEvents, CloudGatewayMethods } from './cloud';
import {
  GitLocalSchema, GitSetupParamsSchema, GitSetupSchema, LinkEntriesSchema, LinkPutSchema, MAC_LINK_FOLDERS_MAX, MAC_PUT_TEXT_MAX, MacFilesCheckSchema, MacFilesLinkParamsSchema,
  MacFilesStatusSchema, MacFolderSchema, MacLinkGrantSchema, MacLinkStatusSchema,
} from './carry';
import { GROUP_RESTORE_CHATS_MAX, GroupMessageSchema, GroupRestoreChatSchema, GroupSchema } from './groups';

/**
 * Patch schema for `*.update` methods: same (partial) type as `schema.partial()`, but with every `.default()`
 * stripped at runtime (recursively, nested objects partial too). Zod 4 applies defaults to missing keys even
 * inside `.partial()`, which would silently reset every field the caller did not send.
 */
function stripDefaults(s: z.ZodType): z.ZodType {
  if (s instanceof z.ZodDefault) return stripDefaults(s.unwrap() as z.ZodType);
  if (s instanceof z.ZodOptional) return stripDefaults(s.unwrap() as z.ZodType).optional();
  if (s instanceof z.ZodObject) {
    const shape = s.shape as Record<string, z.ZodType>;
    return z.object(Object.fromEntries(Object.entries(shape).map(([k, v]) => [k, stripDefaults(v).optional()])));
  }
  return s;
}
export function patchOf<T extends z.ZodObject>(schema: T): ReturnType<T['partial']> {
  return stripDefaults(schema) as unknown as ReturnType<T['partial']>;
}

/* =====================================================================
 * Wire envelope (WebSocket, JSON text frames)
 *  client -> server : connect | req
 *  server -> client : hello | res | event
 * ===================================================================== */

export const DeviceIdentitySchema = z.object({ id: Id, name: z.string(), platform: DevicePlatform, appVersion: z.string().optional() });
export type DeviceIdentity = z.infer<typeof DeviceIdentitySchema>;

/**
 * What one side of a connection can read beyond its protocol version, said in the connect frame (the client's) and the
 * hello (the server's); the other side only uses a feature its peer named, so none of them needs a protocol bump.
 * `batch`: several frames packed into one `{type: 'batch', items}` text frame, in order (server → client: events and
 * answers, AppuBot Connect's route coalesces them; client → server: requests made in the same tick).
 */
export const BATCH_FEATURE = 'batch';
export const GATEWAY_FEATURES: readonly string[] = [BATCH_FEATURE];
/** a batch carries at most this many frames (the server reads no more of a client's) */
export const BATCH_ITEMS_MAX = 256;
const Features = z.array(z.string().max(40)).max(32);

export const ConnectFrameSchema = z.object({
  type: z.literal('connect'),
  protocolVersion: z.number().default(PROTOCOL_VERSION),
  /** the oldest protocol the client still speaks (absent from clients that predate it: only its own) */
  minProtocolVersion: z.number().optional(),
  token: z.string(),
  device: DeviceIdentitySchema,
  /** resume: last event seq the client has seen (server replays if it can) */
  lastSeq: z.number().optional(),
  /** resume: the `bootId` of the hello `lastSeq` counts from (a restarted server numbers its events from 0 again) */
  bootId: z.string().max(100).optional(),
  /** what the client reads beyond its protocol (`GATEWAY_FEATURES`; absent from clients that predate it: none) */
  features: Features.optional(),
});
export type ConnectFrame = z.infer<typeof ConnectFrameSchema>;

export const SnapshotSchema = z.object({
  bots: z.array(BotSchema),
  threads: z.array(ThreadSchema),
  providers: z.array(ProviderSchema),
  pendingPermissions: z.array(PermissionRequestSchema),
  computer: ComputerStatusSchema,
  settings: SettingsSchema,
  system: SystemInfoSchema,
  devices: z.array(DeviceSchema),
  routines: z.array(RoutineSchema),
  channels: z.array(ChannelSchema),
  skills: z.array(SkillSchema),
  /** speech on this computer: which models are downloaded (absent from servers that predate it) */
  voice: VoiceStatusSchema.optional(),
  /** the custom characters bots can wear (absent from servers that predate them: no Generate or Import there) */
  characters: z.array(CharacterSchema).optional(),
  /** the agents' plan limits as last read (`providers.limits`; absent from servers that predate them) */
  limits: z.array(ProviderLimitsSchema).optional(),
  /** groups of bots (`groups.*`; absent from servers that predate them: no Groups there) */
  groups: z.array(GroupSchema).optional(),
});
export type Snapshot = z.infer<typeof SnapshotSchema>;

export const HelloFrameSchema = z.object({
  type: z.literal('hello'),
  ok: z.literal(true),
  serverVersion: z.string(),
  /** the server's own protocol */
  protocolVersion: z.number(),
  /** the oldest protocol the server still speaks (absent from servers that predate it: only its own) */
  minProtocolVersion: z.number().optional(),
  /** the protocol this connection speaks: the lower of the two sides' (absent from servers that predate it) */
  agreedProtocolVersion: z.number().optional(),
  deviceId: Id,
  role: z.enum(['owner', 'full', 'limited', 'agent']),
  seq: z.number(),
  /** this run of the server (random per launch): event seqs only mean something within one run */
  bootId: z.string().optional(),
  /**
   * a resume (`lastSeq`) that couldn't be replayed in full: the server restarted (another `bootId`) or no longer has
   * the events missed. What the client kept from before (messages streamed live) may be stale: fetch it again.
   */
  gap: z.boolean().optional(),
  /** what the server reads beyond its protocol (`GATEWAY_FEATURES`; absent from servers that predate it: none) */
  features: Features.optional(),
  snapshot: SnapshotSchema,
});
export const HelloErrorFrameSchema = z.object({
  type: z.literal('hello'), ok: z.literal(false), error: z.string(), code: z.enum(['unauthorized', 'protocol_mismatch', 'revoked', 'bad_connect']),
  /** `protocol_mismatch`: which side is too old and must update (absent from servers that predate it) */
  update: z.enum(['client', 'server']).optional(),
  /** `protocol_mismatch`: the server's protocol range and app version, so the client can say what to update */
  protocolVersion: z.number().optional(),
  minProtocolVersion: z.number().optional(),
  serverVersion: z.string().optional(),
});
export type HelloFrame = z.infer<typeof HelloFrameSchema> | z.infer<typeof HelloErrorFrameSchema>;

export const ReqFrameSchema = z.object({ type: z.literal('req'), id: z.string(), method: z.string(), params: z.unknown().optional() });
export const ResFrameSchema = z.object({ type: z.literal('res'), id: z.string(), ok: z.boolean(), result: z.unknown().optional(), error: z.object({ code: z.string(), message: z.string(), data: z.unknown().optional() }).optional() });
export const EventFrameSchema = z.object({ type: z.literal('event'), event: z.string(), payload: z.unknown(), seq: z.number() });
export type ReqFrame = z.infer<typeof ReqFrameSchema>;
export type ResFrame = z.infer<typeof ResFrameSchema>;
export type EventFrame = z.infer<typeof EventFrameSchema>;

/**
 * Several frames in one (`BATCH_FEATURE`, only to a peer that named it), handled in order as if each had come alone.
 * The server's carry events (each with its own `seq`, rising) and answers; a client's, requests.
 */
export const BatchFrameSchema = z.object({ type: z.literal('batch'), items: z.array(z.union([EventFrameSchema, ResFrameSchema])) });
export const ClientBatchFrameSchema = z.object({ type: z.literal('batch'), items: z.array(ReqFrameSchema).max(BATCH_ITEMS_MAX) });
export type BatchFrame = z.infer<typeof BatchFrameSchema>;

export const ClientFrameSchema = z.discriminatedUnion('type', [ConnectFrameSchema, ReqFrameSchema, ClientBatchFrameSchema]);
export const ServerFrameSchema = z.union([HelloFrameSchema, HelloErrorFrameSchema, ResFrameSchema, EventFrameSchema, BatchFrameSchema]);

/* =====================================================================
 * Methods: name -> { params, result }
 * ===================================================================== */
const Empty = z.object({}).default({});
/** `voice.warm` / `voice.prepare`: one half of voice alone (a computer from before strips the key and does both) */
const VoiceOnly = z.object({ only: z.enum(['voice', 'speech']).optional() }).default({});

/** where a page of history ends: the oldest message the caller has (see `threads.history`, `bots.history`) */
const HistoryCursor = z.object({ id: Id, createdAt: Timestamp, role: z.enum(['user', 'agent']) });

/** what a bot may change on itself or another bot (agent.bots.update); patchOf, so unsent fields stay as they are */
/**
 * What a bot may change of itself or another bot (`agent.bots.update`). `appsTurnOn`/`appsTurnOff` switch single apps
 * (Composio slugs) for that bot. What grants abilities (computer use or apps on, Bypass permissions, another agent)
 * and another bot's name/job/instructions wait for the user's "Allow" in the caller's chat.
 */
export const AgentBotPatch = patchOf(BotSchema.pick({
  name: true, color: true, shape: true, characterId: true, job: true, instructions: true, providerId: true, modelId: true, modeId: true, effort: true, fast: true, computerUse: true, chief: true,
})).extend({ appsTurnOn: z.array(z.string()).optional(), appsTurnOff: z.array(z.string()).optional() });
export const AgentBotSummarySchema = z.object({
  id: Id, name: z.string(), job: z.string(), providerId: Id, /** its agent as the apps name it ("Claude Code · Work") */ agent: z.string(), isYou: z.boolean(),
  status: ThreadStatus, lastMessagePreview: z.string().optional(),
  /** a chief: may message every bot at once and leads its groups */
  chief: z.boolean().default(false),
});
/** An agent a bot can run on (`patch.providerId`): installed and switched on. */
export const AgentChoiceSchema = z.object({ id: Id, name: z.string(), account: z.string().optional(), loggedIn: z.boolean() });
export const AgentBotDetailSchema = z.object({
  bot: BotSchema.omit({ autoApprove: true, emoji: true }),
  isYou: z.boolean(),
  /** its agent as the apps name it */
  agent: z.string(),
  /** models its agent offers (from its chat), for `patch.modelId` */
  models: z.array(SessionModelSchema),
  /** reasoning efforts of its current model, for `patch.effort` */
  efforts: z.array(SessionModelSchema).default([]),
  /** its current model offers fast mode, for `patch.fast` */
  fastAvailable: z.boolean().default(false),
  /** permission modes its agent offers, for `patch.modeId` */
  modes: z.array(z.object({ id: z.string(), name: z.string(), description: z.string().optional() })).default([]),
  /** agents it can run on, for `patch.providerId` */
  agents: z.array(AgentChoiceSchema).default([]),
  /** apps connected on this Mac and whether this bot may use each */
  apps: z.array(z.object({ slug: z.string(), name: z.string(), on: z.boolean() })).default([]),
  /** the agent new bots start on (Settings › General › Agent for new bots) */
  defaultAgentId: Id.optional(),
  /** the custom character it wears (instead of its shape), and the library's, for `patch.characterId` */
  character: z.object({ id: Id, name: z.string() }).optional(),
  characters: z.array(z.object({ id: Id, name: z.string() })).default([]),
});
export const AgentHistoryMessageSchema = z.object({
  id: Id, role: z.enum(['user', 'agent']), createdAt: Timestamp,
  via: z.enum(['desktop', 'mobile', 'routine', 'channel', 'system', 'bot']),
  /** the message as text: tool calls summarised in one line each, no images or file contents */
  text: z.string(),
});

/** Longest page HTML a bot may send with `show_page` (its built-in images come on top). */
export const PAGE_HTML_MAX = 1_000_000;

/** An agent's CLI login run on this computer for a device elsewhere (`providers.deviceLogin.*`): what to show and do. */
export const DeviceLoginSchema = z.object({
  id: Id,
  methodId: z.string().optional(),
  /** `waiting`: the user has to act on `url`/`code`/`prompt`; `done`: signed in; `failed`: see `message` */
  state: z.enum(['starting', 'waiting', 'done', 'failed']),
  /** the link to open (on any device) */
  url: z.string().optional(),
  /** the one-time code to enter on that page (Codex's device code) */
  code: z.string().optional(),
  /** the login waits for a code to be pasted back here (`providers.deviceLogin.code`): the prompt's own words */
  prompt: z.string().optional(),
  message: z.string().optional(),
  startedAt: Timestamp,
  /** when the code stops working, if the CLI said */
  expiresAt: Timestamp.optional(),
  /**
   * The sign-in comes back to this computer (`http://localhost:<port><path>?code=…`, where the agent listens): a device
   * that can listen on that port itself (the desktop app) opens `url` in its own browser, catches the return and sends
   * its address with `providers.deviceLogin.finish`; any other device may paste the address its browser ended on (the
   * page that didn't load). Absent from computers from before (they never ask for `finish`).
   */
  relay: z.object({ url: z.string(), port: z.number().int().min(1).max(65535), path: z.string() }).optional(),
});
export type DeviceLogin = z.infer<typeof DeviceLoginSchema>;

/** what `vault.save` takes: an item's fields, and the secrets to set (left out: kept; '': cleared) */
const VaultSaveSchema = VaultItemFieldsSchema.extend({
  id: Id.optional(), kind: VaultKind,
  secrets: z.object({ password: z.string().max(1000), number: z.string().max(40), cvc: z.string().max(8), key: z.string().max(8192) }).partial().optional(),
});

export const Methods = {
  /* bots */
  'bots.list': { params: Empty, result: z.array(BotSchema) },
  /**
   * `greet`: the new bot speaks first: it says hello and asks what you'd like it to do and how (a turn with no user
   * message). Only the bot editors send it; a create without it starts nothing. `fast` unsent is `settings.defaultFast`.
   */
  'bots.create': { params: BotSchema.pick({ name: true, emoji: true, color: true, shape: true, characterId: true, job: true, instructions: true, providerId: true, modelId: true, modeId: true, effort: true, computerUse: true, autoApprove: true, appsOff: true, chief: true }).partial({ emoji: true, color: true, shape: true, characterId: true, job: true, instructions: true, modelId: true, modeId: true, effort: true, computerUse: true, autoApprove: true, appsOff: true, chief: true }).extend({ greet: z.boolean().optional(), /** unsent: Settings' `defaultFast` (no default here, so that can apply) */ fast: z.boolean().optional() }), result: BotSchema },
  /** `patch.appsOff` replaces the bot's whole list of apps turned off (see `appsOn`) */
  'bots.update': { params: z.object({ id: Id, patch: patchOf(BotSchema.omit({ id: true, createdAt: true })) }), result: BotSchema },
  'bots.delete': { params: z.object({ id: Id, deleteWorkspace: z.boolean().default(false) }), result: z.object({ ok: z.literal(true) }) },
  /**
   * Moving a bot between computers (this Mac and your AppuBot computer, either way): `export` packs one bot into a zip
   * of this computer's files (`/files/<id>?download=1`), which the device carries to the other computer (`POST
   * /api/files`) and `import`s there. Secrets never travel (see `BotBundleManifestSchema`).
   */
  'bots.export': {
    params: z.object({
      id: Id,
      /** only these parts (Settings › Transfer); absent = the whole bot */
      include: BotExportIncludeSchema.optional(),
      /** this computer's shared skills (`bots.exportable`) to add to the bot's own, by name (its own win a clash) */
      sharedSkills: z.array(z.string()).max(200).optional(),
    }),
    /** `included`: what was packed (a computer from before ignores `include` and says nothing: everything went in) */
    result: z.object({ file: FileAttachmentSchema, manifest: BotBundleManifestSchema, included: BotExportIncludedSchema.optional() }),
  },
  /** what a transfer could carry from this computer: each bot part by part with sizes, and its shared skills */
  'bots.exportable': { params: Empty, result: ExportableSchema },
  'bots.import': { params: z.object({ fileId: Id, /** the bot's name here (default: as it was) */ name: z.string().optional(), /** keep its routines running here (default on) */ routines: z.boolean().optional() }), result: BotImportResultSchema },
  /**
   * A bot's memory (MEMORY.md in its folder): what it keeps across its threads. Every new agent session starts with it
   * (the newest part when it is long, see `MEMORY_LOAD_MAX`).
   */
  'bots.memory.get': { params: z.object({ id: Id }), result: z.object({ memory: z.string(), path: z.string() }) },
  /** Replaces the whole memory; a blank one clears it (a fresh file). Sessions already running aren't restarted. */
  'bots.memory.set': { params: z.object({ id: Id, memory: z.string() }), result: z.object({ ok: z.literal(true) }) },
  /**
   * All of a bot's threads as one history (Telegram chats aside), a page at a time from the newest backwards, in
   * conversation order (`compareMessages` in chat-core): what phones on older builds show, and what a bot reads with
   * `read_bot_history`. The apps show one thread at a time (`threads.history`). `before` is the oldest message the
   * caller has; `since` also returns everything from that time on (capped at 1000).
   */
  'bots.history': {
    params: z.object({
      id: Id,
      before: HistoryCursor.optional(),
      limit: z.number().int().min(1).max(500).default(100),
      since: Timestamp.optional(),
    }),
    result: z.object({ messages: z.array(MessageSchema), hasMore: z.boolean() }),
  },

  /*
   * characters: the library of custom characters bots can wear (`Bot.characterId`), on the computer, shared by all
   * bots. Computers that predate them answer `unknown_method` (and send no `characters` in the snapshot).
   */
  'characters.list': { params: Empty, result: z.array(CharacterSchema) },
  /**
   * Draw new characters from a description with the user's own agent (`providerId`, else `botId`'s, else the agent for
   * new bots): a hidden one-off session that nobody sees in a chat, no tools; up to about 90 s. Returns a few
   * candidates to pick from (none saved: `characters.save` keeps the one picked). `requestId` names it for
   * `characters.cancel`.
   */
  'characters.generate': {
    params: z.object({ prompt: z.string().trim().min(1).max(CHARACTER_PROMPT_MAX), providerId: Id.optional(), modelId: z.string().max(200).optional(), botId: Id.optional(), requestId: z.string().max(64).optional() }),
    result: z.object({ candidates: z.array(CharacterDraftSchema), providerId: Id }),
  },
  /** Stop a generation this device started (`requestId`; unsent: all of them). */
  'characters.cancel': { params: z.object({ requestId: z.string().max(64).optional() }).default({}), result: z.object({ ok: z.literal(true) }) },
  /** Keep a character in the library (validated and normalized again here; the face found when unsent). */
  'characters.save': {
    params: z.object({ name: z.string().max(200), body: z.string().min(1).max(CHARACTER_BODY_MAX), face: CharacterFaceSchema.partial().optional(), source: z.enum(['generated', 'imported']) }),
    result: CharacterSchema,
  },
  'characters.rename': { params: z.object({ id: Id, name: z.string().min(1).max(CHARACTER_NAME_MAX * 2) }), result: CharacterSchema },
  /** Remove it from the library; the bots that wore it go back to their shapes (`bots` of them). */
  'characters.delete': { params: z.object({ id: Id }), result: z.object({ ok: z.literal(true), bots: z.number().int() }) },

  /*
   * threads: a bot's conversations, each with an agent session of its own (resumed across restarts). Its current
   * thread (`currentChat`) takes turns that name no thread; a new one (`threads.start`) begins a fresh session that
   * knows only the bot's memory, which is what carries over. Telegram chats are threads of their own.
   */
  'threads.list': { params: z.object({ botId: Id.optional(), limit: z.number().default(100) }).default({ limit: 100 }), result: z.array(ThreadSchema) },
  /** kept for phones on older builds: returns the bot's current thread (made on first use), never a new one */
  'threads.create': { params: z.object({ botId: Id, title: z.string().optional(), cwd: z.string().optional() }), result: ThreadSchema },
  /**
   * A new thread for the bot, now its current one: its first turn starts a brand-new agent session (no resume, none
   * of the earlier conversation; the bot's memory comes along). While the current thread has no messages yet it is
   * returned instead. The thread it replaces, when its agent is idle, is asked in the background what to remember
   * (nothing of that shows in its chat), then its agent is let go (a later message there resumes it).
   */
  'threads.start': { params: z.object({ botId: Id }), result: ThreadSchema },
  /** One thread's messages, a page at a time from the newest backwards (conversation order); `before` is the oldest the caller has. */
  'threads.history': {
    params: z.object({ id: Id, before: HistoryCursor.optional(), limit: z.number().int().min(1).max(500).default(100) }),
    result: z.object({ messages: z.array(MessageSchema), hasMore: z.boolean() }),
  },
  'threads.get': { params: z.object({ id: Id }), result: z.object({ thread: ThreadSchema, messages: z.array(MessageSchema) }) },
  /**
   * a thread's slash commands: a paired device's thread lists, hello and `thread.*` events leave them out (`leanThread`:
   * ~11 KB per thread, the same for every thread of an agent), so it asks for the open thread's when it needs them
   */
  'threads.commands': { params: z.object({ id: Id }), result: z.object({ commands: z.array(SlashCommandSchema) }) },
  'threads.messages': { params: z.object({ id: Id, before: Timestamp.optional(), limit: z.number().default(200) }), result: z.array(MessageSchema) },
  'threads.rename': { params: z.object({ id: Id, title: z.string() }), result: ThreadSchema },
  'threads.delete': { params: z.object({ id: Id }), result: z.object({ ok: z.literal(true) }) },
  'threads.setMode': { params: z.object({ id: Id, modeId: z.string() }), result: ThreadSchema },
  'threads.setModel': { params: z.object({ id: Id, modelId: z.string() }), result: ThreadSchema },
  /** Also becomes the bot's own `effort` (its next chats start with it). */
  'threads.setEffort': { params: z.object({ id: Id, effortId: z.string() }), result: ThreadSchema },
  /** Fast mode on/off (only where the thread's model offers it); also becomes the bot's own `fast`. */
  'threads.setFast': { params: z.object({ id: Id, fast: z.boolean() }), result: ThreadSchema },
  /** a thread's goal: pause or resume it, stop it, or clear a finished one away */
  'threads.goal': { params: z.object({ id: Id, action: z.enum(['pause', 'resume', 'stop', 'clear']) }), result: ThreadSchema },
  /**
   * Start a thread's agent now, without a message, so its models and modes (the composer's pickers) arrive before the
   * first turn: `threadId`, else the bot's current thread (made if it has none). Does nothing when it has them.
   */
  /**
   * `session`: start it even when it has them, so the next turn doesn't wait for the agent to start (voice mode); a
   * thread whose agent is up already is left alone.
   */
  'threads.warm': { params: z.object({ botId: Id, threadId: Id.optional(), session: z.boolean().optional() }), result: z.object({ ok: z.literal(true) }) },

  /* chat */
  /**
   * Message a bot. `threadId` continues that thread, which becomes the bot's current one (`Thread.lastActiveAt`);
   * without it the turn goes to the bot's current thread (`threads.chatFor`, made on first use).
   */
  'chat.send': {
    params: z.object({
      botId: Id.optional(), threadId: Id.optional(),
      text: z.string(), attachments: z.array(FileAttachmentSchema.pick({ id: true })).default([]), images: z.array(z.object({ mimeType: z.string(), data: z.string() })).default([]),
      /**
       * A spoken message: `text` is what `voice.transcribe` heard, `recordingId` the recording it kept (`keep`) or one
       * uploaded (`POST /api/files`). The message carries it as a `voice` part for replay; the bot gets only the text,
       * and from the app (not Telegram) a line saying it was said in a live conversation, so it answers to be heard.
       */
      voice: z.object({ recordingId: Id, durationMs: z.number().nonnegative() }).optional(),
      /**
       * The sending device's own id for this message (a phone's local copy): sent again after a dropped connection, the
       * same message comes back instead of a second one, and the message carries it so the device knows its copy.
       */
      clientId: z.string().max(100).optional(),
    }).refine((p) => !!(p.botId || p.threadId), { message: 'botId or threadId is required' }),
    result: z.object({ userMessage: MessageSchema, agentMessageId: Id }),
  },
  /**
   * Stop: the running turn ends and so does every message waiting behind it. `keepQueued`: only the running turn ends,
   * and what waits behind it runs next (the chat's "Stop and read now" under a message a busy bot hasn't read yet);
   * with nothing waiting it does nothing.
   */
  'chat.cancel': { params: z.object({ threadId: Id, keepQueued: z.boolean().optional() }), result: z.object({ ok: z.literal(true) }) },
  /** `clientId`: as for `chat.send`, an answer sent again after a dropped connection is taken once (and answers ok) */
  'chat.answer': { params: z.object({ questionId: Id, answer: z.string(), clientId: z.string().max(100).optional() }), result: z.object({ ok: z.literal(true) }) },
  /**
   * Fill in a form card (`QuestionPart.form`): `values` by field id; a Vault card instead may pick an item already saved
   * (`savedId`). `decline` turns it down. A Vault card's secrets are only taken from this computer's window and the
   * owner's devices (as `vault.save`'s). Older apps answer a form with `chat.answer` (its words), which a Vault card refuses.
   */
  'chat.answerForm': {
    params: z.object({ questionId: Id, values: z.record(z.string(), FormValue).default({}), savedId: Id.optional(), decline: z.boolean().optional(), clientId: z.string().max(100).optional() }),
    result: z.object({ ok: z.literal(true) }),
  },
  /** the user's reaction on a message (a bot's reply), `null` takes it back; the bot hears about it on its next turn */
  'chat.react': { params: z.object({ threadId: Id, messageId: Id, emoji: z.string().min(1).max(16).nullable() }), result: z.object({ ok: z.literal(true) }) },

  /* permissions */
  'permissions.list': { params: Empty, result: z.array(PermissionRequestSchema) },
  'permissions.respond': { params: z.object({ id: Id, optionId: z.string() }), result: z.object({ ok: z.literal(true) }) },

  /* providers */
  'providers.list': { params: Empty, result: z.array(ProviderSchema) },
  /**
   * The models and reasoning efforts an agent offers: from its latest chat, else read from a short session of its own
   * (agents only list them in a session; cached for a while). For the model and effort pickers.
   */
  'providers.choices': { params: z.object({ id: Id }), result: z.object({ models: z.array(SessionModelSchema), efforts: z.array(SessionModelSchema), modes: z.array(SessionModelSchema).default([]) }) },
  /**
   * The agents' plan limits (protocol `limits.ts`): what was last read, read again where `stale` (over 5 min old) or
   * `force`d (the Refresh button). `ids` narrows it. A `limited` phone gets the windows without the plan's name.
   */
  'providers.limits': { params: z.object({ ids: z.array(Id).optional(), refresh: z.enum(['stale', 'force']).optional() }).default({}), result: z.object({ limits: z.array(ProviderLimitsSchema) }) },
  /**
   * re-checks install, version and login; `ids` limits it to some providers (the result is always the whole list).
   * `signIn`: an agent with no login check of its own (the ACP registry's) is started once to see whether its login works.
   */
  'providers.refresh': { params: z.object({ ids: z.array(Id).optional(), signIn: z.boolean().optional() }).default({}), result: z.array(ProviderSchema) },
  'providers.upsert': { params: ProviderSchema.pick({ id: true, name: true, description: true, command: true, args: true, env: true, icon: true, enabled: true, installHint: true }).partial({ description: true, args: true, env: true, icon: true, enabled: true, installHint: true }), result: ProviderSchema },
  'providers.delete': { params: z.object({ id: Id }), result: z.object({ ok: z.literal(true) }) },
  /** `terminal`: the install line was opened in a terminal window, to finish there; else the install ran here and is over */
  'providers.install': { params: z.object({ id: Id }), result: z.object({ ok: z.boolean(), output: z.string(), terminal: z.boolean().optional() }) },
  /**
   * The ACP registry's agents that can run on this Mac, cached on the Mac (`refresh` fetches it again). `error` when
   * it could not be fetched (the last copy, if any, still comes back).
   */
  'providers.registry': {
    params: z.object({ refresh: z.boolean().optional() }).default({}),
    result: z.object({ agents: z.array(RegistryAgentSchema), fetchedAt: Timestamp.optional(), error: z.string().optional() }),
  },
  /**
   * Adds a registry agent as an agent of its own (or updates one added before to the registry's version): downloads
   * and checks its build when it ships one, then starts it once to learn its logins. Owner only.
   */
  'providers.addFromRegistry': { params: z.object({ id: z.string() }), result: ProviderSchema },
  'providers.authenticate': { params: z.object({ id: Id, methodId: z.string().optional() }), result: z.object({ ok: z.boolean(), message: z.string().optional() }) },
  /**
   * Saves the keys a login asks for (`authMethods[].vars`: an API key…) where only this user can read them, then signs
   * in with them: `authenticate` for an `agent` login, a short session for an `env_var` one. Owner only.
   */
  'providers.setKeys': {
    params: z.object({ id: Id, methodId: z.string(), values: z.record(z.string(), z.string().max(4096)) }),
    result: z.object({ ok: z.boolean(), message: z.string().optional() }),
  },
  /** forgets the keys saved for an agent (owner only) */
  'providers.clearKeys': { params: z.object({ id: Id }), result: z.object({ ok: z.literal(true) }) },
  /**
   * Looks for newer versions of the agents' CLIs (npm's `latest`, the ACP registry); results are cached for a few
   * hours, this call always fetches again. `ids` limits it to some providers (the result is always the whole list).
   */
  'providers.checkUpdates': { params: z.object({ ids: z.array(Id).optional() }).default({}), result: z.array(ProviderSchema) },
  /**
   * Updates an agent to `latestVersion` (`Provider.update.command`, or the registry's new build), then re-checks it.
   * Resolves when done (can take minutes); `provider.updated` shows it running meanwhile. Owner only.
   */
  'providers.update': { params: z.object({ id: Id }), result: z.object({ ok: z.boolean(), output: z.string(), message: z.string().optional() }) },
  /** signs the CLI out on this Mac (only when `Provider.canLogOut`), then re-checks it */
  'providers.logout': { params: z.object({ id: Id }), result: z.object({ ok: z.boolean(), message: z.string().optional() }) },
  /**
   * A sign-in run on this computer for a device that can't type into its terminal (a phone on an AppuBot Cloud
   * computer): the agent's own CLI login runs here, and what it prints (a link to open, a code to enter there, or a
   * prompt to paste a code into) comes back as `DeviceLogin`; `provider.login` events follow it. Codex: `codex login
   * --device-auth` (link + one-time code). Claude Code: `claude setup-token` under a pseudo-terminal, which prints a
   * link and asks for the code pasted back (`providers.deviceLogin.code`); a token from any computer goes through
   * `providers.setKeys` instead. One at a time per agent; `cancel` ends it. Phones and the window alike. `here`: the
   * sign-in is for this computer's own window (Settings › Agents on it): the agent opens its page in this computer's
   * browser itself and its own listener takes the return, while its link, code and paste prompt still come back.
   */
  'providers.deviceLogin.start': { params: z.object({ id: Id, methodId: z.string().optional(), here: z.boolean().optional() }), result: DeviceLoginSchema },
  'providers.deviceLogin.status': { params: z.object({ id: Id }), result: DeviceLoginSchema.nullable() },
  /** the code the login asked to have pasted (Claude Code's "Paste code here") */
  'providers.deviceLogin.code': { params: z.object({ id: Id, code: z.string().trim().min(1).max(2000) }), result: DeviceLoginSchema },
  'providers.deviceLogin.cancel': { params: z.object({ id: Id }), result: z.object({ ok: z.literal(true) }) },
  /**
   * The address a sign-in came back to (`DeviceLogin.relay`): checked against the running login (its port, path and
   * `state`), then handed to the agent's own listener on this computer, which finishes the sign-in itself (the code is
   * one-time; the agent's PKCE secret never leaves this computer).
   */
  'providers.deviceLogin.finish': { params: z.object({ id: Id, url: z.string().trim().min(1).max(16_384) }), result: DeviceLoginSchema },
  /**
   * Profile folders on this Mac not added yet: Synara's Claude profiles (`~/.synara/userdata/provider-homes`) and
   * `~/.claude-*` / `~/.codex-*` folders that hold a config.
   */
  'providers.profiles': { params: Empty, result: z.object({ found: z.array(FoundProfileSchema) }) },
  /**
   * Adds a profile of `of` (a `PROFILE_HOME_ENV` agent) as an agent of its own: `home` is an existing config folder
   * (a found one), else AppuBot makes a new empty one (then log in to it). Owner only.
   */
  'providers.addProfile': {
    params: z.object({ of: Id, name: z.string().trim().min(1).max(40), home: z.string().optional() }),
    result: ProviderSchema,
  },
  /** renames a profile, or (a built-in's id) its default profile (owner only) */
  'providers.renameProfile': { params: z.object({ id: Id, name: z.string().trim().min(1).max(40) }), result: ProviderSchema },

  /* custom models: model servers given to OpenCode (see endpoints.ts) */
  'endpoints.list': { params: Empty, result: z.array(ModelEndpointSchema) },
  /**
   * Asks a server which models it has (`GET <baseUrl>/models`). `id`: an endpoint saved before, whose key is used
   * when no `apiKey` is given. Owner only.
   */
  'endpoints.probe': {
    params: z.object({ id: Id.optional(), baseUrl: z.string().trim().min(1), apiKey: z.string().max(4096).optional() }),
    /** `baseUrl`: the address that answered (`/v1` added when the server wanted it) */
    result: z.object({ ok: z.boolean(), models: z.array(z.string()), baseUrl: z.string(), error: z.string().optional() }),
  },
  /**
   * Adds an endpoint (no `id`) or changes one; OpenCode gets it at its next start (running chats restart at their next
   * turn). `apiKey`: absent keeps the saved one, '' forgets it. Owner only.
   */
  'endpoints.save': {
    params: z.object({
      id: Id.optional(), kind: EndpointKind, name: z.string().trim().min(1).max(40), baseUrl: z.string().trim().min(1),
      apiKey: z.string().max(4096).optional(), models: z.array(z.string().trim().min(1)).min(1).max(200),
    }),
    result: ModelEndpointSchema,
  },
  'endpoints.delete': { params: z.object({ id: Id }), result: z.object({ ok: z.literal(true) }) },

  /* the vault (see vault.ts): owner only */
  'vault.list': { params: Empty, result: z.object({ items: z.array(VaultItemSchema), encrypted: z.boolean() }) },
  /**
   * Adds an item (no `id`) or changes one. `secrets`: a field left out keeps its saved value, '' clears it. A kind
   * can't change.
   */
  'vault.save': { params: VaultSaveSchema, result: VaultItemSchema },
  /**
   * Several items at once, in one write (a password file brought in, another computer's Vault carried over): each as
   * `vault.save` takes it. All or nothing: one that can't be saved refuses the lot, named by its place in the list.
   */
  'vault.saveMany': { params: z.object({ items: z.array(VaultSaveSchema).min(1).max(VAULT_SAVE_MANY_MAX) }), result: z.object({ items: z.array(VaultItemSchema) }) },
  'vault.delete': { params: z.object({ id: Id }), result: z.object({ ok: z.literal(true) }) },
  /** a saved secret, for the owner's editor (Show) */
  'vault.reveal': { params: z.object({ id: Id, field: VaultSecretField }), result: z.object({ value: z.string() }) },

  /* git and GitHub, carried from one of the person's computers to another (carry.ts): the computer's own window only */
  /** what this computer's git has to carry: its name and email, and whether a GitHub sign-in was found */
  'github.local': { params: Empty, result: GitLocalSchema },
  /** that GitHub sign-in's token, for the window to hand the other computer (as `vault.reveal` hands a secret) */
  'github.localToken': { params: Empty, result: z.object({ token: z.string() }) },
  'github.status': { params: Empty, result: GitSetupSchema },
  /** sets git's name and email here, signs git in to GitHub with the token, makes an SSH key of this computer's own */
  'github.setup': { params: GitSetupParamsSchema, result: GitSetupSchema },

  /* this computer's folders lent to the bots on another of the person's computers (carry.ts): its own window only */
  'macLink.status': { params: Empty, result: MacLinkStatusSchema },
  'macLink.setFolders': { params: z.object({ folders: z.array(z.string().min(1).max(1024)).max(MAC_LINK_FOLDERS_MAX) }), result: MacLinkStatusSchema },
  /** a token for another computer to read the lent folders with; this starts AppuBot Connect for it */
  'macLink.create': { params: z.object({ name: z.string().trim().min(1).max(120) }), result: MacLinkGrantSchema },
  'macLink.revoke': { params: z.object({ id: Id }), result: MacLinkStatusSchema },
  /** a lent folder (as `status` lists it) switched to take the bots' changes, or back to read-only */
  'macLink.setWritable': { params: z.object({ folder: z.string().min(1).max(1024), on: z.boolean() }), result: MacLinkStatusSchema },
  /* the other end: the computer whose bots read them */
  'macFiles.status': { params: Empty, result: MacFilesStatusSchema },
  'macFiles.link': { params: MacFilesLinkParamsSchema, result: MacFilesStatusSchema },
  'macFiles.unlink': { params: Empty, result: MacFilesStatusSchema },
  /** asks the lending computer now: is it on, and which folders does it lend */
  'macFiles.check': { params: Empty, result: MacFilesCheckSchema },

  /* computer use */
  'computer.status': { params: Empty, result: ComputerStatusSchema },
  'computer.screenshot': { params: z.object({ maxWidth: z.number().optional(), quality: z.number().optional() }).default({}), result: ComputerFrameSchema },
  'computer.act': { params: z.object({ action: ComputerActionSchema, threadId: Id.optional() }), result: z.object({ ok: z.boolean(), frame: ComputerFrameSchema.optional(), text: z.string().optional() }) },
  /**
   * Several actions in one go (one agent turn instead of one per action): they run back to back without a picture in
   * between, the first failure stops the rest, and one look at the window (`look`) comes back at the end.
   */
  'computer.batch': {
    params: z.object({ steps: z.array(ComputerActionSchema).min(1).max(60), look: z.enum(['window', 'picture', 'none']).default('window'), threadId: Id.optional() }),
    result: z.object({ ok: z.boolean(), done: z.number().int(), frame: ComputerFrameSchema.optional(), text: z.string().optional() }),
  },
  'computer.pause': { params: Empty, result: ComputerStatusSchema },
  'computer.resume': { params: Empty, result: ComputerStatusSchema },
  'computer.setLiveView': { params: z.object({ enabled: z.boolean() }), result: ComputerStatusSchema },
  /**
   * Live view: this device starts (or stops) watching the screen. While it does, `computer.live` pictures come to it
   * alone, as fast as its link takes them. `live: false` where the computer can't stream its screen (then the
   * device shows the bots' screenshots instead). `screen` is the screen's size in points.
   * `video`: the codecs this device decodes (LIVE_VIDEO_CODECS); a computer that can stream one answers `video`
   * with the codec and sends `computer.liveVideo` frames instead of pictures. Otherwise (it can't, or it predates
   * video and drops the field) pictures come as before, and a device shows whichever arrives.
   */
  'computer.watch': {
    params: z.object({ on: z.boolean(), video: z.object({ codecs: z.array(z.string().max(16)).max(8) }).optional() }),
    result: z.object({
      ok: z.literal(true), live: z.boolean(), screen: z.object({ width: z.number(), height: z.number() }).optional(),
      video: z.object({ codec: z.string() }).optional(),
    }),
  },
  /** this device has shown live picture (or video frame) `seq`, and every one before it */
  'computer.liveAck': { params: z.object({ seq: z.number().int() }), result: z.object({ ok: z.literal(true) }) },
  /**
   * live video: this device's decoder needs a keyframe (it failed, or was made afresh): the frames until the next
   * keyframe are not sent to it. Only a device that got `computer.liveVideo` asks (so only a computer that has it).
   */
  'computer.liveKey': { params: Empty, result: z.object({ ok: z.literal(true) }) },
  /**
   * Live view's Watching / Take control: `on` takes control of the screen for this connection (its input goes to the
   * screen, and the bots' computer use waits), or renews it while held; `off` gives it back. Refused (`in_control`)
   * while someone else has it. Control also goes back when this connection stops watching or closes, and after
   * CONTROL_IDLE_MS without input. `mine`: this connection holds `control`.
   */
  'computer.control': {
    params: z.object({ on: z.boolean() }),
    result: z.object({ ok: z.literal(true), control: ScreenControlSchema.nullable(), mine: z.boolean() }),
  },
  /** the person watching uses the computer (live view): a click, a scroll, typing, a key, the clipboard; only while they have control (`computer.control`) */
  'computer.liveInput': { params: LiveInputSchema, result: z.object({ ok: z.literal(true), text: z.string().optional() }) },
  'computer.requestPermissions': { params: Empty, result: ComputerStatusSchema },
  'computer.openSettings': { params: z.object({ pane: z.enum(['accessibility', 'screen_recording', 'input_monitoring']) }), result: z.object({ ok: z.literal(true) }) },

  /* skills & teach */
  'skills.list': { params: z.object({ botId: Id.optional() }).default({}), result: z.array(SkillSchema) },
  'skills.get': { params: z.object({ botId: Id, name: z.string() }), result: SkillSchema },
  'skills.save': { params: z.object({ botId: Id, name: z.string(), description: z.string().default(''), body: z.string() }), result: SkillSchema },
  'skills.delete': { params: z.object({ botId: Id, name: z.string() }), result: z.object({ ok: z.literal(true) }) },
  /** one of this computer's shared skills (`bots.exportable`), its SKILL.md read */
  'skills.getShared': { params: z.object({ name: z.string() }), result: SharedSkillTextSchema },
  'teach.start': { params: z.object({ botId: Id, name: z.string(), goal: z.string().default('') }), result: TeachSessionSchema },
  'teach.stop': { params: z.object({ id: Id, cancel: z.boolean().default(false) }), result: TeachSessionSchema },
  'teach.status': { params: Empty, result: TeachSessionSchema.nullable() },
  /** whether teach.start records the user's clicks and keys here, or writes the skill from the description alone (why: `reason`) */
  'teach.support': { params: Empty, result: z.object({ recording: z.boolean(), reason: z.string().optional(), /** `live`: it records what you do on this computer's screen through live view or Open desktop (your AppuBot computer) */ how: z.enum(['input', 'live']).optional() }) },
  /** a viewer driving the screen another way (noVNC) tells the teach session what it did (your AppuBot computer) */
  'teach.input': { params: TeachInputSchema, result: z.object({ ok: z.literal(true) }) },

  /* routines */
  'routines.list': { params: Empty, result: z.array(RoutineSchema) },
  'routines.create': { params: RoutineSchema.pick({ botId: true, name: true, prompt: true, schedule: true, enabled: true, deliverTo: true }).partial({ enabled: true, deliverTo: true }), result: RoutineSchema },
  'routines.update': { params: z.object({ id: Id, patch: patchOf(RoutineSchema.omit({ id: true, createdAt: true })) }), result: RoutineSchema },
  'routines.delete': { params: z.object({ id: Id }), result: z.object({ ok: z.literal(true) }) },
  'routines.runNow': { params: z.object({ id: Id }), result: ThreadSchema },

  /* groups: bots that talk with each other in a room of their own (protocol groups.ts) */
  'groups.list': { params: Empty, result: z.array(GroupSchema) },
  'groups.create': { params: z.object({ name: z.string().min(1).max(80), botIds: z.array(Id).min(1).max(20), leadId: Id.optional() }), result: GroupSchema },
  /**
   * `leadId: ''` clears the lead (the first chief among the members leads, else nobody). `providerId`/`modelId`/`effort`:
   * the agent, model and effort every member answers the group on; `providerId: ''` goes back to each bot's own (and
   * clears the other two), `modelId: ''` is the agent's default.
   */
  'groups.update': { params: z.object({ id: Id, patch: patchOf(z.object({ name: z.string().min(1).max(80), botIds: z.array(Id).min(1).max(20), leadId: z.string(), providerId: z.string(), modelId: z.string(), effort: z.string(), pinned: z.boolean() })) }), result: GroupSchema },
  'groups.delete': { params: z.object({ id: Id }), result: z.object({ ok: z.literal(true) }) },
  /** the room's messages, newest last; `before`: older than this moment */
  'groups.history': { params: z.object({ id: Id, chatId: Id.optional(), before: Timestamp.optional(), limit: z.number().int().min(1).max(500).default(100) }), result: z.object({ messages: z.array(GroupMessageSchema), hasMore: z.boolean() }) },
  /** the user posts to the room: @Name picks who answers (else the lead, or every member) */
  'groups.send': { params: z.object({ id: Id, chatId: Id.optional(), text: z.string().min(1).max(20000), clientId: z.string().max(100).optional() }), result: GroupMessageSchema },
  /** stop every member's turn on the room and the bots' exchange */
  'groups.stop': { params: z.object({ id: Id }), result: z.object({ ok: z.literal(true) }) },
  /** a group thread's goal (none named: the current thread's): pause or resume it, stop it, or clear a finished one away */
  'groups.goal': { params: z.object({ id: Id, chatId: Id.optional(), action: z.enum(['pause', 'resume', 'stop', 'clear']) }), result: GroupSchema },
  /** a new thread in the group, made current (an empty current one is reused); each member answers it in a new thread of its own */
  'groups.newChat': { params: z.object({ id: Id }), result: GroupSchema },
  /** make one of the group's threads current */
  'groups.useChat': { params: z.object({ id: Id, chatId: Id }), result: GroupSchema },
  /**
   * A group's room as another computer had it, into a group made here moments ago (a transfer): its threads, oldest
   * first, and their messages, kept as they were (nobody is asked to answer them). `fromId`: the group's id there; its
   * members' own threads for it (which came with the bots) follow it here. Refused with `conflict` once the room has
   * messages (an answer lost on the way: it is in already). A computer from before answers `unknown_method`.
   */
  'groups.restore': { params: z.object({ id: Id, fromId: Id.optional(), chats: z.array(GroupRestoreChatSchema).min(1).max(GROUP_RESTORE_CHATS_MAX) }), result: GroupSchema },

  /* channels */
  'channels.list': { params: Empty, result: z.array(ChannelSchema) },
  'channels.configure': { params: z.object({ id: z.string().min(1), token: z.string().optional(), botId: Id.optional(), enabled: z.boolean().optional(), allowedUsers: z.array(z.string()).optional() }), result: ChannelSchema },
  /** another Telegram bot (no token yet), answering as `botId` or the first bot without a handle of its own */
  'channels.add': { params: z.object({ botId: Id.optional() }), result: ChannelSchema },
  /** stops it and forgets its token; its chats stay as threads */
  'channels.remove': { params: z.object({ id: z.string().min(1) }), result: z.object({ ok: z.literal(true) }) },

  /*
   * apps (the user's own Composio account, signed in with OAuth): connected once for the whole computer; each bot gets
   * the connected apps it isn't barred from (`Bot.appsOff`, set with `bots.update`) through the bridge's apps tools
   */
  'apps.status': { params: Empty, result: AppsStatusSchema },
  /**
   * starts Composio's sign-in. Without `redirectUri` it opens in this computer's browser; a device signing in itself
   * gives its own return address (its app's link) and gets the page to open (`url`), then hands back what the browser
   * returned with `apps.finishSignIn`. The outcome comes as `apps.updated` either way.
   */
  'apps.signIn': {
    params: z.object({ redirectUri: z.string().min(1).max(500).optional() }).default({}),
    result: AppsStatusSchema.extend({ url: z.string().optional() }),
  },
  /** a device's sign-in came back: the `code`, `state` (or `error`) from its return address; whether it signed in */
  'apps.finishSignIn': {
    params: z.object({ code: z.string().max(4000).optional(), state: z.string().max(200).optional(), error: z.string().max(500).optional() }),
    result: z.object({ ok: z.boolean(), status: AppsStatusSchema }),
  },
  /** forgets the tokens on this computer (the connections stay in the Composio account) */
  'apps.signOut': { params: Empty, result: AppsStatusSchema },
  /** one page of the directory (shipped with the app): the toolkits of `slugs` (in that order), a search or a category */
  'apps.catalog': {
    params: z.object({
      search: z.string().optional(), category: z.string().optional(), slugs: z.array(z.string()).max(50).optional(),
      cursor: z.string().optional(), limit: z.number().int().min(1).max(200).default(60),
    }).default({ limit: 60 }),
    result: z.object({ categories: z.array(AppCategorySchema), toolkits: z.array(AppToolkitSchema), nextCursor: z.string().optional(), total: z.number().int().optional() }),
  },
  'apps.connections': { params: Empty, result: z.array(AppConnectionSchema) },
  /**
   * starts connecting an app: Composio's link page in the browser; the gateway watches it and reports with
   * `apps.updated`. `open: 'caller'` opens nothing on the computer and leaves `redirectUrl` to the device that asked
   * (the phone's own browser).
   */
  'apps.connect': { params: z.object({ slug: z.string().min(1), open: z.enum(['computer', 'caller']).optional() }), result: z.object({ redirectUrl: z.string().optional() }) },
  'apps.disconnect': { params: z.object({ connectedAccountId: z.string().min(1), slug: z.string().min(1) }), result: z.object({ ok: z.literal(true) }) },
  /** of an app with several accounts, the one the bots' calls use when they name none (`apps.updated` follows) */
  'apps.setDefault': { params: z.object({ connectedAccountId: z.string().min(1), slug: z.string().min(1) }), result: z.object({ ok: z.literal(true) }) },

  /* devices & pairing */
  'devices.list': { params: Empty, result: z.array(DeviceSchema) },
  'devices.revoke': { params: z.object({ id: Id }), result: z.object({ ok: z.literal(true) }) },
  'devices.rename': { params: z.object({ id: Id, name: z.string() }), result: DeviceSchema },
  /**
   * The calling phone's own notifications from this computer (protocol 2): its token, previews and kinds; null drops
   * them. `turnOn` (the user switched them on on the phone) also undoes this computer's switch for it.
   */
  'devices.setPush': { params: z.object({ push: PushRegistrationSchema.nullable(), turnOn: z.boolean().optional() }), result: z.object({ pushOn: z.boolean() }) },
  /** this computer's switch for one phone's notifications (protocol 2) */
  'devices.setNotifications': { params: z.object({ id: Id, on: z.boolean() }), result: DeviceSchema },
  /**
   * The calling phone is in front (it shows what happens itself, so nothing is pushed to it) or not (protocol 2). Said
   * again every `PRESENCE_EVERY_MS` while in front; older than `PRESENCE_TTL_MS` counts as not.
   * `desk`: the caller is the desktop app showing this computer (an AppuBot computer seen from the person's Mac), and
   * `foreground` says its person is at that Mac (its window in front, or the keyboard or mouse used lately): their
   * phones get no pushes meanwhile, as when they're at the computer the bots run on. Additive: older computers drop it.
   */
  'devices.presence': { params: z.object({ foreground: z.boolean(), desk: z.boolean().optional() }), result: z.object({ ok: z.literal(true) }) },
  'pairing.start': { params: z.object({ ttlSec: z.number().default(300) }).default({ ttlSec: 300 }), result: PairingInfoSchema },
  /** AppuBot Connect: the tunnel's state; `set` switches it on or off (owner only); `reset` forgets this computer's tunnel and gets a new hostname (owner only) */
  'connect.status': { params: Empty, result: ConnectStatusSchema },
  'connect.set': { params: z.object({ enabled: z.boolean() }), result: ConnectStatusSchema },
  'connect.reset': { params: Empty, result: ConnectStatusSchema },
  'pairing.cancel': { params: Empty, result: z.object({ ok: z.literal(true) }) },

  /* files */
  /** open one of AppuBot's own files (sent or received in a chat) in its default Mac app */
  'files.open': { params: z.object({ id: Id }), result: z.object({ ok: z.literal(true) }) },
  /** Where a visual reply (`page` part) loads from: the gateway path with a viewing key for that page only (this run). */
  'files.pageView': { params: z.object({ id: Id }), result: z.object({ path: z.string() }) },
  'files.list': { params: z.object({ threadId: Id.optional(), limit: z.number().default(50) }).default({ limit: 50 }), result: z.array(FileAttachmentSchema) },
  'files.sendToDevices': { params: z.object({ path: z.string(), caption: z.string().optional(), threadId: Id.optional() }), result: FileAttachmentSchema },

  /* agent bridge (called by the MCP bridge process on behalf of the running agent; role 'agent') */
  'agent.ask': { params: z.object({ question: z.string(), options: z.array(z.string()).default([]), timeoutSec: z.number().default(600) }), result: z.object({ answer: z.string().nullable() }) },
  /**
   * A form card in the chat (`ask_form`): the user fills in the fields and sends it. `values` null: no answer in time
   * (or the turn ended); `declined`: they turned it down.
   */
  'agent.askForm': {
    params: z.object({ question: z.string().min(1).max(2000), fields: z.array(FormFieldSchema).min(1).max(20), submit: z.string().max(40).optional(), timeoutSec: z.number().default(900) }),
    /** `answer`: the user answered in words instead (an older app, Telegram) */
    result: z.object({ values: z.record(z.string(), FormValue).nullable(), declined: z.boolean().optional(), answer: z.string().optional() }),
  },
  /** a separate chat message, now (its own bubble), from the bot in its running turn */
  'agent.say': { params: z.object({ text: z.string().min(1).max(4000) }), result: z.object({ ok: z.literal(true) }) },
  /*
   * The user's connected apps (Composio), limited to the ones this bot may use: find tools for a task, read their
   * inputs, run them. Arguments and results are Composio's own (JSON), filtered by the gateway.
   */
  /**
   * Ask the user to connect an app (or turn one already connected on for this bot) on a card in the chat
   * (`apps_request`): its buttons run the connection (`apps.connect`) or the switch (`bots.update`), and the card
   * settles once the app is connected and on for the bot. `connected`/`on` say where it ended; `declined`: turned
   * down; neither and not connected: no answer in time, or answered in words (`answer`).
   */
  'agent.apps.request': {
    params: z.object({ slug: z.string().min(1).max(80), reason: z.string().max(500).optional(), timeoutSec: z.number().default(900) }),
    result: z.object({ slug: z.string(), name: z.string(), connected: z.boolean(), on: z.boolean(), declined: z.boolean().optional(), answer: z.string().optional(), note: z.string().optional() }),
  },
  'agent.apps.search': { params: z.object({ queries: z.array(z.object({ use_case: z.string().min(1).max(1024), known_fields: z.string().optional() })).min(1).max(10) }), result: z.object({ text: z.string() }) },
  'agent.apps.schemas': { params: z.object({ tool_slugs: z.array(z.string().min(1)).min(1).max(50) }), result: z.object({ text: z.string() }) },
  'agent.apps.execute': {
    params: z.object({ tools: z.array(z.object({ tool_slug: z.string().min(1), arguments: z.record(z.string(), z.unknown()), account: z.string().optional() })).min(1).max(50), thought: z.string().optional() }),
    result: z.object({ text: z.string(), isError: z.boolean().optional() }),
  },
  'agent.notify': { params: z.object({ title: z.string(), body: z.string().default('') }), result: z.object({ ok: z.literal(true) }) },
  'agent.sendFile': { params: z.object({ path: z.string(), caption: z.string().optional() }), result: FileAttachmentSchema },
  /** A visual reply: self-contained HTML shown in the chat (`page` part); local images by path are built in. */
  'agent.showPage': { params: z.object({ title: z.string().min(1).max(120), html: z.string().min(1).max(PAGE_HTML_MAX) }), result: z.object({ ok: z.literal(true), bytes: z.number() }) },
  /**
   * Hear an audio or video file on this computer (a voice note or clip the user sent, a recording in the bot's
   * folder): its words, with this computer's speech model. `language` an ISO code ('auto' or unsent: the model finds it).
   */
  'agent.transcribe': { params: z.object({ path: z.string(), language: z.string().optional() }), result: z.object({ text: z.string(), durationMs: z.number() }) },
  /**
   * Send the user a voice message now: `text` read aloud with this computer's voice, as a voice note in their chat
   * (a `voice` part, `kind: 'reply'`) and on Telegram when the turn came from there. `caption`: words shown with it.
   */
  'agent.speak': {
    params: z.object({ text: z.string().min(1).max(VOICE_SPEAK_MAX_CHARS), language: SpeechLanguage.optional(), voice: SpeechVoice.optional(), caption: z.string().max(1000).optional() }),
    result: z.object({ ok: z.literal(true), file: FileAttachmentSchema, durationMs: z.number(), language: SpeechLanguage }),
  },
  /*
   * The calling bot's memory (MEMORY.md), shared by all its threads: `remember` adds a dated line (`added` false when
   * it already says that); `memory.update` replaces the one line containing `find` (an empty `text` removes it);
   * `memory.forget` removes every line containing `text`. `chars` is the memory's size afterwards.
   */
  'agent.remember': { params: z.object({ text: z.string() }), result: z.object({ ok: z.literal(true), path: z.string(), added: z.boolean(), chars: z.number().int() }) },
  'agent.memory.read': { params: Empty, result: z.object({ memory: z.string(), path: z.string(), chars: z.number().int() }) },
  'agent.memory.update': {
    params: z.object({ find: z.string().min(1), text: z.string() }),
    result: z.object({ ok: z.literal(true), path: z.string(), removed: z.string(), added: z.string().optional(), chars: z.number().int() }),
  },
  'agent.memory.forget': { params: z.object({ text: z.string().min(1) }), result: z.object({ ok: z.literal(true), path: z.string(), removed: z.array(z.string()), chars: z.number().int() }) },
  'agent.saveSkill': { params: z.object({ name: z.string(), description: z.string().default(''), body: z.string() }), result: SkillSchema },
  'agent.context': { params: Empty, result: z.object({ botId: Id, threadId: Id, botName: z.string(), workspace: z.string(), computerUse: z.boolean() }) },
  /*
   * A bot looking after itself and the other bots: its own profile and theirs, and their conversations (text only).
   * No `id` means the calling bot (from its token, never a parameter). The writable fields leave out what would grant
   * abilities (permission mode, agent, apps, computer use).
   */
  'agent.bots.list': { params: Empty, result: z.array(AgentBotSummarySchema) },
  'agent.bots.get': { params: z.object({ id: Id.optional() }), result: AgentBotDetailSchema },
  'agent.bots.update': { params: z.object({ id: Id.optional(), patch: AgentBotPatch }), result: AgentBotDetailSchema },
  /** a new bot, once the user allows it in the caller's chat (it starts quiet: no greeting) */
  /**
   * A bot's routines (prompts it runs on a schedule, in its current chat): its own without `botId`. Creating one, and
   * changing what one runs or when (or turning it on), wait for the user's "Allow" in the caller's chat.
   */
  'agent.routines.list': { params: z.object({ botId: Id.optional() }).default({}), result: z.array(RoutineSchema.extend({ when: z.string() })) },
  'agent.routines.create': {
    params: RoutineSchema.pick({ name: true, prompt: true, schedule: true }).extend({ botId: Id.optional(), deliverTo: RoutineSchema.shape.deliverTo.optional(), enabled: z.boolean().optional() }),
    result: RoutineSchema.extend({ when: z.string() }),
  },
  'agent.routines.update': { params: z.object({ id: Id, patch: patchOf(RoutineSchema.pick({ name: true, prompt: true, schedule: true, enabled: true, deliverTo: true })) }), result: RoutineSchema.extend({ when: z.string() }) },
  'agent.routines.delete': { params: z.object({ id: Id }), result: z.object({ ok: z.literal(true) }) },
  /**
   * Bots talking to each other. `message`: one bot, by id or name, gets `text` in its current chat as a message from
   * the caller (never the user) and answers; with `wait` (default) the reply comes back here, else only
   * `{reply: null}` at once. `broadcast` (a chief only): the same to every other bot (or `botIds`), replies gathered.
   */
  'agent.bots.message': {
    params: z.object({ bot: z.string().min(1), text: z.string().min(1).max(20000), wait: z.boolean().default(true) }),
    result: z.object({ bot: z.object({ id: Id, name: z.string() }), threadId: Id, reply: z.string().nullable(), timedOut: z.boolean().default(false) }),
  },
  'agent.bots.broadcast': {
    params: z.object({ text: z.string().min(1).max(20000), botIds: z.array(Id).optional(), wait: z.boolean().default(true) }),
    result: z.object({ replies: z.array(z.object({ bot: z.object({ id: Id, name: z.string() }), reply: z.string().nullable(), timedOut: z.boolean().default(false) })) }),
  },
  /** the caller's groups (every group for a chief), each with its members' names and who leads */
  'agent.groups.list': { params: Empty, result: z.array(GroupSchema.extend({ members: z.array(z.object({ id: Id, name: z.string(), chief: z.boolean() })), lead: z.string().optional() })) },
  /** post to a group the caller is in (from its own chat; in a group turn its reply is posted by itself) */
  'agent.groups.post': { params: z.object({ group: z.string().min(1), text: z.string().min(1).max(20000) }), result: GroupMessageSchema },
  /** make a group, once the user allows it */
  /** the bot proposes a goal to work on by itself in this chat (an Allow card); answers once allowed or refused */
  'agent.goal.start': { params: z.object({ objective: z.string().min(1).max(2000), maxTurns: z.number().int().min(1).max(GOAL_TURNS_MAX).optional(), hours: z.number().positive().max(GOAL_HOURS_MAX).optional() }), result: z.object({ goal: GoalSchema }) },
  /** the bot ends its goal: achieved, or it can't go on without the user */
  'agent.goal.finish': { params: z.object({ status: z.enum(['done', 'blocked']), note: z.string().max(2000).default('') }), result: z.object({ goal: GoalSchema }) },
  'agent.groups.create': { params: z.object({ name: z.string().min(1).max(80), botIds: z.array(Id).min(1).max(20), leadId: Id.optional() }), result: GroupSchema },
  'agent.bots.create': {
    // no .partial() of BotSchema: Zod 4 would fill its defaults (computer use on, a fixed look) for what the bot left out
    params: z.object({
      name: z.string(), job: z.string().optional(), instructions: z.string().optional(), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
      shape: BotShape.optional(), providerId: Id.optional(), computerUse: z.boolean().optional(),
    }),
    result: AgentBotDetailSchema,
  },
  /** the vault's items as a bot may know them: names and what's not secret (contact info in full), never a secret */
  'agent.vault.list': { params: z.object({ kind: VaultKind.optional() }).default({}), result: z.object({ items: z.array(VaultItemSchema) }) },
  /**
   * Types a saved secret (or a contact field) into an app window, as computer_type would, without the bot seeing it.
   * The first use of an item in a chat waits for the user's "Allow". Nothing of the window comes back.
   */
  'agent.vault.fill': {
    params: z.object({
      id: Id,
      field: z.enum(['username', 'password', 'number', 'cvc', 'expiry', 'cardholder', 'fullName', 'email', 'phone', 'company', 'address1', 'address2', 'city', 'region', 'postalCode', 'country']),
      pid: z.number().int(), windowId: z.number().int(), label: z.string().optional(), element: z.string().optional(),
    }),
    result: z.object({ ok: z.boolean(), text: z.string() }),
  },
  /**
   * Puts a saved API key in this bot's private keys file (`KEY=value` lines, this user only), after the user's "Allow"
   * the first time in a chat, and says where it is.
   */
  'agent.vault.key': { params: z.object({ id: Id }), result: z.object({ path: z.string(), envName: z.string() }) },
  /**
   * The user's own computer's files (carry.ts), for a bot on their AppuBot computer: the folders they lent (no
   * `path`), or what is in one. Fails with words when no computer is linked or it isn't on.
   */
  'agent.mac.list': { params: z.object({ path: z.string().max(2048).optional() }).default({}), result: z.object({ mac: z.string(), folders: z.array(MacFolderSchema).optional(), path: z.string().optional(), entries: LinkEntriesSchema.shape.entries.optional(), truncated: z.boolean().optional() }) },
  /** files and folders there whose name has `query` in it, under `path` or every lent folder */
  'agent.mac.find': { params: z.object({ query: z.string().trim().min(1).max(200), path: z.string().max(2048).optional() }), result: z.object({ mac: z.string(), entries: LinkEntriesSchema.shape.entries, truncated: z.boolean().optional() }) },
  /** copies one file from there into the bot's inbox here and says where it is */
  'agent.mac.fetch': { params: z.object({ path: z.string().min(1).max(2048) }), result: z.object({ path: z.string(), name: z.string(), bytes: z.number() }) },
  /**
   * saves a file there: a file in the bot's own folder here (`from`) or `text`, created or replacing what is at `path`,
   * only in a folder the user switched to take changes (decided there; a replaced file's old version goes to its Trash)
   */
  'agent.mac.put': {
    params: z.object({ path: z.string().min(1).max(2048), from: z.string().min(1).max(4096).optional(), text: z.string().max(MAC_PUT_TEXT_MAX).optional() })
      .refine((p) => (p.from === undefined) !== (p.text === undefined), { message: 'Give either from (a file in your folder) or text, not both.' }),
    result: LinkPutSchema.extend({ mac: z.string() }),
  },
  /**
   * Ask the user to add a login, card, API key or contact info to the Vault, on a card in the chat they fill in (or
   * pick one already saved). The secrets go straight into the Vault: the bot gets the item as `vault.list` shows it,
   * and the chat is allowed to use it (no second "Allow"). `item` null: declined (`declined`) or no answer in time.
   * `name`/`site`/`username`/`envName` fill the card in to start with.
   */
  'agent.vault.request': {
    params: z.object({
      kind: VaultKind,
      name: z.string().trim().min(1).max(80),
      reason: z.string().max(500).optional(),
      site: z.string().max(200).optional(),
      username: z.string().max(200).optional(),
      envName: z.string().max(80).optional(),
      timeoutSec: z.number().default(900),
    }),
    result: z.object({ item: VaultItemSchema.nullable(), declined: z.boolean().optional(), picked: z.boolean().optional() }),
  },
  /**
   * Ask the user to connect a Telegram bot to this bot on a card in the chat (`telegram_request`): the token is typed
   * in on the computer and never reaches the bot. `channel` is the connected Telegram bot (its handle and pairing
   * code); null: declined (`declined`), no answer in time, or answered in words.
   */
  'agent.telegram.request': {
    params: z.object({ reason: z.string().max(500).optional(), timeoutSec: z.number().default(900) }),
    result: z.object({ channel: ChannelSchema.nullable(), declined: z.boolean().optional(), already: z.boolean().optional() }),
  },
  /** the bot's reaction on the user's message in its thread (`messageId`, else their latest), `null` takes it back */
  'agent.react': { params: z.object({ emoji: z.string().min(1).max(16).nullable(), messageId: Id.optional() }), result: z.object({ ok: z.literal(true), messageId: Id }) },
  'agent.bots.history': {
    params: z.object({ id: Id.optional(), before: HistoryCursor.optional(), limit: z.number().int().min(1).max(100).default(30) }),
    result: z.object({ messages: z.array(AgentHistoryMessageSchema), hasMore: z.boolean() }),
  },

  /*
   * voice: speech on this computer, for every client. Models (`VOICE_MODELS`) download once on first use into
   * `<dataDir>/voice-models` and run on the CPU through sherpa-onnx; nothing is sent anywhere.
   */
  'voice.status': { params: Empty, result: VoiceStatusSchema },
  /** starts a model's download (returns at once; `voice.status` events follow its progress) */
  'voice.models.download': { params: z.object({ id: VoiceModelId }), result: VoiceStatusSchema },
  'voice.models.cancel': { params: z.object({ id: VoiceModelId }), result: VoiceStatusSchema },
  /** deletes a model's files from this computer (it downloads again on the next use) */
  'voice.models.remove': { params: z.object({ id: VoiceModelId }), result: VoiceStatusSchema },
  /**
   * Starts downloading what voice needs with the current settings (`settings.voice.sttModel` and the voice model), if
   * missing. `only: 'voice'`: the voice model alone, for a client that hears you itself (a phone's own recognizer,
   * this Mac's models for another computer's chat); a computer from before it ignores the key and fetches both.
   */
  'voice.prepare': { params: VoiceOnly, result: VoiceStatusSchema },
  /**
   * Loads the speech model the settings pick and the voice now (those downloaded), and keeps them loaded for
   * `VOICE_WARM_MS` after the last call: a client in a live conversation calls it on starting and every ~20 s, so no
   * turn waits for a model to load. Answers once both are loaded; `stt`/`tts`: which ones are. `only`: `'voice'`
   * leaves the speech model alone (the client hears you itself), `'speech'` the voice (it reads elsewhere).
   */
  'voice.warm': { params: VoiceOnly, result: z.object({ stt: z.boolean(), tts: z.boolean() }) },
  /**
   * Speech → text on this computer. `audio` is base64: 16 kHz mono 16-bit little-endian PCM (`pcm16`), an OGG/Opus
   * file (`ogg`: a Telegram voice note, a phone's recording), or anything else this computer decodes (`encoded` with
   * `mimeType`: WebM/Opus, MP3, M4A, WAV; the desktop app only). `language` overrides `settings.voice.language`.
   * `keep` stores the recording as a file (returned as `recording`) so the message can carry it (`chat.send` `voice`).
   * Any client may call this: a phone records, this computer hears. Fails with `voice_not_ready` while the model
   * is missing (download it with `voice.prepare`).
   */
  'voice.transcribe': {
    params: z.object({
      audio: z.string().min(1), format: z.enum(['pcm16', 'ogg', 'encoded']).default('pcm16'), mimeType: z.string().optional(),
      language: z.string().optional(), keep: z.boolean().default(false),
    }),
    result: z.object({ text: z.string(), durationMs: z.number(), recording: FileAttachmentSchema.optional() }),
  },
  /**
   * Text → speech on this computer: an OGG/Opus file (base64 `audio`, `audio/ogg`) any client plays. Markdown is read
   * as words (code, tables and links' addresses are left out), by the voice model `settings.voice.ttsModel` picks.
   * `language` unsent: guessed from the text; `voice` (one of that model's `VoiceModelInfo.voices`; another reads in
   * its first) unsent: `settings.voice.voice`. With `threadId` and `messageId` the audio is also stored and attached to that
   * message as a `voice` part (`kind: 'reply'`, always OGG), so every client can play it again. Fails with
   * `voice_not_ready` while the voice model is missing. A live conversation's reading (voice mode) asks for `wav`
   * (16-bit PCM WAV at the voice's rate: no encoding, plays at once) and `live` (the voice model takes fewer passes:
   * about a third sooner, a little less polish).
   */
  'voice.speak': {
    params: z.object({
      text: z.string().min(1).max(VOICE_SPEAK_MAX_CHARS), language: SpeechLanguage.optional(), voice: SpeechVoice.optional(), threadId: Id.optional(), messageId: Id.optional(),
      format: z.enum(['ogg', 'wav']).default('ogg'), live: z.boolean().default(false),
    }),
    result: z.object({ audio: z.string(), mimeType: z.enum(['audio/ogg', 'audio/wav']), durationMs: z.number(), language: SpeechLanguage, file: FileAttachmentSchema.optional() }),
  },
  /**
   * A stored recording or reading (a `voice` part's file: OGG/Opus, WebM, anything this computer decodes; a WAV is
   * answered as it is) as a WAV file this computer makes once and keeps (the same one answered next time), for a
   * player that can't take the original (iPhones: Ogg, WebM). Fails with `unsupported` where it can't be decoded.
   */
  'voice.convert': { params: z.object({ fileId: Id, format: z.enum(['wav']).default('wav') }), result: FileAttachmentSchema },

  /* settings & system */
  'settings.get': { params: Empty, result: SettingsSchema },
  'settings.update': { params: patchOf(SettingsSchema), result: SettingsSchema },
  'system.info': { params: Empty, result: SystemInfoSchema },
  'system.openPath': { params: z.object({ path: z.string() }), result: z.object({ ok: z.literal(true) }) },
  'system.ping': { params: Empty, result: z.object({ pong: z.literal(true), ts: Timestamp }) },
  /** a test notification: `shown` once the OS took it, else `error` (macOS: AppuBot not allowed to notify) */
  'system.testNotification': { params: Empty, result: z.object({ shown: z.boolean(), error: z.string().optional() }) },
  /** whether the OS shows AppuBot's notifications (re-read each time) */
  'system.notificationAccess': { params: Empty, result: z.object({ access: NotificationAccessSchema }) },
  /** asks the OS to allow them (macOS shows its prompt once; after that it only says what the user chose) */
  'system.requestNotifications': { params: Empty, result: z.object({ access: NotificationAccessSchema }) },
  /** the OS's notification settings for AppuBot (macOS: System Settings › Notifications › AppuBot) */
  'system.openNotificationSettings': { params: Empty, result: z.object({ ok: z.literal(true) }) },
  /** looks for an AppuBot update now (and downloads it); the result is where that left off, `system.updated` follows */
  'system.checkForUpdate': { params: Empty, result: AppUpdateStatusSchema },
  /** quits AppuBot, installs the downloaded update and opens it again (only once `ready`) */
  'system.installUpdate': { params: Empty, result: z.object({ ok: z.literal(true) }) },
  /** the free Claude day: take it on this computer (signed in to AppuBot): Claude Code is installed if missing and the gift's agent is there to pick until it ends (no bot moves by itself) */
  'promo.start': { params: Empty, result: PromoStatusSchema },
  /** while the gift is on: put one bot on it (`on`), or back on what it used before */
  'promo.use': { params: z.object({ botId: Id, on: z.boolean() }), result: BotSchema },
  /** close the day's offer ("Not now"), or its "it's over" note: not shown again for this day */
  'promo.dismiss': { params: Empty, result: z.object({ ok: z.literal(true) }) },
  /** how much the agents on this computer were used, from their own history, with an estimated API cost (Settings › Usage) */
  'usage.summary': { params: z.object({ range: UsageRange.default('7d'), scope: UsageScope.default('all') }), result: UsageSummarySchema },
  /** how much room AppuBot's files, logs, voice models and downloaded agents take (Settings › Storage) */
  'storage.summary': { params: Empty, result: StorageSummarySchema },
  /** deletes what the storage settings say is too old now (and files no chat can show any more); the new summary */
  'storage.clean': { params: Empty, result: StorageSummarySchema },

  /* power (the Mac) */
  /**
   * Stay awake with the lid closed. Turning it on the first time asks for the Mac's password once (a narrow rule for
   * `pmset disablesleep`), so it only works from the Mac; afterwards any full-access device may switch it.
   * `forgetRule` also removes that rule (asks for the password again).
   */
  'power.setLidClosed': { params: z.object({ on: z.boolean(), forgetRule: z.boolean().optional() }), result: PowerStatusSchema },

  /* AppuBot Cloud: the Mac's account (`cloudAccount.*`, owner only) and the cloud computer's export (cloud.ts) */
  ...CloudGatewayMethods,
} as const;

export type MethodName = keyof typeof Methods;
export type MethodParams<M extends MethodName> = z.input<(typeof Methods)[M]['params']>;
export type MethodResult<M extends MethodName> = z.output<(typeof Methods)[M]['result']>;

/* =====================================================================
 * Events: name -> payload
 * ===================================================================== */
export const Events = {
  'bot.updated': BotSchema,
  'bot.deleted': z.object({ id: Id }),
  /** a custom character was saved or renamed (the library's, `characters.*`) */
  'character.updated': CharacterSchema,
  'character.removed': z.object({ id: Id }),
  'thread.updated': ThreadSchema,
  'thread.deleted': z.object({ id: Id }),
  'message.created': MessageSchema,
  /**
   * The message events below carry `rev`, the message's `Message.rev` once the change is made: a client holding that
   * revision or a later one (a `threads.history` page read after it) has it already and skips it.
   */
  /** append text to the part at `partIndex` (text/thought) - creates the part if missing */
  'message.delta': z.object({ threadId: Id, messageId: Id, partIndex: z.number(), partType: z.enum(['text', 'thought']), delta: z.string(), rev: MessageRev }),
  /** replace/insert a whole part (tool_call updates, images, files, plan, question) */
  'message.part': z.object({ threadId: Id, messageId: Id, partIndex: z.number(), part: PartSchema, rev: MessageRev }),
  /** a message's reactions changed (the whole list) */
  'message.reactions': z.object({ threadId: Id, messageId: Id, reactions: z.array(ReactionSchema), rev: MessageRev }),
  /**
   * `nothingNew`: a routine's run whose reply had nothing to say (chat-core `isNothingNewRun`: "✓", "No new items"): the
   * chat folds it away, so it neither marks the thread unread nor becomes its preview, and no notice went out for it
   */
  'message.completed': z.object({ threadId: Id, messageId: Id, status: z.enum(['complete', 'cancelled', 'error']), stopReason: z.string().optional(), error: z.string().optional(), rev: MessageRev, nothingNew: z.boolean().optional(), followUps: z.array(z.string()).optional() }),
  'permission.requested': PermissionRequestSchema,
  'permission.resolved': z.object({ id: Id, optionId: z.string(), by: z.string().optional() }),
  'question.asked': z.object({ threadId: Id, messageId: Id, questionId: Id, question: z.string(), options: z.array(z.string()), form: QuestionFormSchema.optional() }),
  'computer.status': ComputerStatusSchema,
  'computer.frame': ComputerFrameSchema,
  /** a live picture, to a device watching (`computer.watch`) only */
  'computer.live': LiveFrameSchema,
  /** a live video frame, to a device watching with `video` only */
  'computer.liveVideo': LiveVideoSchema,
  /** why a watching device gets no pictures right now (`blocked: null` once they flow again): the screen is locked */
  'computer.liveState': z.object({ blocked: z.enum(['locked']).nullable() }),
  /** `point` is where the action landed, normalised 0..1 in the image of `target` (or the whole screen when absent) */
  'computer.action': z.object({
    threadId: Id.optional(), action: ComputerActionSchema, ts: Timestamp, ok: z.boolean(), summary: z.string().optional(),
    point: z.object({ x: z.number(), y: z.number() }).optional(),
    target: z.object({ pid: z.number().int(), windowId: z.number().int() }).optional(),
  }),
  'provider.updated': ProviderSchema,
  'providers.updated': z.array(ProviderSchema),
  /** the agents' plan limits moved (read again, or heard from a session): every agent's, as `providers.limits` answers */
  'providers.limits': z.array(ProviderLimitsSchema),
  /** a device login moved (`providers.deviceLogin.*`): its link and code came, it finished or failed */
  'provider.login': DeviceLoginSchema,
  'skill.updated': SkillSchema,
  'skill.deleted': z.object({ botId: Id, name: z.string() }),
  'teach.updated': TeachSessionSchema,
  'routine.updated': RoutineSchema,
  'routine.deleted': z.object({ id: Id }),
  'group.updated': GroupSchema,
  'group.removed': z.object({ id: Id }),
  /** a message posted to a group's room */
  'group.message': GroupMessageSchema,
  'channel.updated': ChannelSchema,
  'channel.removed': z.object({ id: z.string() }),
  /** the key, a connection or a pending sign-in changed (refetch `apps.connections`) */
  'apps.updated': AppsStatusSchema,
  'device.updated': DeviceSchema,
  'device.deleted': z.object({ id: Id }),
  'pairing.updated': PairingInfoSchema.nullable(),
  'connect.status': ConnectStatusSchema,
  'file.created': FileAttachmentSchema,
  'settings.updated': SettingsSchema,
  'system.updated': SystemInfoSchema,
  /** a speech model's download moved, finished or failed; a transcription or reading started or ended */
  'voice.status': VoiceStatusSchema,
  /** `kind`: what it is about when the apps also show that themselves (the desktop's own toast for a question or an approval) */
  'notification': z.object({ id: Id, title: z.string(), body: z.string(), threadId: Id.optional(), groupId: Id.optional(), level: z.enum(['info', 'success', 'warning', 'error']).default('info'), kind: z.enum(['question', 'approval']).optional(), ts: Timestamp }),
  /* AppuBot Cloud: the Mac's account view changed, a cloud notice came (cloud.ts) */
  ...CloudGatewayEvents,
} as const;

export type EventName = keyof typeof Events;
export type EventPayload<E extends EventName> = z.output<(typeof Events)[E]>;

/* =====================================================================
 * HTTP (REST) endpoints served by the gateway alongside the WebSocket
 *   POST /api/pair           { code, device }           -> { token, deviceId, role }
 *   GET  /api/health                                     -> { ok, version, hostName }
 *   POST /api/files          multipart (token header)    -> FileAttachment
 *   GET  /files/:id?token=   -> file bytes (also Authorization: Bearer)
 *   GET  /ws?token=          -> WebSocket (token may also come in the connect frame)
 *   GET  /secure             -> WebSocket carrying the end-to-end channel (connect.ts); everything above, inside it
 * From the local network only /api/health and /secure answer: the rest goes through /secure, so no token or pairing
 * code crosses the Wi-Fi in the clear (this computer, Tailscale and AppuBot Connect are reached as before).
 * ===================================================================== */
export const PairRequestSchema = z.object({ code: z.string().length(6), device: DeviceIdentitySchema });
/**
 * The most devices one computer keeps paired (on a team's AppuBot computer, per person): a new one past it is refused
 * at `/api/pair` (409) until one is removed; a device paired before (the same `device.id`) pairs again in its own place.
 */
export const PAIRED_DEVICES_MAX = 3;
/** The most computers one phone keeps paired: pairing another asks to remove one first (the phone's own rule). */
export const PAIRED_COMPUTERS_MAX = 3;
export const PairResponseSchema = z.object({ token: z.string(), deviceId: Id, role: z.enum(['owner', 'full', 'limited']), hostName: z.string(), serverVersion: z.string() });
export type PairRequest = z.infer<typeof PairRequestSchema>;
export type PairResponse = z.infer<typeof PairResponseSchema>;

export const PAIR_URL_SCHEME = 'appubot://pair';
export interface PairUrlInfo {
  hosts: string[];
  port: number;
  code: string;
  hostName: string;
  /**
   * The Mac's X25519 public key, base64url (`k`): the phone pins it for the end-to-end channel, on the same Wi-Fi and
   * through AppuBot Connect alike. Every QR from a Mac that has it carries it.
   */
  connectKey?: string;
  /** AppuBot Connect room (`r`), only while Connect is on, and only with the key */
  connectId?: string;
}
/** Build the QR payload: appubot://pair?h=<host1,host2>&p=<port>&c=<code>&n=<hostName>[&r=<room>][&k=<key>] */
export function buildPairUrl(info: PairUrlInfo): string {
  const q = new URLSearchParams({ h: info.hosts.join(','), p: String(info.port), c: info.code, n: info.hostName });
  if (info.connectId && info.connectKey) q.set('r', info.connectId);
  if (info.connectKey) q.set('k', info.connectKey);
  return `${PAIR_URL_SCHEME}?${q.toString()}`;
}
export function parsePairUrl(url: string): PairUrlInfo | null {
  if (!url.startsWith(PAIR_URL_SCHEME)) return null;
  const q = new URL(url.replace('appubot://', 'https://x/')).searchParams;
  const hosts = (q.get('h') ?? '').split(',').filter(Boolean);
  const port = Number(q.get('p'));
  const code = q.get('c') ?? '';
  const room = q.get('r') ?? '';
  const key = q.get('k') ?? '';
  const keyOk = /^[A-Za-z0-9_-]{43}$/.test(key);
  const connect = keyOk ? { connectKey: key, ...(/^[a-z2-7]{26}$/.test(room) ? { connectId: room } : {}) } : {};
  if ((!hosts.length && !('connectId' in connect)) || !Number.isFinite(port) || code.length !== 6) return null;
  return { hosts, port, code, hostName: q.get('n') ?? 'AppuBot', ...connect };
}

/** A thread as paired devices get it in lists, the hello and events: without its slash commands (`threads.commands`). */
export function leanThread<T extends { commands?: unknown }>(t: T): T {
  if (!t.commands || (Array.isArray(t.commands) && !t.commands.length)) return t;
  const { commands: _c, ...rest } = t;
  return rest as T;
}
