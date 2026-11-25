/** Shared types for the core: injected dependencies and the service registry. */
import type { AgentRuntime, RuntimeHooks } from '@appubot/agent-runtime';
import type { NotificationAccess } from '@appubot/protocol';
import type { Store } from './store';
import type { EventBus } from './events';
import type { Auth } from './auth';
import type { Logger } from './util';
import type { SettingsService } from './services/settings';
import type { BotsService } from './services/bots';
import type { ThreadsService } from './services/threads';
import type { ChatService } from './services/chat';
import type { ProvidersService } from './services/providers';
import type { AcpRegistryService, PackageRunner } from './services/acpRegistry';
import type { ProviderUpdatesService, UpdateIo } from './services/providerUpdates';
import type { ComputerService, ComputerBackend } from './services/computer';
import type { LiveViewService } from './services/liveView';
import type { TeachService } from './services/teach';
import type { SkillsService } from './services/skills';
import type { RoutinesService } from './services/routines';
import type { GroupsService } from './services/groups';
import type { HandoffService } from './services/handoffs';
import type { GoalsService } from './services/goals';
import type { ChannelsService } from './services/channels';
import type { ComposioService } from './services/composio';
import type { ComposioConnect } from './services/composioConnect';
import type { RemoteMcp } from './services/mcpRemote';
import type { FilesService } from './services/files';
import type { AgentBridgeService } from './services/agentBridge';
import type { DevicesService } from './services/devices';
import type { ConnectDeps, ConnectService } from './services/connect';
import type { PushService } from './services/push';
import type { TailscaleService } from './services/tailscale';
import type { SystemService } from './services/system';
import type { NotificationsService } from './services/notifications';
import type { HelperTransport } from './services/nativeHelper';
import type { AgentCursorHost } from './services/agentCursor';
import type { PowerHost, PowerService } from './services/power';
import type { AppUpdateService, AppUpdaterHost } from './services/appUpdate';
import type { AnalyticsConfig, AnalyticsService } from './services/analytics';
import type { InputWatchHost } from './services/inputRecorder';
import type { VoiceEngine, VoiceRuntime, VoiceService } from './services/voice';
import type { UsageService } from './services/usage';
import type { LimitsService } from './services/limits';
import type { LimitsFetch } from './services/limits/probes';
import type { ModelEndpointsService } from './services/modelEndpoints';
import type { VaultService } from './services/vault';
import type { GitHubService, GitIo } from './services/github';
import type { MacLinkService } from './services/macLink';
import type { MacFilesService } from './services/macFiles';
import type { StorageService } from './services/storage';
import type { CharactersService } from './services/characters';
import type { CloudExportService } from './services/cloudExport';
import type { BotBundleService } from './services/botBundle';
import type { CloudAccountService } from './services/cloudAccount';
import type { LoginsService, LoginScope } from './services/logins';
import type { CreditService } from './services/credit';
import type { AgentSetupService } from './services/agentSetup';
import type { PromoService } from './services/promo';
import type { FreeAgentService } from './services/freeAgent';
import type { installFreeAgent } from './services/freeAgentInstall';
import type { installNativeAgent } from './services/nativeInstall';
import type { DeviceLoginService } from './services/deviceLogin';

/** what a native notification came to */
export interface NotifyResult { shown: boolean; error?: string }

/**
 * This core runs on an AppuBot Cloud computer (its gateway), not on the user's own machine. Present,
 * the gateway serves only the end-to-end channel and Telegram webhooks to the internet (route `cloud`), Telegram uses
 * webhooks, Connect's relay stays off, routines and turns pause while the backend says the computer is on hold,
 * and the bots' instructions say where they run. Absent (the Mac, Windows, Linux desktops, tests), nothing changes.
 * The object is shared with the headless entry and mutable: `publicUrl` is '' until the backend's bootstrap says it.
 */
export interface CloudDeps {
  /** `https://<slug>.agent37.app`: the public port the phones, the desktop and Telegram reach this computer at */
  publicUrl: string;
  /** what the backend must send the control API (`Authorization: Bearer`), from the instance's env */
  controlToken: string;
  /** the AppuBot Cloud backend (`https://account.appubot.com`) and what this computer sends it */
  backendUrl: string;
  backendToken: string;
  /** agent sessions kept up at once across every bot (the 4 GB computer's measured room: V2) */
  maxLiveSessions: number;
}

