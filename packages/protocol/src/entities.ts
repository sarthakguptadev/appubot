import { z } from 'zod';
import { DEFAULT_VOICE_STT_MODEL, DEFAULT_VOICE_TTS_MODEL, SpeechVoice, VoiceModelId, VoiceSttModelId, VoiceTtsModelId } from './voiceModels';

/**
 * The wire protocol this build speaks, and the oldest peer it still speaks to. Bump PROTOCOL_VERSION for any wire change
 * a peer must know about (a method or event it would rely on, a field whose meaning changed); keep the old methods and
 * fields working, and raise MIN_PROTOCOL_VERSION only when dropping support for older peers. Two peers get along iff
 * each one's version is at least the other's minimum (`protocolMatch`); they then speak the lower of the two.
 */
export const PROTOCOL_VERSION = 3;
export const MIN_PROTOCOL_VERSION = 1;
/** 2: phone notifications (`devices.setPush`, `devices.presence`, `devices.setNotifications`, `Device.pushOn`/`pushOff`) */

/** One side of a connection: the protocol it speaks and the oldest it still speaks to. */
export interface ProtocolRange { version: number; min: number }
/** Which side must update for two peers to get along: the connecting app (`client`) or the computer it reaches (`server`). */
export type UpdateSide = 'client' | 'server';

/**
 * Whether a client and a server get along: then the version they speak (the lower one), else which side is too old.
 * A peer that predates the range is taken to speak only its own version.
 */
export function protocolMatch(client: ProtocolRange, server: ProtocolRange): { ok: true; version: number } | { ok: false; update: UpdateSide } {
  if (client.version < server.min) return { ok: false, update: 'client' };
  if (server.version < client.min) return { ok: false, update: 'server' };
  return { ok: true, version: Math.min(client.version, server.version) };
}

/* ---------- primitives ---------- */
export const Id = z.string().min(1);
export const Timestamp = z.number().int().nonnegative(); // epoch ms

/* ---------- providers (ACP agents) ---------- */
export const ProviderAuthStatus = z.enum(['unknown', 'authenticated', 'needs_auth', 'not_installed', 'error']);
/**
 * Is the agent's own CLI signed in on this Mac? Checked without starting the agent (`claude auth status`,
 * `codex login status`, `cursor-agent status`, `opencode auth list`, Grok's and Copilot's own files), on every
 * refresh and while a login runs. `unknown` when it can't tell (custom agents, a check that failed).
 */
export const ProviderLoginState = z.enum(['logged_in', 'logged_out', 'unknown']);
export const ProviderAuthSchema = z.object({
  state: ProviderLoginState,
  /** who is signed in, display-ready and never a secret: a masked email ("s***@example.com"), "@octocat", "GitHub Copilot, xAI" */
  account: z.string().optional(),
  /** "Max", "ChatGPT Plus", "API key"… when the CLI says */
  plan: z.string().optional(),
  checkedAt: Timestamp,
});
export type ProviderLoginState = z.infer<typeof ProviderLoginState>;
export type ProviderAuth = z.infer<typeof ProviderAuthSchema>;

/**
 * A provider's update check. `current` is the version it compares: the CLI's own (`claude --version`, not the bundled
 * ACP adapter's) for built-ins, the registry version an added agent runs.
 */
export const ProviderUpdateSchema = z.object({
  current: z.string().optional(),
  checkedAt: Timestamp.optional(),
  /**
   * How `providers.update` updates it, for display: the command it runs ("claude update", "brew upgrade codex",
   * "npm i -g @openai/codex@latest") or "the ACP registry". Absent: AppuBot can't tell how it was installed.
   */
  via: z.string().optional(),
  /** `providers.update` is under way */
  running: z.boolean().default(false),
  /** the last check or update failed */
  error: z.string().optional(),
});
export type ProviderUpdate = z.infer<typeof ProviderUpdateSchema>;

/**
 * A profile: one of the agents that support it (`PROFILE_HOME_ENV`: Claude Code, Codex, Google Antigravity) again,
 * signed in to another account. It runs the same agent with its own config folder (`home`, as `CLAUDE_CONFIG_DIR` /
 * `CODEX_HOME` / `GEMINI_HOME`), so its login, settings and sessions are its own; its provider id is `<of>@<slug>`
 * (protocol `profileId`). Synara keeps its Claude profiles the same way, so one of its folders can be added as is and
 * is already signed in.
 */
export const ProviderProfileSchema = z.object({
  /** the agent this is a profile of ('claude-code', 'codex') */
  of: Id,
  /** the profile's own name ("Work", "sarthakfour") */
  name: z.string(),
  /** its config folder (absolute) */
  home: z.string(),
  /** `appubot`: a folder AppuBot made for it; `synara`: one of Synara's; `folder`: one the user had; `credit`: AppuBot AI, the included Claude credit's own (cloud.ts §6.13) */
  source: z.enum(['appubot', 'synara', 'folder', 'credit']).default('appubot'),
});
export type ProviderProfile = z.infer<typeof ProviderProfileSchema>;

/** A profile folder on this Mac that isn't an agent in AppuBot yet (`providers.profiles`). */
export const FoundProfileSchema = ProviderProfileSchema.extend({ source: z.enum(['synara', 'folder']) });
export type FoundProfile = z.infer<typeof FoundProfileSchema>;

export const SessionModelSchema = z.object({ id: z.string(), name: z.string(), description: z.string().optional() });
/** A key a login asks for: an environment variable the agent reads (an API key…), with how to show it. */
export const AuthEnvVarSchema = z.object({ name: z.string(), label: z.string().optional(), secret: z.boolean().default(true), optional: z.boolean().default(false) });
export const AuthMethodSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  kind: z.enum(['agent', 'terminal', 'env_var']).optional(),
  vars: z.array(AuthEnvVarSchema).optional(),
  /** where to get the key */
  link: z.string().optional(),
});
export type AuthMethod = z.infer<typeof AuthMethodSchema>;

export const ProviderSchema = z.object({
  id: Id,                                  // 'claude-code' | 'codex' | 'cursor' | 'grok' | 'copilot' | 'opencode' | custom
  name: z.string(),
  description: z.string().default(''),
  command: z.string(),                     // executable
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  icon: z.string().default('bot'),         // lucide icon name
  builtin: z.boolean().default(false),
  enabled: z.boolean().default(true),
  installHint: z.string().optional(),      // e.g. "npm i -g @zed-industries/claude-code-acp"
  installed: z.boolean().default(false),
  /** `providers.install` is installing the agent on the computer right now (its own download or its maker's installer) */
  installing: z.boolean().optional(),
  /** what the agent's install needs that the computer doesn't have: Node.js, for an agent that only installs with npm */
  installNeeds: z.literal('node').optional(),
  authStatus: ProviderAuthStatus.default('unknown'),
  /**
   * `kind`: `terminal` logins run in Terminal; `agent` ones the agent does by itself (usually in the browser), after
   * the keys in `vars` when it has some (Gemini's API key); `env_var` ones are only keys (`vars`) the agent reads from
   * its environment. Keys are saved with `providers.setKeys` and never come back (`keysSaved` names them).
   */
  authMethods: z.array(AuthMethodSchema).default([]),
  /** the keys saved for this agent (`providers.setKeys`), by variable name; their values never leave the Mac's core */
  keysSaved: z.array(z.string()).default([]),
  capabilities: z.object({
    loadSession: z.boolean().default(false),
    image: z.boolean().default(false),
    audio: z.boolean().default(false),
    embeddedContext: z.boolean().default(false),
  }).default({ loadSession: false, image: false, audio: false, embeddedContext: false }),
  version: z.string().optional(),
  lastError: z.string().optional(),
  /** the CLI's own login (absent until checked); see ProviderAuthSchema */
  auth: ProviderAuthSchema.optional(),
  /** AppuBot can sign the CLI out (`providers.logout`) */
  canLogOut: z.boolean().default(false),
  /** added from the ACP registry (`providers.addFromRegistry`): its entry and the version installed */
  registry: z.object({ id: z.string(), version: z.string() }).optional(),
  /** the registry's icon: a small monochrome SVG drawn in `currentColor` (agents without a mark of AppuBot's own) */
  iconSvg: z.string().optional(),
  /** newest version out (npm's `latest` for the CLI, the ACP registry's for an added agent); absent until checked */
  latestVersion: z.string().optional(),
  /** `latestVersion` is newer than `update.current` (`providers.update` installs it); absent until checked */
  updateAvailable: z.boolean().optional(),
  /** the update check (`providers.checkUpdates`); absent for agents AppuBot can't check (Cursor, Grok, custom ones) */
  update: ProviderUpdateSchema.optional(),
  /** a profile of a built-in (another account of the same agent); see ProviderProfileSchema */
  profile: ProviderProfileSchema.optional(),
  /** for an agent that has profiles (`PROFILE_HOME_ENV`): the name of its own, default one (absent: "Default") */
  profileName: z.string().optional(),
});
export type Provider = z.infer<typeof ProviderSchema>;

/**
 * An agent in the ACP registry (agentclientprotocol.com/registry) that can run on this Mac. `install` is how AppuBot
 * would run it: a download of its own (`binary`), or Node's `npx` / uv's `uvx`, which must be on the Mac.
 */
export const RegistryAgentSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  description: z.string().default(''),
  website: z.string().optional(),
  repository: z.string().optional(),
  iconSvg: z.string().optional(),
  install: z.enum(['binary', 'npx', 'uvx']),
  /** one of AppuBot's built-in agents (nothing to add) */
  builtinId: Id.optional(),
  /** added: the agent it became, and the registry version it runs */
  providerId: Id.optional(),
  installedVersion: z.string().optional(),
});
export type RegistryAgent = z.infer<typeof RegistryAgentSchema>;

