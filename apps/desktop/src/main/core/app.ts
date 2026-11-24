/** createCore(deps): wires store, event bus, auth, services, runtime and the gateway. Electron-free. */
import { mkdirSync } from 'node:fs';
import type { CoreCtx, CoreDeps, Services } from './context';
import { systemDirOf } from './context';
import { Store, type StoredApps } from './store';
import { EventBus } from './events';
import { Auth } from './auth';
import { Gateway } from './gateway';
import { consoleLogger, errMsg } from './util';
import { SettingsService } from './services/settings';
import { NotificationsService } from './services/notifications';
import { TailscaleService } from './services/tailscale';
import { ConnectService } from './services/connect';
import { PushService } from './services/push';
import { SystemService } from './services/system';
import { PowerService } from './services/power';
import { AppUpdateService } from './services/appUpdate';
import { AnalyticsService } from './services/analytics';
import { BotsService } from './services/bots';
import { ThreadsService } from './services/threads';
import { ChatService } from './services/chat';
import { ProvidersService } from './services/providers';
import { AcpRegistryService } from './services/acpRegistry';
import { ProviderUpdatesService } from './services/providerUpdates';
import { ComputerService } from './services/computer';
import { LiveViewService } from './services/liveView';
import { SkillsService } from './services/skills';
import { TeachService } from './services/teach';
import { RoutinesService } from './services/routines';
import { GroupsService } from './services/groups';
import { HandoffService } from './services/handoffs';
import { GoalsService } from './services/goals';
import { ChannelsService } from './services/channels';
import { ComposioService } from './services/composio';
import { LoginsService } from './services/logins';
import { CreditService } from './services/credit';
import { AgentSetupService } from './services/agentSetup';
import { PromoService } from './services/promo';
import { FreeAgentService } from './services/freeAgent';
import { JsonFile } from './store';
import { FilesService } from './services/files';
import { AgentBridgeService } from './services/agentBridge';
import { DevicesService } from './services/devices';
import { VoiceService } from './services/voice';
import { UsageService } from './services/usage';
import { LimitsService } from './services/limits';
import { ModelEndpointsService } from './services/modelEndpoints';
import { VaultService } from './services/vault';
import { StorageService } from './services/storage';
import { CharactersService } from './services/characters';
import { CloudExportService } from './services/cloudExport';
import { BotBundleService } from './services/botBundle';
import { GitHubService } from './services/github';
import { MacLinkService } from './services/macLink';
import { MacFilesService } from './services/macFiles';
import { CloudAccountService } from './services/cloudAccount';
import { DeviceLoginService } from './services/deviceLogin';
import { createHelperTransport } from './services/nativeHelper';
import { traceMark } from './startupTrace';