export interface CorePaths {
  /** app data (settings, threads, files registry) */
  dataDir: string;
  /**
   * AppuBot Cloud: the computer's own state, apart from the user's data so deleting that never unpairs or disconnects
   * the computer (`SYSTEM_FILES`: pairings, the Connect identity, the cloud state and credit, kept by the cloud
   * computer's gateway). Default `dataDir`.
   */
  systemDir?: string;
  /** ~/AppuBot - bot workspaces live here */
  botsRoot: string;
  /** copies of files delivered to devices */
  filesDir: string;
  logsDir: string;
  /** absolute path of packages/mcp-bridge/dist/bridge.mjs (dev) or resources/bridge/bridge.mjs (prod) */
  bridgePath: string;
  /** absolute path of the Swift appubot-helper binary (may not exist) */
  helperPath?: string;
  /** absolute path of the voice host script (out/main/voiceHost.js): the process that runs the speech models (absent in tests) */
  voiceHostPath?: string;
}

/**
 * Re-encoding screenshots for the live view (Electron nativeImage in the app; none in tests): the picture shrunk so
 * its long edge is at most `maxDim` px, as JPEG at `quality` (0..1). Null when it can't (the frame goes out as is).
 */
export interface ImageCodec {
  encode(base64: string, o: { maxDim: number; quality: number }): { data: string; mimeType: string; width: number; height: number } | null;
}

/**
 * A picture of the whole screen for live view (`services/liveView.ts`) where the Mac's native helper isn't there (the
 * AppuBot Cloud computer: an RFB client to its own Xvnc, in its gateway). `frame` answers the
 * newest picture of the display when it changed since `after` (its number), at most `maxDim` px on the long edge as
 * JPEG (or PNG) at `quality` 0..1, else `{ unchanged: true }`; `bounds` is the display in the units input is given in
 * (pixels on X11). `stop` is called when the last device stops watching: nothing may keep running after it.
 */
export interface ScreenSource {
  frame(o: { maxDim: number; quality: number; after: number }): Promise<ScreenFrame>;
  stop(): void;
}
export interface ScreenFrame {
  unchanged?: boolean;
  seq?: number;
  /** base64 picture, when changed */
  image_base64?: string;
  width?: number;
  height?: number;
  bounds?: { x: number; y: number; width: number; height: number };
  cursor?: { x: number; y: number };
}