export const SessionModeSchema = z.object({ id: z.string(), name: z.string(), description: z.string().optional() });
export const SlashCommandSchema = z.object({ name: z.string(), description: z.string().default(''), hint: z.string().optional() });
export type SessionMode = z.infer<typeof SessionModeSchema>;
export type SessionModel = z.infer<typeof SessionModelSchema>;
export type SlashCommand = z.infer<typeof SlashCommandSchema>;

/* ---------- bots ---------- */
/** Body of a bot's blob avatar (a coloured shape with two eyes, see the desktop/mobile BotAvatar). */
// apps from before 2026-11-18 know only the first eight and draw any other as the circle (chat-core `botAvatarLook`)
export const BotShape = z.enum(['circle', 'squircle', 'square', 'pill', 'triangle', 'hex', 'cloud', 'drop', 'egg', 'ghost', 'flower', 'shield', 'octagon', 'heart', 'diamond', 'bell', 'mushroom', 'bear']);
export type BotShape = z.infer<typeof BotShape>;
/** the eight shapes every computer takes; one from before 2026-11-18 refuses any other (`SystemInfo.botShapes` says) */
export const BOT_SHAPES_V1: readonly BotShape[] = ['circle', 'squircle', 'square', 'pill', 'triangle', 'hex', 'cloud', 'drop'];
/** The shapes a computer takes, from what it says about itself: all of this build's where it lists them, else the first eight. */
export function botShapesOf(system: { botShapes?: readonly string[] } | null | undefined): readonly BotShape[] {
  const listed = system?.botShapes;
  if (!listed) return BOT_SHAPES_V1;
  return BotShape.options.filter((s) => listed.includes(s));
}
/** Avatar palette for bots (blob colours). */
export const BOT_COLORS = ['#FF4A5A', '#FF7A1F', '#FFA826', '#16C47A', '#1FBFAE', '#2E8EFF', '#9A68FF', '#FF4FA8', '#A0764F', '#8E8E93'] as const;
/** The palette's names, in order (what a bot calls its colours; any #RRGGBB works too). */
export const BOT_COLOR_NAMES = ['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink', 'brown', 'grey'] as const;