export interface Core {
  ctx: CoreCtx;
  gateway: Gateway;
  services: Services;
  /** owner token for the local renderer */
  ownerToken: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createCore(deps: CoreDeps): Core {
  const log = deps.log ?? consoleLogger;
  const paths = deps.paths;
  for (const d of [paths.dataDir, paths.botsRoot, paths.filesDir, paths.logsDir]) mkdirSync(d, { recursive: true });
  const store = new Store(paths.dataDir, log, systemDirOf(paths));
  const bus = new EventBus({ validate: deps.validate, log });
  const auth = new Auth(store);
  const depsWithHelper: CoreDeps = { ...deps, helperTransport: deps.helperTransport ?? (() => createHelperTransport(paths.helperPath, log)) };

  const ctx = {
    deps: depsWithHelper, paths, store, bus, auth, log,
    runtime: undefined as unknown as CoreCtx['runtime'],
    s: {} as Services,
    gateway: { port: 0, disconnectDevice: () => undefined, reconnectDevice: () => undefined, onlineDevices: () => new Set<string>(), inFront: () => false, atDesk: () => false },
    startedAt: Date.now(),
  } as CoreCtx;

  // construction order matters: services subscribing to others in their constructors come later
  const s = ctx.s;
  s.settings = new SettingsService(ctx);
  s.notifications = new NotificationsService(ctx);
  s.tailscale = deps.tailscale ?? new TailscaleService();
  s.system = new SystemService(ctx);
  s.power = new PowerService(ctx);
  s.appUpdate = new AppUpdateService(ctx);
  s.analytics = new AnalyticsService(ctx);
  s.bots = new BotsService(ctx);
  s.threads = new ThreadsService(ctx);
  s.files = new FilesService(ctx);
  s.voice = new VoiceService(ctx);
  s.usage = new UsageService(ctx);
  s.limits = new LimitsService(ctx);
  s.storage = new StorageService(ctx);
  s.characters = new CharactersService(ctx);
  s.skills = new SkillsService(ctx);
  s.providers = new ProvidersService(ctx);
  s.endpoints = new ModelEndpointsService(ctx);
  s.vault = new VaultService(ctx);
  s.acpRegistry = new AcpRegistryService(ctx);
  s.providerUpdates = new ProviderUpdatesService(ctx);
  s.computer = new ComputerService(ctx);
  s.liveView = new LiveViewService(ctx);
  s.devices = new DevicesService(ctx);
  s.connect = new ConnectService(ctx);
  s.push = new PushService(ctx);
  s.logins = new LoginsService(ctx);
  s.credit = new CreditService(ctx);
  s.agentSetup = new AgentSetupService(ctx);
  s.promo = new PromoService(ctx);
  s.freeAgent = new FreeAgentService(ctx);
  s.composio = new ComposioService(ctx);
  // a team member's connected apps live in their own file (`LoginsService`); made on first use, flushed with the rest
  const composios = new Map<string, ComposioService>();
  s.composioFor = (scope) => {
    if (!scope) return s.composio;
    let c = composios.get(scope);
    if (!c) {
      const file = new JsonFile<StoredApps>(s.logins.fileOf(scope, 'apps.json'), () => ({}), 150, ctx.log, undefined, 0o600);
      c = new ComposioService(ctx, file);
      composios.set(scope, c);
    }
    return c;
  };
  s.chat = new ChatService(ctx);
  s.agentBridge = new AgentBridgeService(ctx);
  s.teach = new TeachService(ctx);
  s.routines = new RoutinesService(ctx);
  s.groups = new GroupsService(ctx);
  s.handoffs = new HandoffService(ctx);
  s.goals = new GoalsService(ctx);
  s.channels = new ChannelsService(ctx);
  s.cloudExport = new CloudExportService(ctx);
  s.botBundle = new BotBundleService(ctx);
  s.github = new GitHubService(ctx);
  s.macLink = new MacLinkService(ctx);
  s.macFiles = new MacFilesService(ctx);
  s.cloudAccount = new CloudAccountService(ctx);
  s.deviceLogin = new DeviceLoginService(ctx);

  ctx.runtime = deps.runtime(s.chat.hooks);
  const gateway = new Gateway(ctx);
  ctx.gateway = { get port() { return gateway.port; }, disconnectDevice: (id) => gateway.disconnectDevice(id), reconnectDevice: (id, reason) => gateway.reconnectDevice(id, reason), onlineDevices: () => gateway.onlineDevices(), inFront: (id) => gateway.inFront(id), atDesk: (member) => gateway.atDesk(member) };

  let started = false;
  let offWake: (() => void) | null = null;
  const core: Core = {
    ctx, gateway, services: s, ownerToken: auth.ownerToken,

    async start() {
      if (started) return;
      started = true;
      s.providers.applyCustom();
      s.providers.migrateRetired();
      s.bots.ensureDefault();
      traceMark('core:stores');
      // threads that were mid-turn when the app quit
      for (const t of s.threads.list({ limit: 100_000 })) if (t.status !== 'idle') store.threads.put({ ...t, status: 'idle' });
      // before anything that can fail: it also undoes lid mode a crashed run left on
      await s.power.start().catch((e) => log.error('power start failed', errMsg(e)));
      traceMark('core:power');

      const settings = s.settings.get();
      const port = await gateway.listen(deps.port ?? settings.gateway.port, { host: deps.host });
      if (deps.port === undefined && port !== settings.gateway.port) s.settings.update({ gateway: { ...settings.gateway, port } });
      log.info(`gateway listening on port ${port}`);
      traceMark('core:gateway');

      // computer use starts beside the window rather than before it (Cua's driver and permission check take ~0.2s,
      // ~70ms of it on this thread): once the window's page is loading (CoreDeps.computerStartAfter), else on the next
      // turn of the event loop. The gateway's hello waits for it, so the first snapshot still says what it can do
      void s.computer.init({ after: deps.computerStartAfter ?? new Promise<void>((r) => setImmediate(r)) }).catch((e) => log.error('computer init failed', errMsg(e))).then(() => traceMark('core:computer'));
      try { s.voice.start(); } catch (e) { log.error('voice start failed', errMsg(e)); }
      s.system.startLoginItem();
      s.routines.start();
      traceMark('core:voice-routines');
      // AppuBot Connect runs only while a phone is paired (a no-op otherwise)
      void s.connect.start('launch');
      // after a sleep its relay socket may look open and be long dead: checked at once
      offWake = deps.onWake?.((why) => { s.connect.nudge(why); void s.channels.afterWake(why); }) ?? null;
      if (!deps.quiet) {
        // the user's own computer: their AppuBot Cloud account's notices while the window is hidden (nothing without one)
        if (!deps.cloud) s.cloudAccount.startPolling();
        void s.tailscale.status(true).then(() => bus.emit('system.updated', s.system.info())).catch(() => undefined);
        s.system.watchNetwork();
        void s.providers.refreshQuiet();
        // an AppuBot Cloud computer: Claude Code installs itself where it is missing (the launch bonus runs on it)
        s.agentSetup.start();
        // a person's own computer: the free Claude day, when one is on (services/promo.ts)
        s.promo.start();
        // every computer: OpenCode, the agent that needs no account, installed where missing and made the default where it should be
        s.freeAgent.start();
        s.providerUpdates.start();
        s.appUpdate.start();
        s.analytics.start();
        s.storage.start();
        s.providers.warmChoices();
        s.limits.start();
        void s.channels.start().catch((e) => log.error('channels start failed', errMsg(e)));
        // check (or make) the bots' Composio sessions before their first turns need them
        void s.composio.warm();
        // the work a restart for an update stopped
        s.appUpdate.scheduleResume();
      }
    },

    async stop() {
      const step = async (name: string, fn: () => unknown) => {
        try { await fn(); } catch (e) { log.warn(`shutdown: ${name} failed`, errMsg(e)); }
      };
      // first: index.ts gives stop() only 8s, and sleep must come back on
      await step('power', () => s.power.stop());
      offWake?.();
      offWake = null;
      await step('connect', () => s.connect.stop('shutdown'));
      s.push.stop();
      s.cloudAccount.shutdown();
      s.deviceLogin.stopAll();
      s.system.stopWatching();
      s.providers.shutdown();
      s.providerUpdates.stop();
      s.agentSetup.stop();
      s.promo.stop();
      s.freeAgent.stop();
      s.appUpdate.stop();
      s.storage.stop();
      s.characters.shutdown();
      await step('analytics', () => s.analytics.stop());
      s.providers.stopWarm();
      s.limits.stop();
      await step('teach', () => s.teach.shutdown());
      await step('routines', () => s.routines.stop());
      s.groups.shutdown();
      s.handoffs.shutdown();
      s.goals.shutdown();
      await step('channels', () => s.channels.stop(false));
      await step('apps', () => s.composio.shutdown());
      await step('agent bridge', () => s.agentBridge.shutdown());
      await step('chat', () => s.chat.shutdown());
      await step('runtime', () => Promise.race([ctx.runtime.shutdown(), new Promise((r) => setTimeout(r, 4000))]));
      s.liveView.shutdown();
      await step('computer', () => s.computer.shutdown());
      await step('voice', () => s.voice.shutdown());
      await step('gateway', () => gateway.close());
      bus.dispose();
      await step('store', () => store.flush());
      started = false;
    },
  };
  return core;
}