export interface CoreDeps {
  paths: CorePaths;
  /** Factory: the core owns the hooks, so it constructs the runtime itself. */
  runtime: (hooks: RuntimeHooks) => AgentRuntime;
  imageCodec?: ImageCodec;
  openExternal: (url: string) => Promise<void> | void;
  openTerminal: (command: string) => Promise<void> | void;
  /** SVG → JPEG bytes at `size`px (the Telegram bot's profile photo; Electron offscreen window; absent in tests). */
  svgToJpeg?: (svg: string, size: number) => Promise<Uint8Array>;
  /**
   * The app's own face for a bot's visual page (a variable WOFF2 as base64, with its family name): sent inside the page's
   * document to an app that asks for it (`/pages/:id?font=app`: the desktop window, which is set in it). Absent or null:
   * the system's face.
   */
  pageFont?: () => { family: string; woff2: string } | null;
  /** turn the ACP registry on though `ACP_REGISTRY` is off (tests) */
  acpRegistry?: boolean;
  /** override HTTP fetches made for the ACP registry, its agents' downloads, update checks and AppuBot Connect (tests) */
  fetch?: typeof fetch;
  /** AppuBot Connect's service URL and connector (tests) */
  connect?: ConnectDeps;
  /**
   * Pairing a phone and AppuBot Connect need this computer signed in to AppuBot (`cloudAccount.isSignedIn`):
   * `pairing.start` refuses `sign_in_required` and the relay isn't dialled while signed out. Set by the app; off in tests
   * unless they ask. An AppuBot Cloud computer is the account's own: always signed in.
   */
  accountRequired?: boolean;
  /**
   * A thread never sits empty: the bot opens a new one itself with a short line (`ChatService.openThread`, a turn of
   * AppuBot's own). Set by the apps; off in tests unless they ask (a turn per new thread would run under each of them).
   */
  threadOpeners?: boolean;
  /** override how agent updates look at and run the CLIs on this Mac (tests) */
  updateIo?: Partial<UpdateIo>;
  /** override how git, the GitHub CLI and ssh-keygen are found and run (tests: `services/github.ts`) */
  gitIo?: Partial<GitIo>;
  /** override how OpenCode, the free agent, is downloaded and installed (tests) */
  freeAgentInstall?: typeof installFreeAgent;
  /** Claude Code's, Codex's and Copilot's own download (`nativeInstall.ts`), swapped in tests */
  nativeInstall?: typeof installNativeAgent;
  /** override how the ACP registry's npm / Python packages are installed (tests) */
  packageRunner?: Partial<PackageRunner>;
  /** override the home folder searched for agent profiles (`~/.claude-*`, Synara's) and for the agents' logs Usage reads (tests) */
  homeDir?: string;
  /** override Composio's MCP and sign-in (tests) */
  composioConnect?: () => ComposioConnect;
  /** override the client for apps on their own servers (tests) */
  remoteMcp?: () => RemoteMcp;
  /** Show a path in Finder: folders open, files are revealed (never launched). Falls back to openExternal(file://). */
  openPath?: (path: string) => Promise<void> | void;
  /** open a file in its default app (only AppuBot's own files go here: `files.open`) */
  openFile?: (path: string) => Promise<void> | void;
  /** moves a file to the OS's Trash (Electron `shell.trashItem`): the old version of a file a bot on another computer replaced (`macLink.put`) */
  trashItem?: (path: string) => Promise<void>;
  /** shows a notification; resolves with whether the OS took it (`error` says why not) */
  nativeNotify: (title: string, body: string, onClick?: () => void) => Promise<NotifyResult> | void;
  /** whether the OS shows AppuBot's notifications (absent: `unknown`) */
  notificationAccess?: () => Promise<NotificationAccess>;
  /** asks the OS to allow them (macOS: its prompt, while not asked yet) */
  requestNotifications?: () => Promise<NotificationAccess>;
  /** opening AppuBot at login (absent in dev and test instances, which must not register themselves) */
  loginItem?: { get(): boolean; set(on: boolean): void };
  /**
   * How to load `@trycua/cua-driver` (`''`) or its `/electron` entry. Packaged builds load it from app.asar.unpacked:
   * Cua hands its dylib path straight to dlopen, which cannot read inside app.asar. Default: a plain import.
   */
  importCua?: (entry: '' | '/electron') => Promise<unknown>;
  /**
   * When computer use may start its backend at launch (Cua's driver takes ~70ms of the main thread): the desktop
   * resolves it once the window's page has started loading, so that work runs while the renderer is busy. Absent:
   * right after `core.start()` returns.
   */
  computerStartAfter?: Promise<unknown>;
  /** Draws the bot's pointer on the Mac's screen while it uses the computer (Electron overlay; absent in tests). */
  agentCursor?: AgentCursorHost;
  /**
   * Teach mode's recording on Windows and Linux: global mouse/keyboard hooks, the window in front, display pictures
   * (Electron + uiohook-napi; absent on macOS, where the Swift helper records, and in tests).
   */
  inputWatch?: InputWatchHost;
  /** Keeps the Mac awake (Electron powerSaveBlocker/powerMonitor + pmset; macOS app only, never dev-harness instances). */
  power?: PowerHost;
  /** AppuBot's own updates (electron-updater; the packaged real app only, and only builds that can update themselves) */
  appUpdater?: AppUpdaterHost;
  /** where the version policy is read (the packaged real app only): a stopped version refuses everything but updating */
  versionPolicyUrl?: string;
  /** anonymous usage analytics (PostHog; the packaged real app only) */
  analytics?: AnalyticsConfig;
  /** Electron main only, after app ready: `requestMacOSPermissions()` from @trycua/cua-driver/electron */
  requestCuaPermissions?: () => Promise<{ accessibility: boolean; screenRecording: boolean }> | { accessibility: boolean; screenRecording: boolean };
  version: string;
  /** this computer's name (a Mac's as Finder shows it, `electron/computerName.ts`); main updates it on a rename */
  hostName: string;
  /** the device's language, as a BCP 47 tag ("hi-IN"): bots write in it by default (absent: no such line in their instructions) */
  systemLanguage?: () => string | undefined;
  log?: Logger;
  /** validate snapshots/results/events against the protocol schemas (dev/test) */
  validate?: boolean;
  /** override the gateway port (0 = ephemeral, used by tests) */
  port?: number;
  /** bind host override (default '::' falling back to 0.0.0.0) */
  host?: string;
  isAppFocused?: () => boolean;
  showApp?: (threadId?: string) => void;
  /** a voice call from the menu bar is open (`electron/voiceBar.ts`): a downloaded update doesn't restart meanwhile */
  voiceCallOpen?: () => boolean;
  /** the main window is out of sight (menu bar only): the relaunch after an update stays that way */
  windowHidden?: () => boolean;
  /**
   * How long since the user last touched the keyboard or mouse, in ms (Electron's powerMonitor: whole seconds). Background
   * computer use waits for a pause with it where the native helper can't say (Windows, Linux, an older helper).
   */
  systemIdleMs?: () => number;
  /** the screen is locked (Electron's powerMonitor): the user isn't at this computer, whatever the idle time says */
  screenLocked?: () => boolean;
  /**
   * Calls `fn` when the computer wakes from sleep or its screen is unlocked (Electron's powerMonitor `resume` and
   * `unlock-screen`); returns the unsubscribe. AppuBot Connect checks its relay socket then (`ConnectService.nudge`).
   */
  onWake?: (fn: (why: string) => void) => () => void;
  /** override computer backends (tests); default: [Cua, Native] */
  computerBackends?: () => ComputerBackend[];
  /**
   * Live view's pictures where there is no native helper (the AppuBot Cloud computer's screen through its own VNC
   * display, `ScreenSource`); input then goes through the computer-use backend's desktop scope. Made on the first
   * watch, so nothing runs until a device watches; null where the screen can't be read.
   */
  liveScreen?: () => ScreenSource | null;
  /** override the native helper transport factory (tests) */
  helperTransport?: () => HelperTransport | null;
  /** override tailscale CLI lookup (tests) */
  tailscale?: TailscaleService;
  /** how to launch the MCP bridge: defaults to process.execPath (+ ELECTRON_RUN_AS_NODE=1 under Electron) */
  bridgeLauncher?: { command: string; env: Record<string, string> };
  /** where the sherpa-onnx addon for this OS and chip is (Electron main resolves it; absent: voice unsupported) */
  voiceRuntime?: VoiceRuntime;
  /** override what runs the speech models (tests) */
  voiceEngine?: VoiceEngine;
  /**
   * Decodes a compressed recording (WebM/Opus, MP3, M4A, WAV…) to 16 kHz mono PCM (Electron offscreen window; absent
   * in tests, where only PCM and OGG/Opus are read).
   */
  decodeAudio?: (bytes: Uint8Array, mimeType: string) => Promise<{ pcm16: Int16Array; sampleRate: number }>;
  /**
   * Encrypts the Vault's secrets with the OS's keychain (Electron safeStorage). Absent (tests, or no keychain), they
   * are kept as they are in a file only this user can read.
   */
  secretBox?: { encrypt(plain: string): string; decrypt(sealed: string): string };
  /** skip starting background things like provider detection/channels (tests) */
  quiet?: boolean;
  /** this is an AppuBot Cloud computer (see `CloudDeps`); absent everywhere else */
  cloud?: CloudDeps;
  /**
   * The AppuBot Cloud backend the Mac's `cloudAccount` service talks to (default `https://account.appubot.com`; a staging
   * backend, or a fake in tests). Only read on the user's own computer, never on the cloud one.
   */
  cloudBackendUrl?: string;
  /** fetch for the AppuBot Cloud backend alone (a staging backend's, a test's fake); default `fetch` */
  cloudFetch?: typeof fetch;
  /**
   * A fake AppuBot Cloud backend in this process (`services/cloudFake.ts`; dev only: `APPUBOT_CLOUD_FAKE=<state>`):
   * `state` to start in, `file` to watch for changes (default `<dataDir>/cloud-fake.json`). Never on a cloud computer.
   */
  cloudFake?: { state?: string; file?: string };
  /** override how the agents' plan limits are read (tests); default `services/limits/probes.ts` */
  limitsFetch?: Partial<LimitsFetch>;
  /** what `providers.deviceLogin.start` runs for an agent (tests); default the agent's own CLI login */
  deviceLoginCommand?: (providerId: string, methodId?: string) => Promise<{ command: string; args: string[]; env: Record<string, string>; pty?: boolean; token?: boolean } | null>;
}