export const BotSchema = z.object({
  id: Id,
  slug: z.string(),
  name: z.string(),
  emoji: z.string().default('🤖'),
  color: z.string().default('#ee7944'),
  shape: BotShape.default('circle'),
  job: z.string().default(''),            // one-line primary job
  instructions: z.string().default(''),   // system prompt / CLAUDE.md body
  providerId: Id,
  modelId: z.string().optional(),
  modeId: z.string().optional(),
  /**
   * Reasoning effort (the agent's `thought_level` option, e.g. low/medium/high), applied to its chat's session when
   * the model offers that level; otherwise the agent's own default applies.
   */
  effort: z.string().default('medium'),
  /** fast mode (Claude Code's `fast` option), applied to its chat's session where the model offers it */
  fast: z.boolean().default(false),
  workspace: z.string(),                   // absolute dir (~/AppuBot/<slug>)
  computerUse: z.boolean().default(true),
  /** unused for now (permissions follow the agent's own mode); kept so saved bots and older phones still parse */
  autoApprove: z.enum(['never', 'safe', 'always']).default('safe'),
  /**
   * Apps (Composio toolkit slugs) turned off for this bot. Apps are connected once for the whole Mac and every
   * connected app is on for every bot unless listed here, so a new connection starts on for all of them.
   */
  appsOff: z.array(z.string()).default([]),
  /** pinned to the top of the roster, as a tile (the app's right-click menu; any device sees it) */
  pinned: z.boolean().default(false),
  /**
   * A chief bot may message every bot at once (`message_bots`) and leads the groups it is in: the user's messages to a
   * group go to it, and its messages to the group reach every member. Any bot may message another bot one to one.
   */
  chief: z.boolean().default(false),
  /**
   * A custom character from the computer's library (`characters.*`) the bot wears instead of `shape`; absent, or one
   * that is gone, draws `shape`. `''` in `bots.update` takes it off.
   */
  characterId: z.string().optional(),
  /**
   * A team's AppuBot Cloud computer (`CloudInfo.logins`): the team member whose logins, keys, Vault and connected
   * apps this bot uses while the team's setting is "each person uses their own" (set from the device that made it;
   * an admin can move it with `bots.update`). Absent on a Mac, on a personal cloud computer, and on a team bot that
   * runs on the team's shared logins.
   */
  memberId: z.string().optional(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Bot = z.infer<typeof BotSchema>;

/* ---------- threads & messages ---------- */
export const ThreadStatus = z.enum(['idle', 'running', 'waiting', 'error']);
/**
 * A thread of a bot: one agent session (resumed across restarts). A bot has many; its current one (`currentChat`)
 * takes turns that name no thread (routines, teach mode, a send without `threadId`). Telegram chats are threads of
 * their own (`source: 'channel'`). What a bot keeps across threads is its memory (MEMORY.md), not the conversation.
 */
/**
 * A goal a bot works toward on its own in one thread, turn after turn, until it says it's done or stuck, or its
 * budget runs out. The bot proposes it (`start_goal`, an Allow card); AppuBot then prompts it again after each turn
 * (`GoalsService`). `paused`: stopped by the user (Stop, Pause) or out of turns or time, kept to resume.
 */
export const GoalSchema = z.object({
  objective: z.string(),
  status: z.enum(['active', 'paused', 'done', 'blocked', 'stopped']),
  /** turns it has taken on the goal so far */
  turns: z.number().int().nonnegative().default(0),
  /** at most this many */
  maxTurns: z.number().int().positive().default(20),
  /** no new turn after this moment */
  until: Timestamp.optional(),
  /** the bot's word when it finished (done: what it did; blocked: what it needs), or why AppuBot paused it */
  note: z.string().optional(),
  startedAt: Timestamp,
  updatedAt: Timestamp,
});
export type Goal = z.infer<typeof GoalSchema>;
/** a goal's turns when the bot doesn't say, and the most it may ask for */
export const GOAL_TURNS_DEFAULT = 20;
export const GOAL_TURNS_MAX = 100;
/** the longest a goal may run, in hours */
export const GOAL_HOURS_MAX = 24;

export const ThreadSchema = z.object({
  id: Id,
  botId: Id,
  title: z.string(),
  providerId: Id,
  acpSessionId: z.string().optional(),
  cwd: z.string(),
  status: ThreadStatus.default('idle'),
  modeId: z.string().optional(),
  modelId: z.string().optional(),
  modes: z.array(SessionModeSchema).default([]),
  models: z.array(SessionModelSchema).default([]),
  /** the current model's reasoning efforts (empty when it has no such choice) */
  effortId: z.string().optional(),
  efforts: z.array(SessionModelSchema).default([]),
  /**
   * How full the agent's context is (ACP `usage_update`: tokens in it now, and how many fit), for the composer's ring;
   * the agent compacts the conversation when it fills up. Absent until the agent reports it.
   */
  context: z.object({ used: z.number().nonnegative(), size: z.number().positive() }).optional(),
  /** the current model offers fast mode (Claude Code's `fast` option), and whether it is on */
  fastAvailable: z.boolean().default(false),
  fast: z.boolean().default(false),
  commands: z.array(SlashCommandSchema).default([]),
  /** `group`: the bot's thread for one group's conversation (never its current thread; `groupId` names the group) */
  source: z.enum(['desktop', 'mobile', 'routine', 'channel', 'group']).default('desktop'),
  routineId: Id.optional(),
  channel: z.string().optional(),
  groupId: Id.optional(),
  /** which of the group's threads (absent: its first, whose id is the group's) */
  groupChatId: Id.optional(),
  /** a goal it works toward on its own (`start_goal`) */
  goal: GoalSchema.optional(),
  lastMessagePreview: z.string().default(''),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  /**
   * When it was started or last sent a message (`chat.send`): the bot's thread with the latest is its current one.
   * Absent on threads saved by older versions (their `createdAt` counts).
   */
  lastActiveAt: Timestamp.optional(),
});
export type Thread = z.infer<typeof ThreadSchema>;

export const ToolKind = z.enum(['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'computer', 'other']);
export const ToolStatus = z.enum(['pending', 'in_progress', 'completed', 'failed']);

export const DiffContentSchema = z.object({ type: z.literal('diff'), path: z.string(), oldText: z.string().nullable(), newText: z.string() });
export const TerminalContentSchema = z.object({ type: z.literal('terminal'), terminalId: z.string(), output: z.string().optional(), exitCode: z.number().nullable().optional() });
export const TextContentSchema = z.object({ type: z.literal('text'), text: z.string() });
export const ImageContentSchema = z.object({ type: z.literal('image'), mimeType: z.string(), data: z.string(), /* base64 */ uri: z.string().optional() });
export const ResourceLinkSchema = z.object({ type: z.literal('resource_link'), uri: z.string(), name: z.string(), mimeType: z.string().optional(), title: z.string().optional(), size: z.number().optional() });
export const ToolContentSchema = z.discriminatedUnion('type', [TextContentSchema, ImageContentSchema, ResourceLinkSchema, DiffContentSchema, TerminalContentSchema]);
export type ToolContent = z.infer<typeof ToolContentSchema>;

export const FileAttachmentSchema = z.object({
  id: Id, name: z.string(), mimeType: z.string(), size: z.number(),
  url: z.string(),            // gateway-relative, e.g. /files/<id>
  path: z.string().optional(),// absolute path on the laptop
  caption: z.string().optional(),
});
export type FileAttachment = z.infer<typeof FileAttachmentSchema>;

/*
 * Computer actions. Pointer actions aimed at an app window (pid + windowId, by `element` token or by x/y pixels
 * of that window's snapshot) run in the background: the user's own mouse and focus are left alone.
 * Without a window, x/y are pixels of the last whole-screen screenshot.
 */
export const ComputerActionSchema = z.object({
  type: z.enum(['screenshot', 'window', 'click', 'double_click', 'right_click', 'move', 'drag', 'type', 'key', 'hotkey', 'scroll', 'open_app', 'focus_window', 'wait', 'accessibility', 'clipboard', 'other']),
  x: z.number().optional(), y: z.number().optional(),
  toX: z.number().optional(), toY: z.number().optional(),
  text: z.string().optional(),
  key: z.string().optional(),
  app: z.string().optional(),
  pid: z.number().int().optional(),
  windowId: z.number().int().optional(),
  /** element token from the window's last snapshot (or just its number there, e.g. "12") */
  element: z.string().optional(),
  /** an element by its accessibility label in the window's latest snapshot ("Save", "7"): taken when needed */
  label: z.string().optional(),
  /**
   * Background mode: the bot asks for this step to go out with its window briefly in front (after the user pauses),
   * because the same step did nothing in the background. Ignored on screen, where the window is in front anyway.
   */
  front: z.boolean().optional(),
  /** typing a Vault secret: its text never shows in the action feed, the logs or the chat */
  secret: z.boolean().optional(),
  detail: z.string().optional(),
});
/** The app window a frame shows (absent for whole-screen frames). Bounds are global screen points. */
export const ComputerTargetSchema = z.object({
  pid: z.number().int(),
  windowId: z.number().int(),
  app: z.string().optional(),
  title: z.string().optional(),
  bounds: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).optional(),
});
export type ComputerTarget = z.infer<typeof ComputerTargetSchema>;
export type ComputerAction = z.infer<typeof ComputerActionSchema>;

export const PlanEntrySchema = z.object({ content: z.string(), priority: z.enum(['high', 'medium', 'low']).default('medium'), status: z.enum(['pending', 'in_progress', 'completed']).default('pending') });

/* ---------- forms: interactive cards a bot asks the user to fill in ---------- */

/** What kind of input a form field is. An app that doesn't know a type shows a text box (`catch`). */
export const FormFieldType = z.enum(['text', 'longtext', 'number', 'email', 'url', 'phone', 'date', 'time', 'choice', 'multichoice', 'toggle', 'secret', 'file', 'rating', 'code']);
export type FormFieldType = z.infer<typeof FormFieldType>;

export const FormFieldSchema = z.object({
  /** the key its value comes back under */
  id: z.string().min(1).max(40),
  label: z.string().min(1).max(120),
  type: FormFieldType.catch('text'),
  required: z.boolean().default(false),
  /** choice / multichoice */
  options: z.array(z.string().max(200)).max(20).default([]),
  placeholder: z.string().max(200).optional(),
  /** a line under it */
  hint: z.string().max(300).optional(),
  /** filled in to start with (never for a secret) */
  value: z.string().max(4000).optional(),
  /** rating: the top mark (2–10; 5 when left out); code: how many characters the one-time code has (4 to 8; 6 when left out) */
  max: z.number().int().min(2).max(10).optional(),
  /** file: the extensions it takes ("pdf", "csv"); any file when left out */
  accept: z.array(z.string().max(20)).max(20).optional(),
});
export type FormField = z.infer<typeof FormFieldSchema>;
/** A file field's value as a device sends it: `file:<id>` of a file it uploaded (`POST /api/files`); a bare path is this computer's own. */
export const FORM_FILE_PREFIX = 'file:';

/** The Vault kinds a bot may ask the user to add (protocol `vault.ts` `VaultKind`; kept here so entities stay first). */
export const FormVaultKind = z.enum(['login', 'card', 'contact', 'apiKey']);

/** One change a card asks the user to allow: what, the new value, what it was, and whether it grants the bot power. */
export const FormChangeSchema = z.object({
  label: z.string().max(60),
  value: z.string().max(6000),
  was: z.string().max(6000).optional(),
  /** computer use, an app, Full access, another agent: shown with a shield */
  grants: z.boolean().default(false),
});
export type FormChange = z.infer<typeof FormChangeSchema>;

/** A Vault card's saved item, as the card offers it instead of typing a new one (never a secret). */
export const FormSavedItemSchema = z.object({ id: Id, name: z.string(), detail: z.string().default('') });

/**
 * A question that is a form (`ask_form`) or a request for a Vault item (`vault_request`): fields the user fills in on the
 * card. A Vault card's fields are AppuBot's own (by `vault.kind`), its secrets go straight into the Vault, and the bot
 * only learns the saved item's name and id; it may also offer the items of that kind already saved (`vault.saved`).
 */
export const QuestionFormSchema = z.object({
  /**
   * `form`: the bot's own fields; `vault`: a Vault item (fields AppuBot's own); `app`: connect an app or turn it on
   * for the bot (`apps_request`: no fields, the card's buttons do it); `telegram`: connect a Telegram bot to this
   * bot (`telegram_request`: a token field, typed in on the computer only); `routine`: a routine the bot proposes
   * (`create_routine`: its schedule as fields the user can adjust before allowing it; `update_routine`: its changes,
   * the new schedule adjustable too); `bot`: a bot the caller wants to make or change (`create_bot`: its name a field,
   * `update_bot`: each change as a row). An app from before shows a kind it doesn't know as a plain form.
   */
  kind: z.enum(['form', 'vault', 'app', 'telegram', 'routine', 'bot', 'goal']).catch('form'),
  fields: z.array(FormFieldSchema).max(20).default([]),
  /** the submit button's words ("Send", "Save to Vault") */
  submit: z.string().max(40).optional(),
  vault: z.object({
    kind: FormVaultKind,
    /** why the bot needs it, in its words */
    reason: z.string().max(500).optional(),
    saved: z.array(FormSavedItemSchema).max(50).default([]),
  }).optional(),
  /** the app an `app` card is about, and where it stood when the card was made (the apps read the live state) */
  app: z.object({
    slug: z.string().min(1),
    name: z.string().min(1),
    logo: z.string().optional(),
    reason: z.string().max(500).optional(),
    /** `sign-in`: not signed in to Composio; `connect`: not connected; `turn-on`: connected, off for this bot */
    state: z.enum(['sign-in', 'connect', 'turn-on']),
  }).optional(),
  /** a `telegram` card: the AppuBot bot the Telegram bot will answer as */
  telegram: z.object({
    botName: z.string(),
    reason: z.string().max(500).optional(),
  }).optional(),
  /** a `routine` card: what it will send the bot, on the schedule the fields describe */
  routine: z.object({
    prompt: z.string(),
    /** the schedule the bot proposed, as cron (the fields start from it) */
    schedule: z.string(),
    /** another bot's routine */
    forBot: z.string().optional(),
    /** `update`: a change to a routine that exists (`changes` say what moves; the fields, when there are any, its new schedule) */
    action: z.enum(['create', 'update']).default('create'),
    changes: z.array(FormChangeSchema).default([]),
  }).optional(),
  /** a `goal` card: what the bot proposes to work on by itself until done (the fields: the objective and its turns) */
  goal: z.object({ objective: z.string(), maxTurns: z.number().int().positive(), hours: z.number().positive().optional() }).optional(),
  /** a `bot` card: the bot as it would be once allowed, and (an update) what changes */
  bot: z.object({
    action: z.enum(['create', 'update']),
    /** its name (a new bot's proposed one; the name field, when the card has one, starts from it) */
    name: z.string(),
    color: z.string().optional(),
    shape: BotShape.optional(),
    characterId: z.string().optional(),
    /** a new bot's setup (an update's changes carry the rest) */
    job: z.string().optional(),
    instructions: z.string().optional(),
    /** the agent it runs on, as the apps name it */
    agent: z.string().optional(),
    computerUse: z.boolean().optional(),
    /** the caller changing itself */
    self: z.boolean().default(false),
    changes: z.array(FormChangeSchema).default([]),
  }).optional(),
});
export type QuestionForm = z.infer<typeof QuestionFormSchema>;

/** A form's answer as sent: text, a multichoice's picks, a toggle. */
export const FormValue = z.union([z.string().max(10000), z.array(z.string().max(200)).max(20), z.boolean()]);
export type FormValue = z.infer<typeof FormValue>;

export const PartSchema = z.discriminatedUnion('type', [
  /** `said`: a message the bot sent on its own (`send_message`), a chat bubble of its own wherever it falls in the turn */
  z.object({ type: z.literal('text'), text: z.string(), said: z.boolean().optional() }),
  z.object({ type: z.literal('thought'), text: z.string() }),
  z.object({ type: z.literal('image'), mimeType: z.string(), data: z.string().optional(), url: z.string().optional() }),
  z.object({ type: z.literal('file'), file: FileAttachmentSchema }),
  z.object({
    type: z.literal('tool_call'),
    toolCallId: z.string(),
    title: z.string(),
    kind: ToolKind.default('other'),
    status: ToolStatus.default('pending'),
    content: z.array(ToolContentSchema).default([]),
    locations: z.array(z.object({ path: z.string(), line: z.number().optional() })).default([]),
    rawInput: z.unknown().optional(),
    rawOutput: z.unknown().optional(),
    computer: z.object({ action: ComputerActionSchema.optional(), frameId: z.string().optional() }).optional(),
    startedAt: Timestamp.optional(),
    endedAt: Timestamp.optional(),
  }),
  z.object({ type: z.literal('plan'), entries: z.array(PlanEntrySchema) }),
  /**
   * A question the bot asked (`ask_user`), or a card to fill in (`form`: `ask_form`, `vault_request`). `answer`: what the
   * user answered, in words (a form's: a short summary, never a secret); `values`: a form's answers, secrets left out;
   * `declined`: the user turned the form down; `savedId`: the Vault item a Vault card saved or picked.
   */
  z.object({
    type: z.literal('question'), questionId: Id, question: z.string(), options: z.array(z.string()).default([]), answer: z.string().optional(),
    form: QuestionFormSchema.optional(),
    values: z.record(z.string(), FormValue).optional(),
    declined: z.boolean().optional(),
    savedId: Id.optional(),
  }),
  z.object({ type: z.literal('system'), text: z.string(), level: z.enum(['info', 'warning', 'error']).default('info') }),
  /**
   * Speech: the user's recording behind a spoken message (`kind: 'recording'`; the bot only ever got its text) or the
   * reading of a bot's reply (`kind: 'reply'`), an OGG/Opus or WebM/Opus file any client plays. `transcript`: what was
   * heard or read. Never shown to the agent.
   */
  z.object({ type: z.literal('voice'), file: FileAttachmentSchema, durationMs: z.number().nonnegative(), kind: z.enum(['recording', 'reply']), transcript: z.string().optional() }),
  /**
   * A visual reply (the bot's `show_page`, T3 Code's visual replies): a self-contained HTML page (chart, table, diagram,
   * collage) kept as a file and drawn in the chat in a sandbox that can't reach the network or the app.
   */
  z.object({ type: z.literal('page'), title: z.string(), file: FileAttachmentSchema }),
]);
export type Part = z.infer<typeof PartSchema>;

export const MessageStatus = z.enum(['streaming', 'complete', 'cancelled', 'error']);
/**
 * An emoji reaction on a message: the user's on a bot's reply (they pick it under the reply; the bot hears about it on
 * its next turn), the bot's on the user's message (its `react` tool). At most one per side per message.
 */
export const ReactionSchema = z.object({ emoji: z.string().min(1).max(16), by: z.enum(['user', 'bot']), at: Timestamp });
export type Reaction = z.infer<typeof ReactionSchema>;

/**
 * A message's revision on the computer: 1 when it is made, one more with every change sent as an event. Optional
 * (older computers don't send it, and a change not yet stamped has none).
 */
export const MessageRev = z.number().int().nonnegative().optional();

export const MessageSchema = z.object({
  id: Id,
  threadId: Id,
  role: z.enum(['user', 'agent']),
  parts: z.array(PartSchema),
  status: MessageStatus.default('complete'),
  stopReason: z.string().optional(),
  error: z.string().optional(),
  /** `bot`: sent by another bot (`message_bot`, or a bot's message in a group), named in `from` */
  via: z.enum(['desktop', 'mobile', 'routine', 'channel', 'system', 'bot']).default('desktop'),
  /**
   * the bot that sent this message (`via: 'bot'`); on an agent message, the other bot whose answer it is: a hand-off in a
   * bot's chat (`@Name`, chat-core handoff.ts), drawn with that bot's avatar and name. An app from before hand-offs
   * reads such a reply as the chat's own bot's.
   */
  from: z.object({ botId: Id, name: z.string() }).optional(),
  /**
   * the routine that sent this prompt (`via: 'routine'`), by id and its name then: the chat shows it as one compact line
   * named after it, and folds its runs that had nothing to say (chat-core `foldRoutineRuns`). Absent on prompts from
   * before it existed (or from an older computer): those read "Routine".
   */
  routine: z.object({ id: Id, name: z.string() }).optional(),
  reactions: z.array(ReactionSchema).optional(),
  /** a user message's id on the device that sent it (`chat.send clientId`) */
  clientId: z.string().max(100).optional(),
  /** which change this copy is at (`MessageRev`): of two copies of a message, the higher one is newer */
  rev: MessageRev,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Message = z.infer<typeof MessageSchema>;

/* ---------- permissions ---------- */
export const PermissionOptionSchema = z.object({ optionId: z.string(), name: z.string(), kind: z.enum(['allow_once', 'allow_always', 'reject_once', 'reject_always']) });
export const PermissionRequestSchema = z.object({
  id: Id,
  threadId: Id,
  botId: Id,
  toolCallId: z.string().optional(),
  title: z.string(),
  kind: ToolKind.default('other'),
  content: z.array(ToolContentSchema).default([]),
  rawInput: z.unknown().optional(),
  options: z.array(PermissionOptionSchema),
  createdAt: Timestamp,
  resolvedAt: Timestamp.optional(),
  selectedOptionId: z.string().optional(),
});
export type PermissionRequest = z.infer<typeof PermissionRequestSchema>;

/* ---------- devices & pairing ---------- */
/**
 * Where a phone can reach the Mac directly: a Tailscale address (100.64.0.0/10 or fd7a:115c:a1e0::/48), its MagicDNS
 * name (`*.ts.net`), a private local-network address (the Mac's Wi-Fi/Ethernet IP), or this Mac itself. AppuBot
 * Connect is not a host in this list: it is one relay (connect.appubot.com) plus a room id, tracked on its own.
 */
export const HostKind = z.enum(['tailscale', 'lan', 'loopback', 'magicdns']);
export const CONNECT_DOMAIN = 'appubot.com';
export type HostKind = z.infer<typeof HostKind>;
export const HostCandidateSchema = z.object({ host: z.string(), port: z.number(), kind: HostKind });
export type HostCandidate = z.infer<typeof HostCandidateSchema>;
/**
 * The way a connection runs: over Tailscale (an address or MagicDNS name), the local network, AppuBot Connect (the relay),
 * on the Mac itself, or from the internet to an AppuBot Cloud computer's public port (`cloud`: every peer of a cloud
 * gateway that isn't the computer itself; only the end-to-end channel is served there).
 */
export const NetRoute = z.enum(['tailscale', 'lan', 'local', 'connect', 'cloud']);

/**
 * AppuBot Connect on this computer: `off` (switched off, or no phone paired yet), `starting` (dialing the relay and
 * claiming its room), `up` (the relay socket is live, so phones can reach this Mac from anywhere), `down` (lost the
 * relay; it retries by itself), `error` (what went wrong is in `error`). `connectId` is the room a paired phone joins.
 */
export const ConnectStatusSchema = z.object({
  state: z.enum(['off', 'starting', 'up', 'down', 'error']),
  connectId: z.string().optional(),
  /**
   * the Mac's X25519 public key (base64url) for end-to-end encryption, through AppuBot Connect and on the same Wi-Fi
   * (sent whether Connect is on or not). The pairing QR carries it too; a phone takes it from here only over a route
   * that is itself authenticated (Tailscale, or the channel itself), never from anything unencrypted on the Wi-Fi,
   * where someone on it could swap it.
   */
  connectKey: z.string().optional(),
  error: z.string().optional(),
  /** when the state was last set */
  since: Timestamp,
});
export type ConnectStatus = z.infer<typeof ConnectStatusSchema>;
export type NetRoute = z.infer<typeof NetRoute>;

export const DevicePlatform = z.enum(['ios', 'android', 'desktop', 'web', 'cli', 'unknown']);
export const DeviceSchema = z.object({
  id: Id, name: z.string(), platform: DevicePlatform, role: z.enum(['owner', 'full', 'limited']).default('full'),
  pairedAt: Timestamp, lastSeenAt: Timestamp.optional(), lastIp: z.string().optional(), tailscaleUser: z.string().optional(), online: z.boolean().default(false),
  /** how it reached the Mac on its latest connection (absent from Macs that predate it) */
  route: NetRoute.optional(),
  /** the AppuBot version it ran on its latest connection (absent from devices that didn't say) */
  appVersion: z.string().max(40).optional(),
  /** it gets notifications from this computer: it registered for them and they aren't turned off here (never its token) */
  pushOn: z.boolean().optional(),
  /** this computer's switch for its notifications is off (Settings › Devices) */
  pushOff: z.boolean().optional(),
});
export type Device = z.infer<typeof DeviceSchema>;

/** what a phone notification is about: a task finished, the bot needs you (an approval, a question), or it failed */
export const PushKindSchema = z.enum(['done', 'needs-you', 'failed']);
export type PushKind = z.infer<typeof PushKindSchema>;
export const PUSH_KINDS: readonly PushKind[] = PushKindSchema.options;

/**
 * A phone's registration for notifications on one computer (`devices.setPush`): its Firebase Cloud Messaging token,
 * whether they show what the bot said (`previews`) and which kinds it wants. Kept by the computer, never sent back.
 */
export const PushRegistrationSchema = z.object({
  token: z.string().min(1).max(4096),
  platform: z.enum(['ios', 'android']),
  previews: z.boolean().default(true),
  kinds: z.array(PushKindSchema).max(3).default(['done', 'needs-you', 'failed']),
});
export type PushRegistration = z.infer<typeof PushRegistrationSchema>;

export const PairingInfoSchema = z.object({
  code: z.string(),              // 6 digits shown on laptop
  expiresAt: Timestamp,
  /** direct addresses the phone may use, Tailscale and local network alike (the QR carries them all) */
  hosts: z.array(HostCandidateSchema),
  /** AppuBot Connect room this Mac listens on (absent when Connect is off): the phone reaches it from anywhere */
  connectId: z.string().optional(),
  /**
   * the Mac's X25519 public key (base64url) for end-to-end encryption, on the same Wi-Fi and over the relay; the phone
   * pins it from the QR (always there, Connect on or off)
   */
  connectKey: z.string().optional(),
  url: z.string(),               // appubot://pair?... encoded for QR
  hostName: z.string(),
});
export type PairingInfo = z.infer<typeof PairingInfoSchema>;

/* ---------- computer use ---------- */
/**
 * Live view watches by default; one person at a time takes control (`computer.control`): their input goes to the
 * screen and every bot's computer use on that computer waits until they hand it back (Watching again, the view
 * closed, or CONTROL_IDLE_MS without input from them). `id` is this hold's own (the holder's `computer.control` answer
 * names it, so a client knows the control is its own); `name` says who (a device, a person).
 * `via`: the phone's or any device's live view (`live`), the desktop app's noVNC viewer (`desktop`), noVNC's stock
 * page on a local test computer only (`browser`: never on a real one, there is no browser way in).
 */
export const ScreenControlSchema = z.object({
  id: z.string().max(64),
  name: z.string().max(120),
  via: z.enum(['live', 'desktop', 'browser']),
  since: Timestamp,
  /** control goes back by itself at this time unless the holder gives input (or renews it) first */
  expiresAt: Timestamp,
  /** how long that was from when this was told, in ms (views count down from when they heard it: no clock skew) */
  left: z.number().int().nonnegative(),
});
export type ScreenControl = z.infer<typeof ScreenControlSchema>;
/** no input from the person in control for this long: control goes back to the bots */
export const CONTROL_IDLE_MS = 2 * 60_000;
/** the last stretch before that, when the views count down ("Back to the bots in 12 s") and offer to keep control */
export const CONTROL_WARN_MS = 20_000;
/**
 * A bot's computer step waiting: `control`, for the person in control to give it back; `screen`, for another bot's
 * turn on the one screen to end (your AppuBot computer, where bots take turns on its real screen: `holder` is the
 * thread that has it).
 */
export const ScreenWaitSchema = z.object({ threadId: Id, for: z.enum(['control', 'screen']), since: Timestamp, holder: Id.optional() });
export type ScreenWait = z.infer<typeof ScreenWaitSchema>;

export const ComputerStatusSchema = z.object({
  backend: z.enum(['cua-driver', 'native', 'none']),
  available: z.boolean(),
  permissions: z.object({ accessibility: z.boolean(), screenRecording: z.boolean(), inputMonitoring: z.boolean().optional() }),
  screen: z.object({ width: z.number(), height: z.number(), scale: z.number() }).optional(),
  busy: z.boolean().default(false),
  paused: z.boolean().default(false),
  activeThreadId: Id.optional(),
  liveView: z.boolean().default(true),
  /** background mode (`settings.computer.background`): bots work in their windows without bringing them forward */
  background: z.boolean().default(false),
  /**
   * Background mode: a bot's step needs its window in front for a moment (a click or typing on a web page, a drag…)
   * and is waiting for the user to stop typing and moving the mouse. `app` is the app it works in.
   */
  waiting: z.object({ threadId: Id.optional(), app: z.string().optional(), since: Timestamp }).optional(),
  /**
   * This computer's live view watches until a viewer takes control (`computer.control`); `computer.liveInput` only
   * from the viewer in control. Absent from a computer from before, where any full-access viewer's input went.
   */
  takeControl: z.boolean().optional(),
  /** who has control of the screen now (absent: nobody; the bots may use it) */
  control: ScreenControlSchema.optional(),
  /** bots' computer steps waiting for control to come back, or for their turn on the screen */
  waits: z.array(ScreenWaitSchema).optional(),
  /** your AppuBot computer: the thread whose bot has the screen now (bots take turns on it) */
  screenThreadId: Id.optional(),
  /** the bots always work on the real screen here (your AppuBot computer: it is theirs); no background mode */
  onScreenOnly: z.boolean().optional(),
});
export type ComputerStatus = z.infer<typeof ComputerStatusSchema>;

export const ComputerFrameSchema = z.object({
  id: Id,
  threadId: Id.optional(),
  mimeType: z.string(),
  data: z.string(),             // base64 jpeg/png
  width: z.number(),
  height: z.number(),
  ts: Timestamp,
  action: ComputerActionSchema.optional(),
  target: ComputerTargetSchema.optional(),
});
export type ComputerFrame = z.infer<typeof ComputerFrameSchema>;

/* ---------- live view (watching and using the computer from a phone) ---------- */

/**
 * One picture of the computer's screen for a device watching it (`computer.watch`), the cursor drawn in. Numbered:
 * the device confirms each one it has shown (`computer.liveAck`), and the computer sends only a couple ahead of
 * that, so a slow link gets fewer pictures rather than a growing queue.
 */
export const LiveFrameSchema = z.object({
  seq: z.number().int(),
  data: z.string(),       // base64 JPEG, without the cursor: the device draws it where `cursor` says
  width: z.number(),
  height: z.number(),
  ts: Timestamp,
  /** where the computer's pointer is, 0..1 across and down the picture (absent: on another display) */
  cursor: z.object({ x: z.number(), y: z.number() }).optional(),
  /** the display's size in points (where scrolls are measured), so a device learns of a new resolution */
  screen: z.object({ width: z.number(), height: z.number() }).optional(),
  /**
   * the newest of this device's inputs (`LiveInput.seq`) the computer had carried out when it took the picture: a
   * picture taken before your latest move landed says nothing about where your pointer is
   */
  inputSeq: z.number().int().optional(),
});
export type LiveFrame = z.infer<typeof LiveFrameSchema>;

/** the video codecs live view can stream (`computer.watch {video: {codecs}}`); a device names those it decodes */
export const LIVE_VIDEO_CODECS = ['h264'] as const;

/**
 * Live view as video (a device that asked for it in `computer.watch`): one encoded frame of the screen, H.264 with no
 * frame reordering, in decode order. Numbered like pictures and confirmed the same way (`computer.liveAck`). A frame
 * depends on the ones before it back to the last keyframe, so the computer never skips one it then sends past: a link
 * that falls behind gets nothing until it has caught up, then a keyframe. A device whose decoder lost its place asks
 * for one (`computer.liveKey`). A still screen sends nothing.
 */
export const LiveVideoSchema = z.object({
  seq: z.number().int(),
  /** base64 access unit, AVCC: each NAL unit after its length (4 bytes, big-endian) */
  data: z.string(),
  /** a keyframe (IDR): decodes on its own, the place to (re)start */
  key: z.boolean(),
  /** with every keyframe: the sequence and picture parameter sets (base64 NAL units, no start code) */
  sps: z.string().optional(),
  pps: z.string().optional(),
  width: z.number(),
  height: z.number(),
  ts: Timestamp,
  /** where the computer's pointer is, 0..1 across and down (absent: on another display) */
  cursor: z.object({ x: z.number(), y: z.number() }).optional(),
  /** the display's size in points (where scrolls are measured) */
  screen: z.object({ width: z.number(), height: z.number() }).optional(),
  /** the newest of this device's inputs carried out when the frame went (as `LiveFrame.inputSeq`) */
  inputSeq: z.number().int().optional(),
});
export type LiveVideo = z.infer<typeof LiveVideoSchema>;

/** A point on the screen being watched, 0..1 across and down. */
const Frac = z.number().min(0).max(1);
/** the device's own count of its inputs, which pictures answer with `inputSeq` */
const InputSeq = { seq: z.number().int().optional() };

/**
 * What the person watching does on the computer (`computer.liveInput`): their own hand on it, real input like their
 * own mouse and keyboard (not a bot's step). `scroll`'s dx/dy are points of the screen, positive scrolling down or
 * right. `paste` puts text on the computer's clipboard and pastes it; `copy` reads the computer's clipboard.
 */
export const LiveInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('click'), x: Frac, y: Frac, button: z.enum(['left', 'right']).default('left'), count: z.number().int().min(1).max(3).default(1), ...InputSeq }),
  z.object({ kind: z.literal('move'), x: Frac, y: Frac, ...InputSeq }),
  z.object({ kind: z.literal('down'), x: Frac, y: Frac, ...InputSeq }),
  z.object({ kind: z.literal('up'), x: Frac, y: Frac, ...InputSeq }),
  z.object({ kind: z.literal('scroll'), x: Frac, y: Frac, dx: z.number().min(-20000).max(20000), dy: z.number().min(-20000).max(20000), ...InputSeq }),
  z.object({ kind: z.literal('type'), text: z.string().min(1).max(10000), ...InputSeq }),
  z.object({ kind: z.literal('key'), key: z.string().min(1).max(40), modifiers: z.array(z.string().max(10)).max(4).default([]), ...InputSeq }),
  z.object({ kind: z.literal('paste'), text: z.string().max(100000), ...InputSeq }),
  z.object({ kind: z.literal('copy'), ...InputSeq }),
]);
export type LiveInput = z.infer<typeof LiveInputSchema>;

/**
 * What a viewer that drives the screen another way (the desktop app's noVNC view of your AppuBot computer) tells a
 * teach session it did, so the recording there is the same as from live view (`computer.liveInput`): 0..1 of the
 * screen, like live input.
 */
export const TeachInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('click'), x: Frac, y: Frac, button: z.enum(['left', 'right']).default('left'), count: z.number().int().min(1).max(3).default(1) }),
  z.object({ kind: z.literal('type'), text: z.string().min(1).max(10000) }),
  z.object({ kind: z.literal('key'), key: z.string().min(1).max(40), modifiers: z.array(z.string().max(10)).max(4).default([]) }),
  z.object({ kind: z.literal('scroll'), x: Frac, y: Frac, dx: z.number().min(-20000).max(20000), dy: z.number().min(-20000).max(20000) }),
]);
export type TeachInput = z.infer<typeof TeachInputSchema>;

/* ---------- skills (taught workflows) ---------- */
export const SkillSchema = z.object({
  name: z.string(), description: z.string().default(''), path: z.string(),
  source: z.enum(['taught', 'user', 'bundled']).default('user'),
  botId: Id.optional(), updatedAt: Timestamp,
  body: z.string().optional(),
});
export type Skill = z.infer<typeof SkillSchema>;

export const TeachSessionSchema = z.object({
  id: Id, botId: Id, name: z.string(), goal: z.string().default(''),
  status: z.enum(['recording', 'summarizing', 'done', 'cancelled', 'error']),
  startedAt: Timestamp, endedAt: Timestamp.optional(), stepCount: z.number().default(0), threadId: Id.optional(), skillName: z.string().optional(), error: z.string().optional(),
});
export type TeachSession = z.infer<typeof TeachSessionSchema>;

/* ---------- moving a bot between computers (a bundle: `bots.export` / `bots.import`) ---------- */
/**
 * What a bot's bundle holds, told before it is carried over: the bot's own setup (name, look, job, instructions,
 * agent, model...), its memory, skills and the files in its folder, its routines, its chats with their files, and the
 * Telegram bot it answered as (by handle only). Never a secret: no agent keys, logins, Vault entries, connected apps'
 * tokens or Telegram tokens travel; those stay with each computer and person.
 */