export interface Services {
  settings: SettingsService;
  bots: BotsService;
  threads: ThreadsService;
  chat: ChatService;
  providers: ProvidersService;
  acpRegistry: AcpRegistryService;
  providerUpdates: ProviderUpdatesService;
  computer: ComputerService;
  liveView: LiveViewService;
  teach: TeachService;
  skills: SkillsService;
  routines: RoutinesService;
  /** groups of bots talking with each other (`services/groups.ts`) */
  groups: GroupsService;
  /** a task handed to another bot with @Name in a bot's chat, its answer posted back there (`services/handoffs.ts`) */
  handoffs: HandoffService;
  /** goals bots work toward on their own (`services/goals.ts`) */
  goals: GoalsService;
  channels: ChannelsService;
  composio: ComposioService;
  /** the connected apps of a login scope (a team member's own on a team's computer; `''` is `composio`) */
  composioFor(scope: LoginScope): ComposioService;
  /** whose logins a bot or a device runs on (§6.11) */
  logins: LoginsService;
  /** an AppuBot Cloud computer's included Claude credit and its AppuBot AI agent (`services/credit.ts`, §6.13); present everywhere, idle off the cloud */
  credit: CreditService;
  /** an AppuBot Cloud computer setting Claude Code up at its first start (`services/agentSetup.ts`); idle off the cloud */
  agentSetup: AgentSetupService;
  /** the free Claude day on a person's own computer (`services/promo.ts`) */
  promo: PromoService;
  /** OpenCode, the agent that needs no account: installed, switched on and made the default where it should be (`services/freeAgent.ts`) */
  freeAgent: FreeAgentService;
  files: FilesService;
  agentBridge: AgentBridgeService;
  devices: DevicesService;
  connect: ConnectService;
  push: PushService;
  tailscale: TailscaleService;
  system: SystemService;
  notifications: NotificationsService;
  power: PowerService;
  appUpdate: AppUpdateService;
  analytics: AnalyticsService;
  voice: VoiceService;
  usage: UsageService;
  /** the agents' plan limits: what's left of each subscription, per window and model (`providers.limits`) */
  limits: LimitsService;
  endpoints: ModelEndpointsService;
  vault: VaultService;
  storage: StorageService;
  characters: CharactersService;
  /** "Download my bots" on an AppuBot Cloud computer (a zip over the channel) */
  cloudExport: CloudExportService;
  /** one bot packed for another computer, and unpacked from one (`bots.export` / `bots.import`) */
  botBundle: BotBundleService;
  /** git's name and email and the GitHub sign-in, carried between the person's computers (`services/github.ts`) */
  github: GitHubService;
  /** this computer's folders lent to the bots on another of the person's computers (`services/macLink.ts`) */
  macLink: MacLinkService;
  /** the other end: another computer's lent folders, read for this one's bots (`services/macFiles.ts`) */
  macFiles: MacFilesService;
  /** the user's AppuBot Cloud account, on their own computer (sign-in, the meter, pairing, notices while hidden) */
  cloudAccount: CloudAccountService;
  /** an agent's CLI login run here for a phone (`providers.deviceLogin.*`) */
  deviceLogin: DeviceLoginService;
}

export interface CoreCtx {
  deps: CoreDeps;
  paths: CorePaths;
  store: Store;
  bus: EventBus;
  auth: Auth;
  log: Logger;
  runtime: AgentRuntime;
  s: Services;
  /** filled once the gateway listens */
  gateway: { port: number; disconnectDevice(id: string): void; reconnectDevice(id: string, reason?: string): void; onlineDevices(): Set<string>; inFront(deviceId: string): boolean; atDesk(member: string | undefined): boolean };
  startedAt: number;
}

/** the files kept in `CorePaths.systemDir` (the core's; the cloud gateway adds its own `cloud*.json`) */
export const SYSTEM_FILES = ['devices.json', 'connect.json', 'sent-ids.json', 'cloud-state.json', 'cloud-credit.json', 'version-policy.json'] as const;
/** where the computer's own state goes: `paths.systemDir`, else the data folder */
export function systemDirOf(paths: CorePaths): string { return paths.systemDir ?? paths.dataDir; }