export const BotBundleManifestSchema = z.object({
  version: z.literal(1),
  exportedAt: Timestamp,
  from: z.object({ hostName: z.string(), platform: z.string(), cloud: z.boolean(), version: z.string().optional() }),
  bot: z.object({ name: z.string(), job: z.string().default(''), color: z.string(), shape: z.string(), providerId: z.string(), modelId: z.string().optional(), effort: z.string().optional(), computerUse: z.boolean(), characterName: z.string().optional() }),
  counts: z.object({ threads: z.number().int(), messages: z.number().int(), routines: z.number().int(), skills: z.number().int(), files: z.number().int(), workspaceFiles: z.number().int(), bytes: z.number().int() }),
  /** the Telegram bot this bot answered as, by handle (its token stays where it is) */
  telegram: z.object({ handle: z.string() }).optional(),
  /** apps (Composio toolkit slugs) the bot used there; they connect per computer and person, so they're only named */
  apps: z.array(z.string()).default([]),
});
export type BotBundleManifest = z.infer<typeof BotBundleManifestSchema>;

/** what `bots.import` did with a bundle: the bot made, and what needs doing by hand (one line each) */
export const BotImportResultSchema = z.object({
  bot: z.lazy(() => BotSchema),
  manifest: BotBundleManifestSchema,
  notes: z.array(z.string()),
  counts: z.object({ threads: z.number().int(), messages: z.number().int(), routines: z.number().int(), skills: z.number().int(), files: z.number().int() }),
});
export type BotImportResult = z.infer<typeof BotImportResultSchema>;

/* ---------- routines ---------- */
export const RoutineSchema = z.object({
  id: Id, botId: Id, name: z.string(), prompt: z.string(),
  schedule: z.string(),          // cron expression (5 or 6 fields)
  enabled: z.boolean().default(true),
  deliverTo: z.enum(['thread', 'notify']).default('notify'),
  lastRunAt: Timestamp.optional(), nextRunAt: Timestamp.optional(), lastThreadId: Id.optional(),
  createdAt: Timestamp, updatedAt: Timestamp,
});
export type Routine = z.infer<typeof RoutineSchema>;

/* ---------- channels (Telegram etc.) ---------- */
/**
 * One Telegram bot (its own token and @handle) wired to one AppuBot bot. There can be several, so each bot can have
 * its own handle; the first one made before that existed keeps the id `telegram`. Its chats are threads with
 * `channel: "<channel id>:<telegram chat id>"`.
 */
export const ChannelSchema = z.object({
  id: z.string().min(1), enabled: z.boolean().default(false), botId: Id.optional(),
  status: z.enum(['stopped', 'running', 'error']).default('stopped'), error: z.string().optional(),
  allowedUsers: z.array(z.string()).default([]), pairingCode: z.string().optional(), botUsername: z.string().optional(),
});
export type Channel = z.infer<typeof ChannelSchema>;

/* ---------- apps (the user's own Composio account) ---------- */
/**
 * Composio wiring as the app sees it: the user signs in to their own Composio account ("Composio for You", OAuth in
 * the browser); its tokens stay on this computer (apps.json, never in any payload). `account` is who is signed in
 * (an email when Composio says it). `pending` lists toolkits whose sign-in is in progress.
 */
export const AppsStatusSchema = z.object({
  /** signed in to Composio */
  configured: z.boolean(),
  account: z.string().optional(),
  /** a browser sign-in to Composio is waiting for the user */
  signingIn: z.boolean().default(false),
  pending: z.array(z.string()).default([]),
  /** the last problem reaching Composio, cleared by the next success */
  error: z.string().optional(),
  /**
   * this computer also connects apps on their own servers (`isDirectApp`): those need no Composio sign-in, and
   * `apps.connections` answers with them while signed out
   */
  direct: z.boolean().optional(),
});
export type AppsStatus = z.infer<typeof AppsStatusSchema>;

/**
 * The desktop app's own return address for a Composio sign-in it runs for an AppuBot Cloud computer (`apps.signIn
 * {redirectUri}`): the browser on the user's computer comes back to AppuBot with `?code=…&state=…` (or `?error=…`),
 * and the window hands them to the cloud with `apps.finishSignIn`. This computer's own sign-in keeps its loopback page.
 */
export const APPS_SIGNED_IN_LINK = 'appubot://apps/signed-in';

/** How a toolkit signs in: OAuth in a browser window, an API key, nothing at all, or only through Composio's page. */
export const AppAuthKind = z.enum(['oauth', 'api_key', 'none', 'other']);
export type AppAuthKind = z.infer<typeof AppAuthKind>;

export const AppCategorySchema = z.object({ id: z.string(), name: z.string(), count: z.number().int().nonnegative().optional() });
export type AppCategory = z.infer<typeof AppCategorySchema>;

/** A Composio toolkit (Gmail, Slack, …). `categories` holds category ids. */
export const AppToolkitSchema = z.object({
  slug: z.string(),
  name: z.string(),
  logo: z.string().optional(),
  description: z.string().optional(),
  categories: z.array(z.string()).default([]),
  authKind: AppAuthKind,
});
export type AppToolkit = z.infer<typeof AppToolkitSchema>;

/**
 * A connected account in the user's Composio account; `status` is Composio's (ACTIVE, INITIATED, FAILED, …), upper case.
 * An app can have several (two Gmails): `label` is who the account is at the app (its address or name, when the app
 * says), `alias` the name it was given at Composio, and `isDefault` marks the one the bots' calls use when they name
 * no account.
 */
export const AppConnectionSchema = z.object({
  slug: z.string(), connectedAccountId: z.string(), status: z.string(),
  label: z.string().optional(), alias: z.string().optional(), isDefault: z.boolean().optional(),
});
export type AppConnection = z.infer<typeof AppConnectionSchema>;


/* ---------- settings ---------- */
/**
 * Live-view picture quality on each device: `auto` follows that device's network (round trip and backlog), the others
 * fix it. The bot itself always sees full-quality screenshots. (`frameQuality`, `maxFrameWidth` and
 * `requireApprovalForFirstAction` below are unused now, kept so saved settings still parse.)
 */
export const LiveQuality = z.enum(['auto', 'best', 'balanced', 'saver']);
export type LiveQuality = z.infer<typeof LiveQuality>;

export const ChatView = z.enum(['answers', 'everything']);
export type ChatView = z.infer<typeof ChatView>;

/** `settings.globalInstructions` at most: Telegram-sized, not a novel, so every bot's file stays readable for the agent. */
export const GLOBAL_INSTRUCTIONS_MAX = 8000;

export const SettingsSchema = z.object({
  theme: z.enum(['system', 'light', 'dark']).default('system'),
  defaultProviderId: Id.default('claude-code'),
  /** the model new bots on the default agent start with; empty: the agent's own default */
  defaultModelId: z.string().default(''),
  /** the reasoning effort new bots start with (`Bot.effort`) */
  defaultEffort: z.string().default('medium'),
  /** fast mode for new bots (`Bot.fast`; applied where the model offers it) */
  defaultFast: z.boolean().default(false),
  /** the permission mode new bots start with (`Bot.modeId`; applied where the agent offers it, e.g. Claude Code's Bypass, "Full access") */
  defaultModeId: z.string().default('bypassPermissions'),
  /**
   * Who may reach the gateway. bind `tailscale`: tailnet peers (checked with `tailscale whois` when
   * requireTailscalePeer) and, with allowLan, peers on the local network (private addresses), so a paired phone on
   * the same Wi-Fi still works with Tailscale off; `all`: any address; `loopback`: this Mac only. Every route still
   * needs a paired device's token (pairing itself needs the code shown on the Mac).
   */
  gateway: z.object({ port: z.number().default(7890), bind: z.enum(['tailscale', 'all', 'loopback']).default('tailscale'), requireTailscalePeer: z.boolean().default(true), allowLan: z.boolean().default(true) }).default({ port: 7890, bind: 'tailscale', requireTailscalePeer: true, allowLan: true }),
  /** AppuBot Connect: a Cloudflare tunnel into this computer, so paired phones reach it from anywhere (on by default; it only runs once a phone is paired) */
  connect: z.object({ enabled: z.boolean().default(true) }).default({ enabled: true }),
  // agentCursor: draw the bot's pointer (with its avatar) on the Mac's screen while it uses the computer
  // background: act on app windows without bringing them to the front, so the user keeps working meanwhile; a step
  //   that needs its window in front waits until they pause, then borrows the screen for a moment (off: the window
  //   comes forward so you can watch)
  // liveView: show the bot's screenshots live in this window while it uses the computer
  // (frameQuality, maxFrameWidth and requireApprovalForFirstAction are unused now, kept so saved settings still parse)
  computer: z.object({ enabled: z.boolean().default(true), liveView: z.boolean().default(true), agentCursor: z.boolean().default(true), background: z.boolean().default(false), frameQuality: z.number().min(0.2).max(1).default(0.6), maxFrameWidth: z.number().default(1280), requireApprovalForFirstAction: z.boolean().default(true), liveQuality: LiveQuality.default('auto') }).default({ enabled: true, liveView: true, agentCursor: true, background: false, frameQuality: 0.6, maxFrameWidth: 1280, requireApprovalForFirstAction: true, liveQuality: 'auto' }),
  /** unused for now, like Bot.autoApprove: every permission the agent asks for waits for the user */
  approvals: z.object({ policy: z.enum(['ask', 'safe_auto', 'auto']).default('safe_auto'), fallback: z.enum(['deny', 'allow']).default('deny'), timeoutSec: z.number().default(600) }).default({ policy: 'safe_auto', fallback: 'deny', timeoutSec: 600 }),
  notifications: z.object({ desktop: z.boolean().default(true), mobile: z.boolean().default(true) }).default({ desktop: true, mobile: true }),
  /** start AppuBot (hidden, in the menu bar or tray) when the user logs in; turned on at the first launch */
  launchAtLogin: z.boolean().default(true),
  /**
   * Keeping this Mac on for the bots. keepAwake: block idle sleep while AppuBot runs (the display may still sleep).
   * lidClosed: also stay awake with the lid shut, by switching system sleep off (`pmset disablesleep`, through a
   * one-time rule the Mac's password installs); it is undone on quit, after a crash, on low battery and when hot.
   */
  power: z.object({ keepAwake: z.boolean().default(true), lidClosed: z.boolean().default(false) }).default({ keepAwake: true, lidClosed: false }),
  onboarded: z.boolean().default(false),
  /**
   * "Only in the cloud" (Settings › Account › Where your bots work): this Mac or PC stops being a place bots work while
   * the person has an AppuBot computer that can work (chat-core `cloudOnlyInEffect`): its routines don't fire, its
   * Telegram bots stop listening, its tray lists no bots to call and the window leaves it out of the computer switchers
   * and opens on the cloud computer. Nothing is deleted or switched off in any record: turned off (or with no cloud
   * computer that can work) everything here runs as before. An AppuBot computer ignores it.
   */
  cloudOnly: z.boolean().default(false),
  /**
   * What a chat shows of a bot's turn, on the Mac and the phone alike: `answers` (the default) only its replies and
   * what it asks or sends you, like a messaging bot; `everything` also its reasoning, tool calls and steps.
   */
  chatView: ChatView.default('answers'),
  /**
   * Instructions for every bot on this computer (Settings › Agents › Instructions): rendered into each bot's generated
   * CLAUDE.md/AGENTS.md before its own, so a bot's own instructions can refine them. Changing them regenerates every
   * bot's file and restarts its agents (with resume) at their next turn, like editing a bot.
   */
  globalInstructions: z.string().max(GLOBAL_INSTRUCTIONS_MAX).default(''),
  /**
   * Speech on this computer (voice mode, dictation, Telegram voice notes): which speech-to-text model hears you
   * (`sttModel`, see `VOICE_MODELS`), the language it should expect (`auto`: the model finds it; it applies only to
   * models that take one, `VoiceModelInfo.languages`), which model reads replies aloud (`ttsModel`) and in which of
   * its voices (`voice`, one of `VoiceModelInfo.voices`), and whether a Telegram voice message is answered with a
   * voice note too (`telegramVoiceReplies`; the text always goes). Absent `ttsModel`: Supertonic, from before.
   */
  voice: z.object({
    sttModel: VoiceSttModelId.default(DEFAULT_VOICE_STT_MODEL),
    language: z.string().default('auto'),
    ttsModel: VoiceTtsModelId.default(DEFAULT_VOICE_TTS_MODEL),
    voice: SpeechVoice.default('F1'),
    telegramVoiceReplies: z.boolean().default(true),
  }).default({ sttModel: DEFAULT_VOICE_STT_MODEL, language: 'auto', ttsModel: DEFAULT_VOICE_TTS_MODEL, voice: 'F1', telegramVoiceReplies: true }),
  /**
   * Clearing out what AppuBot keeps (Settings › Storage, `StorageService`): files in chats (attachments, files bots
   * sent, pages, voice recordings) older than `filesDays` days are deleted (0: kept for good), and its own log files
   * older than `logsDays`.
   */
  storage: z.object({
    filesDays: z.number().int().min(0).default(0),
    logsDays: z.number().int().min(1).default(14),
    /**
     * The most the desktop keeps of each AppuBot computer's pages and files on this Mac (`<dataDir>/cloud-files/`),
     * in MB: the least recently shown go first (`CLOUD_COPY_MB` choices in Settings › Storage).
     */
    cloudCopyMb: z.number().int().min(50).max(20_000).default(500),
  }).default({ filesDays: 0, logsDays: 14, cloudCopyMb: 500 }),
});
export type Settings = z.infer<typeof SettingsSchema>;

/* ---------- storage: what AppuBot keeps on this computer (Settings › Storage) ---------- */
export const StorageItemSchema = z.object({
  id: z.enum(['files', 'logs', 'voice', 'agents']),
  bytes: z.number(),
  /** files in it (files: the chats' files; logs: log files) */
  count: z.number().optional(),
  /** its folder, for Show in Finder */
  path: z.string(),
});
export type StorageItem = z.infer<typeof StorageItemSchema>;
export const StorageSummarySchema = z.object({
  items: z.array(StorageItemSchema),
  /**
   * What the desktop keeps of AppuBot computers' pages and files to show them at once (`<dataDir>/cloud-files/`):
   * absent from a computer that keeps none (not an item, so an app that predates it lists the rest as before).
   */
  cloudCopies: z.object({ bytes: z.number(), count: z.number(), path: z.string() }).optional(),
  /** the last clean-up: when, and how much it freed */
  cleanedAt: z.number().optional(),
  freedBytes: z.number().optional(),
});
export type StorageSummary = z.infer<typeof StorageSummarySchema>;

/**
 * Whether this Mac is being kept on for the bots (PowerService on the Mac). `lidClosed`: off; on (sleep is switched
 * off, so closing the lid doesn't sleep the Mac); setup (turned on in Settings but the one-time Mac password step
 * hasn't run); paused because the battery is low or the Mac is running hot; or error (see `error`).
 */
export const PowerStatusSchema = z.object({
  keepingAwake: z.boolean(),
  lidClosed: z.enum(['off', 'on', 'setup', 'paused-battery', 'paused-heat', 'error']),
  /** the one-time rule that lets AppuBot switch sleep off and on without asking for the password is installed */
  lidRule: z.boolean(),
  onBattery: z.boolean().optional(),
  batteryPct: z.number().optional(),
  error: z.string().optional(),
});
export type PowerStatus = z.infer<typeof PowerStatusSchema>;

/**
 * Whether the OS lets AppuBot's notifications show: `on`; `off` (turned off, or no banners/alerts); `not-asked` (macOS
 * hasn't asked the user yet: asking shows its prompt); `unknown` (no way to tell: Linux, dev builds).
 */
export const NotificationAccessSchema = z.enum(['on', 'off', 'not-asked', 'unknown']);
export type NotificationAccess = z.infer<typeof NotificationAccessSchema>;

/**
 * AppuBot's own updates (electron-updater, from the public GitHub releases repo). `unsupported`: this build can't update
 * itself (dev builds, a Linux build that isn't the AppImage or the .deb); `idle`: not checked yet; `downloading` and
 * `ready` name the new `version` (`ready`: downloaded, it installs when AppuBot restarts); `error` says why in `error`.
 */
export const AppUpdateStatusSchema = z.object({
  state: z.enum(['unsupported', 'idle', 'checking', 'up-to-date', 'downloading', 'ready', 'error']),
  version: z.string().optional(),
  /** 0..100 while downloading */
  percent: z.number().optional(),
  /** the last check that finished */
  checkedAt: Timestamp.optional(),
  error: z.string().optional(),
  /**
   * This version was stopped (the releases repo's version-policy.json): AppuBot refuses everything but updating
   * (`update_required`) and shows `message` over the whole window until it is updated.
   */
  required: z.object({ message: z.string() }).optional(),
});
export type AppUpdateStatus = z.infer<typeof AppUpdateStatusSchema>;

/* ---------- voice: speech on this computer ---------- */
/*
 * Speech-to-text and text-to-speech run on this computer with sherpa-onnx (CPU only), on models downloaded once on
 * first use into `<dataDir>/voice-models`. Any client (this window, a phone app, Telegram) sends audio to
 * `voice.transcribe` and gets text; `voice.speak` turns a reply into an OGG/Opus file every client plays.
 */
export const VoiceModelPhase = z.enum(['missing', 'downloading', 'ready', 'error']);
export type VoiceModelPhase = z.infer<typeof VoiceModelPhase>;
export const VoiceModelStatusSchema = z.object({
  id: VoiceModelId,
  kind: z.enum(['stt', 'tts']),
  name: z.string(),
  bytes: z.number(),
  phase: VoiceModelPhase,
  /** 0..1 while downloading */
  progress: z.number().min(0).max(1).nullable(),
  /** why it failed, or what is happening */
  message: z.string().nullable(),
});
export type VoiceModelStatus = z.infer<typeof VoiceModelStatusSchema>;

export const VoiceStatusSchema = z.object({
  /** this computer can run the speech models (a sherpa-onnx runtime ships for its OS and chip) */
  supported: z.boolean(),
  /** why not, when it can't */
  reason: z.string().optional(),
  /**
   * It reads aloud (`voice.speak`) though it doesn't hear (`supported` false): an AppuBot computer, whose phone hears
   * you itself. Absent elsewhere (a computer that is `supported` speaks too) and from computers before this.
   */
  speaks: z.boolean().optional(),
  models: z.array(VoiceModelStatusSchema),
  /** a transcription or a reading is running now */
  busy: z.object({ stt: z.boolean(), tts: z.boolean() }),
});
export type VoiceStatus = z.infer<typeof VoiceStatusSchema>;

/** What `voice.transcribe` hears at: 16 kHz mono 16-bit little-endian PCM. */
export const VOICE_PCM_RATE = 16_000;
/** The longest recording `voice.transcribe` takes, and the longest text `voice.speak` reads at once. */
export const VOICE_MAX_SECONDS = 180;
export const VOICE_SPEAK_MAX_CHARS = 4000;
/** How long `voice.warm` keeps the speech models loaded without another call (voice mode renews it while open). */
export const VOICE_WARM_MS = 45_000;

/**
 * What an AppuBot Cloud computer is allowed to do right now, set by the AppuBot Cloud backend through the computer's
 * control API: `ok` (working), `on-hold` (the subscription's payment failed: no turns, no routines, until it is paid),
 * `export-only` (the plan ended: stopped until it is deleted or the plan comes back; the name is historical). Plans have no hour limit, so there is no "out of
 * hours" state. The apps hide what doesn't apply and explain refusals with it.
 */
export const CloudState = z.enum(['ok', 'on-hold', 'export-only']);
export type CloudState = z.infer<typeof CloudState>;
/**
 * How a team's cloud computer signs its agents in (a team admin's setting): `own`, each
 * person's own logins, keys, Vault and connected apps, used by their own bots (the default); `shared`, one set for the
 * whole team, signed in by an admin and used by every bot (members use them but never see them).
 */
export const CloudTeamLogins = z.enum(['own', 'shared']);
export type CloudTeamLogins = z.infer<typeof CloudTeamLogins>;
/** a team member as the computer knows them (from their devices' pairings): for "uses <email>'s logins" */
export const CloudMemberSchema = z.object({ id: z.string(), email: z.string() });
export type CloudMember = z.infer<typeof CloudMemberSchema>;
/**
 * The included Claude credit as this computer knows it: the agent "AppuBot AI"
 * (`APPUBOT_AI_PROVIDER_ID`) runs on it. Amounts in USD cents; the token itself never leaves the core.
 */
export const CloudCreditStatusSchema = z.object({
  budgetCents: z.number().int().nonnegative(), usedCents: z.number().int().nonnegative(), currency: z.string().length(3),
  resetsAt: Timestamp, exhausted: z.boolean(), defaultModel: z.string(), shared: z.boolean().optional(),
  /** the launch bonus has ended for everyone (the backend switched it off, its date passed or its pool is spent) */
  ended: z.boolean().optional(), endsAt: Timestamp.optional(),
});
export type CloudCreditStatus = z.infer<typeof CloudCreditStatusSchema>;
/**
 * Claude Code being set up on an AppuBot Cloud computer: the image
 * ships no agent, so a computer with a plan installs Claude Code by itself at its first start (and one from before that
 * never had it, at its next), in the background, so the launch bonus's AppuBot AI works on the first message. Absent
 * once Claude Code is there (or the computer has no plan). `installing`: the installer runs (a turn on Claude waits for
 * it); `retrying`: a try failed, the next at `retryAt`; `failed`: it gave up for now (the next message to a Claude bot,
 * Settings › Agents' Install or a later timer tries again).
 */
export const CloudAgentSetupSchema = z.object({
  providerId: z.string(), name: z.string(),
  state: z.enum(['installing', 'retrying', 'failed']),
  attempt: z.number().int().positive(), startedAt: Timestamp,
  retryAt: Timestamp.optional(), error: z.string().optional(),
});
export type CloudAgentSetup = z.infer<typeof CloudAgentSetupSchema>;
export const CloudInfoSchema = z.object({
  state: CloudState,
  /** on hold: the grace deadline, when known */
  resetsAt: Timestamp.optional(),
  /** the public address clients reach this computer at (`https://<slug>.agent37.app`), once the backend told it */
  publicUrl: z.string().optional(),
  /** a team's computer: the admins' logins setting (`own` unless told); absent on a personal cloud computer */
  logins: CloudTeamLogins.optional(),
  /** a team's computer: the people whose devices are paired to it, for naming whose logins a bot uses */
  members: z.array(CloudMemberSchema).optional(),
  /** the included Claude credit (§6.13), while the plan has it; absent without (the AppuBot AI agent isn't offered then) */
  credit: CloudCreditStatusSchema.optional(),
  /** Claude Code being installed at the computer's first start (absent once it's there; absent from computers that predate it) */
  agentSetup: CloudAgentSetupSchema.optional(),
});
export type CloudInfo = z.infer<typeof CloudInfoSchema>;

/**
 * The free Claude day on this computer (2026-11-10; a person's own computer only, never an AppuBot Cloud one): for a
 * set window AppuBot AI runs Claude for free here. `offer`: a day is on and this computer hasn't taken it (the window
 * shows it once); `starting`: Start was pressed (`step`: the account's place, Claude Code being installed); `on`: its
 * agent is there to pick for any bot until `endsAt`; `over`: it ended here (`why`) and the bots that were on it are
 * back on what they used, said once. Absent: nothing to show. Never an amount.
 */
export const PromoStatusSchema = z.object({
  id: z.string(), model: z.string(), endsAt: Timestamp.optional(),
  state: z.enum(['offer', 'starting', 'on', 'over']),
  step: z.enum(['account', 'install']).optional(),
  /** `over`: the day's end, or this account's fair-use limit */
  why: z.enum(['ended', 'used-up']).optional(),
  /** the last Start didn't go through: why, in words */
  error: z.string().optional(),
  /** signed in to AppuBot here (Start needs it) */
  signedIn: z.boolean(),
  /** how many bots are on it now (the person picks them: none move by themselves) */
  bots: z.number().int().nonnegative().optional(),
  /** the backend's own launch page and X post words for the card, when it sent any (else the app's) */
  launchUrl: z.string().optional(), postText: z.string().optional(),
});
export type PromoStatus = z.infer<typeof PromoStatusSchema>;

/**
 * What this computer takes in a transfer from another one (Settings › Transfer, the Move dialog, the cloud's first
 * visit): the biggest upload it accepts at once (`POST /api/files`, also through AppuBot Connect's channel), and whether
 * it can take a group's room (`groups.restore`). Absent from computers that predate it: `UPLOAD_MAX_BEFORE` and no room.
 */
export const TransferTakesSchema = z.object({
  uploadMax: z.number().int().positive(),
  groupRooms: z.boolean(),
});
export type TransferTakes = z.infer<typeof TransferTakesSchema>;

export const SystemInfoSchema = z.object({
  version: z.string(), hostName: z.string(), platform: z.string(), arch: z.string(), homeDir: z.string(), dataDir: z.string(),
  tailscale: z.object({ installed: z.boolean(), running: z.boolean(), ips: z.array(z.string()), dnsName: z.string().optional(), tailnet: z.string().optional(), loginName: z.string().optional() }),
  gateway: z.object({
    port: z.number(), hosts: z.array(z.string()),
    /**
     * Where a paired phone can reach this Mac right now (Tailscale addresses and MagicDNS name, local-network IPs;
     * no loopback), in the order to try them. Phones save it, so they find the Mac again after its Wi-Fi address
     * changes or Tailscale goes off. Absent from Macs that predate it.
     */
    candidates: z.array(HostCandidateSchema).optional(),
  }),
  uptimeSec: z.number(),
  /** absent from Macs that predate it, and where nothing keeps the Mac awake (tests, other platforms) */
  power: PowerStatusSchema.optional(),
  /** absent from Macs that predate it */
  update: AppUpdateStatusSchema.optional(),
  /** AppuBot Connect (absent from computers that predate it) */
  connect: ConnectStatusSchema.optional(),
  /** this computer is an AppuBot Cloud computer: its state (absent on a Mac, and from computers that predate it) */
  cloud: CloudInfoSchema.optional(),
  /** the free Claude day, while there is something to show (absent otherwise, and from computers that predate it) */
  promo: PromoStatusSchema.optional(),
  /** what it takes in a transfer (absent from computers that predate it: see `transferLimit`) */
  transfer: TransferTakesSchema.optional(),
  /** it keeps a group's pin (`groups.update {pinned}`): absent from computers that predate it, where the apps don't offer Pin */
  groupPins: z.boolean().optional(),
  /** the bot shapes it takes (absent from computers that predate it: only `BOT_SHAPES_V1`) */
  botShapes: z.array(z.string()).optional(),
});
export type SystemInfo = z.infer<typeof SystemInfoSchema>;
