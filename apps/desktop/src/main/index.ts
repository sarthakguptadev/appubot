/**
 * Electron bootstrap: single-instance lock → core (gateway + services + ACP runtime) → window, tray,
 * menu, IPC, deep links. The window hides on close; Cmd+Q, the menus' Quit and Dock › Quit quit, asking first only
 * while a bot is working (electron/quit.ts).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Notification, app, nativeImage, powerMonitor, safeStorage, shell } from 'electron';
import { createAgentRuntime } from '@appubot/agent-runtime';
import { computerUseSupported } from '@appubot/protocol';
import { createCore, type Core } from './core/app';
import type { CorePaths, ImageCodec } from './core/context';
import type { VoiceRuntime } from './core/services/voice';
import { linuxSessionProblem } from './core/services/inputRecorder';
import { errMsg } from './core/util';
import { agentCursorSupported, createAgentCursorHost } from './electron/agentCursor';
import { decodeAudio } from './electron/audioDecode';
import { ANALYTICS, VERSION_POLICY_URL, createAppUpdaterHost } from './electron/appUpdater';
import { registerDeepLinks } from './electron/deeplinks';
import { setCloudLinksCore } from './electron/cloudLinks';
import { createInputWatchHost } from './electron/inputWatch';
import { openExternalSafe, openInTerminal, registerIpc } from './electron/ipc';
import { fileLogger } from './electron/logger';
import { installAppMenu } from './electron/menu';
import { createLinuxPowerHost, createPowerHost, createWindowsPowerHost } from './electron/power';
import { svgToJpeg } from './electron/svgImage';
import { pageFont } from './electron/pageFont';
import { requestQuit, settleQuitPrompt, stillRunningHint, systemQuitting, watchSystemQuit } from './electron/quit';
import { relaunchHidden } from './core/services/updateRestart';
import { voiceBarBot } from './electron/voiceBar';
import { loginItem, notificationAccess, openedAtLogin, requestNotifications } from './electron/systemAccess';
import { createTray } from './electron/tray';
import { computerName, onComputerName } from './electron/computerName';
import { createMainWindow, isQuitting, mainWindow, markQuitting, onFirstHide, showMainWindow } from './electron/window';
import { traceMark } from './core/startupTrace';

traceMark('main:module');

app.setName('AppuBot');
// Windows shows notifications (and groups the taskbar button) by this id; electron-builder.yml's appId
const BUNDLE_ID = 'ai.appubot.desktop';

/** shown notifications, held until they're done: a collected one loses its click handler */
const liveNotifications = new Set<Notification>();

/**
 * Shows a notification and resolves with what came of it: `show` once the OS took it, `failed` with its reason (macOS:
 * AppuBot isn't allowed to notify, its first one asks). No answer in 4s counts as shown.
 */
function showNotification(title: string, body: string, onClick?: () => void): Promise<{ shown: boolean; error?: string }> {
  if (!Notification.isSupported()) return Promise.resolve({ shown: false, error: 'Notifications aren’t supported here.' });
  const n = new Notification({ title, body, silent: false });
  liveNotifications.add(n);
  const done = () => liveNotifications.delete(n);
  n.on('close', done);
  n.on('click', () => { done(); onClick?.(); });
  setTimeout(done, 10 * 60_000);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ shown: true }), 4000);
    n.once('show', () => { clearTimeout(timer); resolve({ shown: true }); });
    n.once('failed', (_e, error) => { clearTimeout(timer); done(); resolve({ shown: false, error: String(error) }); });
    n.show();
  });
}
if (process.platform === 'win32') app.setAppUserModelId(BUNDLE_ID);
/** macOS permissions whose stale entry was already dropped this run (requestCuaPermissions) */
const tccReset = new Set<'accessibility' | 'screenRecording'>();
process.env.APPUBOT_VERSION = app.getVersion();
// An isolated instance (dev harness) gets its own Electron profile, and with it its own single-instance lock.
if (process.env.APPUBOT_DATA_DIR) app.setPath('userData', join(process.env.APPUBOT_DATA_DIR, 'electron'));

/** Cua's entries, each loaded once (importCua); declared before `main()` runs, which starts loading the driver */
const cuaModules = new Map<string, Promise<unknown>>();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void main();
}

function resolvePaths(): CorePaths {
  const dataDir = process.env.APPUBOT_DATA_DIR ?? app.getPath('userData');
  const repoRoot = resolve(app.getAppPath(), '../..');
  return {
    dataDir,
    botsRoot: process.env.APPUBOT_BOTS_ROOT ?? join(homedir(), 'AppuBot'),
    filesDir: join(dataDir, 'files'),
    logsDir: process.env.APPUBOT_DATA_DIR ? join(dataDir, 'logs') : app.getPath('logs'),
    bridgePath: app.isPackaged
      ? join(process.resourcesPath, 'bridge', 'bridge.mjs')
      : join(repoRoot, 'packages', 'mcp-bridge', 'dist', 'bridge.mjs'),
    // the Swift helper (computer use, teach mode) is macOS only
    helperPath: process.platform !== 'darwin' ? undefined : app.isPackaged
      ? join(process.resourcesPath, 'bin', 'appubot-helper')
      : join(repoRoot, 'native', 'appubot-helper', '.build', 'release', 'appubot-helper'),
    // beside main's own bundle (out/main); packaged it is unpacked from app.asar (electron-builder.yml asarUnpack), so
    // the Electron-as-Node child reads it from a real file
    voiceHostPath: unpacked(join(__dirname, 'voiceHost.js')),
  };
}

/** Packaged: a path inside app.asar as its copy in app.asar.unpacked (what dlopen and child processes can read). */
function unpacked(p: string): string {
  return app.isPackaged ? p.replace(`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`) : p;
}

/**
 * The sherpa-onnx addon for this OS and chip (an optional dependency: pnpm installs only this platform's package),
 * loaded by the voice host with dlopen, so packaged it is the app.asar.unpacked copy.
 */
function voiceRuntime(): VoiceRuntime {
  const os = process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'win' : process.platform === 'linux' ? 'linux' : null;
  const arch = process.arch === 'arm64' || process.arch === 'x64' ? process.arch : null;
  if (!os || !arch) return { error: 'Voice needs a 64-bit Mac, Windows or Linux computer.' };
  if (os === 'win' && arch === 'arm64') return { error: 'Voice isn’t available on Windows on Arm yet.' };
  try {
    return { addonPath: unpacked(createRequire(__filename).resolve(`sherpa-onnx-${os}-${arch}/sherpa-onnx.node`)) };
  } catch {
    return { error: 'The speech runtime is missing from this build.' };
  }
}

/** Packaged: load Cua from app.asar.unpacked so the dylib path it passes to dlopen is a real file. */
function loadCua(entry: '' | '/electron'): Promise<unknown> {
  if (!app.isPackaged) return entry ? import('@trycua/cua-driver/electron') : import('@trycua/cua-driver');
  const dist = join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', '@trycua', 'cua-driver', 'dist');
  return import(/* @vite-ignore */ pathToFileURL(join(dist, entry ? 'electron.js' : 'index.js')).href);
}
/** Each Cua entry loaded once: `main()` starts loading the driver at once, so computer use is ready sooner. */
function importCua(entry: '' | '/electron'): Promise<unknown> {
  let m = cuaModules.get(entry);
  if (!m) { m = loadCua(entry); cuaModules.set(entry, m); }
  return m;
}

/**
 * Only the real app flips system power: dev-harness instances (isolated data dir, port or capture) never do, unless
 * APPUBOT_POWER=1. `pmset disablesleep` (Windows: the power plan's lid action) would otherwise outlive a test run on
 * the developer's machine.
 */
function powerAllowed(): boolean {
  if (process.env.APPUBOT_POWER === '1') return true;
  return !process.env.APPUBOT_DATA_DIR && !process.env.APPUBOT_PORT && !process.env.APPUBOT_DEV_CAPTURE;
}

const jpegCodec: ImageCodec = {
  encode(base64, { maxDim, quality }) {
    let img = nativeImage.createFromBuffer(Buffer.from(base64, 'base64'));
    if (img.isEmpty()) return null;
    const { width, height } = img.getSize();
    if (Math.max(width, height) > maxDim) {
      img = width >= height ? img.resize({ width: maxDim, quality: 'good' }) : img.resize({ height: maxDim, quality: 'good' });
    }
    const size = img.getSize();
    // `quality` is 0..1; Electron's toJPEG wants 0..100
    const q = Math.round(Math.min(1, Math.max(0.1, quality)) * 100);
    return { data: img.toJPEG(q).toString('base64'), mimeType: 'image/jpeg', ...size };
  },
};

async function main(): Promise<void> {
  // Cua's driver (computer use) takes ~0.1s to load: it loads while Electron gets ready (a failure surfaces, and is
  // logged, where ComputerService starts it)
  if (computerUseSupported(process.platform)) importCua('').catch(() => undefined);
  let core: Core | null = null;
  let stopping = false;

  app.on('second-instance', () => showMainWindow());
  app.on('activate', () => showMainWindow());
  app.on('window-all-closed', () => { /* stay alive in the menu bar */ });
  app.on('before-quit', (e) => {
    // Dock › Quit and `kill` land here unasked: ask first if a bot is working (confirmed quits and the relaunch IPC
    // are marked already).
    // Dev builds let it through so Ctrl+C and electron-vite restarts work.
    if (core && !stopping && !isQuitting() && !systemQuitting() && app.isPackaged) {
      e.preventDefault();
      void requestQuit(core);
      return;
    }
    markQuitting();
    // a quit prompt still open (logout, shutdown, a dev Ctrl+C) counts as Cancel: the app is stopping anyway
    settleQuitPrompt();
    if (!core) return;
    // a second quit while stopping waits too, so core.stop() and the store flush finish
    e.preventDefault();
    if (stopping) return;
    stopping = true;
    mainWindow()?.hide();
    const c = core;
    void Promise.race([c.stop(), new Promise((r) => setTimeout(r, 8000))]).finally(() => {
      core = null;
      app.quit();
    });
  });

  await app.whenReady();
  traceMark('main:ready');
  watchSystemQuit();
  const paths = resolvePaths();
  const log = fileLogger(paths.logsDir, !!process.env.APPUBOT_DEBUG);
  registerDeepLinks((m) => log.info(m));

  // computer use starts its backend once the window's page is loading (CoreDeps.computerStartAfter), at the latest 2s in
  let pageLoading: () => void = () => undefined;
  const computerStartAfter = new Promise<void>((r) => { pageLoading = r; setTimeout(r, 2000).unref?.(); });
  core = createCore({
    paths,
    computerStartAfter,
    runtime: (hooks) => createAgentRuntime({ hooks, dataDir: paths.dataDir }),
    imageCodec: jpegCodec,
    svgToJpeg,
    pageFont,
    // the Vault's secrets, sealed with the OS keychain (Linux without a keyring would only obscure them: kept as is, 0600)
    secretBox: safeStorage.isEncryptionAvailable() && !(process.platform === 'linux' && safeStorage.getSelectedStorageBackend?.() === 'basic_text')
      ? { encrypt: (s) => safeStorage.encryptString(s).toString('base64'), decrypt: (s) => safeStorage.decryptString(Buffer.from(s, 'base64')) }
      : undefined,
    // speech on this computer (voice mode, dictation, Telegram voice notes)
    voiceRuntime: voiceRuntime(),
    decodeAudio,
    openExternal: openExternalSafe,
    openTerminal: openInTerminal,
    openFile: async (p) => {
      const err = await shell.openPath(p);
      if (err) throw new Error(err);
    },
    trashItem: (p) => shell.trashItem(p),
    openPath: async (p) => {
      if (statSync(p).isDirectory()) {
        const err = await shell.openPath(p);
        if (err) throw new Error(err);
      } else {
        shell.showItemInFolder(p);
      }
    },
    nativeNotify: (title, body, onClick) => showNotification(title, body, onClick),
    notificationAccess: () => notificationAccess(BUNDLE_ID, log),
    requestNotifications: () => requestNotifications(BUNDLE_ID, log),
    // only the real app registers itself to open at login (never dev builds or test instances)
    ...(app.isPackaged && powerAllowed() ? { loginItem: loginItem(BUNDLE_ID) } : {}),
    // Cua and the agent cursor serve computer use (macOS, Windows and Linux); the cursor only where its overlay is safe
    ...(computerUseSupported(process.platform) ? { importCua } : {}),
    agentCursor: computerUseSupported(process.platform) && agentCursorSupported() ? createAgentCursorHost() : undefined,
    // teach mode's recording: the Swift helper on macOS, global hooks elsewhere (uiohook-napi, loaded on first use)
    inputWatch: process.platform === 'win32' || process.platform === 'linux' ? createInputWatchHost(log) : undefined,
    power: !powerAllowed() ? undefined
      : process.platform === 'darwin' ? createPowerHost()
        : process.platform === 'win32' ? createWindowsPowerHost(paths.dataDir) : createLinuxPowerHost(),
    // only the real app updates itself (never dev builds or test instances)
    appUpdater: app.isPackaged && powerAllowed() ? createAppUpdaterHost(log) : undefined,
    ...(app.isPackaged && powerAllowed() ? { versionPolicyUrl: VERSION_POLICY_URL } : {}),
    // anonymous usage analytics: the real app only (APPUBOT_ANALYTICS=1 tries them from a dev build given MAIN_VITE_POSTHOG_KEY)
    ...(ANALYTICS && ((app.isPackaged && powerAllowed()) || process.env.APPUBOT_ANALYTICS === '1') ? { analytics: ANALYTICS } : {}),
    requestCuaPermissions: async () => {
      // macOS's grants only: Windows and Linux have no permission prompts (Cua ignores `prompt` there), nothing to ask
      if (process.platform !== 'darwin') return { accessibility: true, screenRecording: true };
      const mod = (await importCua('/electron')) as typeof import('@trycua/cua-driver/electron');
      let s = mod.requestMacOSPermissions();
      // A grant made for an earlier build can stay switched on in System Settings while macOS no longer trusts this
      // one, and macOS doesn't ask again while that entry is there. So the first time a grant is still missing after
      // asking, AppuBot's own entry for it is dropped (tccutil, our bundle id only) and macOS is asked afresh. Once per
      // run: Screen Recording counts only after a relaunch, so a later ask must not undo a grant just made.
      const stale = (['accessibility', 'screenRecording'] as const).filter((k) => !s[k] && !tccReset.has(k));
      if (app.isPackaged && stale.length) {
        for (const k of stale) {
          tccReset.add(k);
          try {
            execFileSync('/usr/bin/tccutil', ['reset', k === 'accessibility' ? 'Accessibility' : 'ScreenCapture', BUNDLE_ID], { timeout: 5000 });
          } catch (e) { log.warn(`tccutil reset ${k} failed`, errMsg(e)); }
        }
        s = mod.requestMacOSPermissions();
      }
      return { accessibility: s.accessibility, screenRecording: s.screenRecording };
    },
    version: app.getVersion(),
    hostName: computerName(),
    systemLanguage: () => app.getPreferredSystemLanguages()[0] ?? app.getLocale(),
    log,
    validate: !app.isPackaged,
    ...(process.env.APPUBOT_PORT ? { port: Number(process.env.APPUBOT_PORT) } : {}),
    // dev only: a fake AppuBot Cloud backend in this process, never in the packaged app
    ...(!app.isPackaged && process.env.APPUBOT_CLOUD_FAKE ? { cloudFake: { state: process.env.APPUBOT_CLOUD_FAKE } } : {}),
    ...(process.env.APPUBOT_CLOUD_URL ? { cloudBackendUrl: process.env.APPUBOT_CLOUD_URL } : {}),
    // pairing a phone and AppuBot Connect need this computer signed in to AppuBot (dev scripts that pair without an
    // account: APPUBOT_PAIR_WITHOUT_ACCOUNT=1, never in the packaged app)
    accountRequired: app.isPackaged || process.env.APPUBOT_PAIR_WITHOUT_ACCOUNT !== '1',
    // a new thread is opened by its bot, never left empty
    threadOpeners: true,
    // in front of the user: shown (not hidden to the tray or minimized) and the window they're using, on every OS
    isAppFocused: () => { const w = mainWindow(); return !!w && w.isVisible() && !w.isMinimized() && w.isFocused(); },
    showApp: () => showMainWindow(),
    voiceCallOpen: () => voiceBarBot() !== null,
    windowHidden: () => { const w = mainWindow(); return !w || !w.isVisible() || w.isMinimized(); },
    // background computer use waits for the user to pause by it; not on Linux without X11, whose idle count (what
    // Chromium reads there) misses input to native Wayland apps: there it doesn't wait
    ...(process.platform !== 'linux' || !linuxSessionProblem(process.env) ? { systemIdleMs: () => powerMonitor.getSystemIdleTime() * 1000 } : {}),
    screenLocked: () => powerMonitor.getSystemIdleState(1) === 'locked',
    // waking up or unlocking: AppuBot Connect checks its relay socket at once (it may have died while asleep)
    onWake: (fn) => {
      const resume = (): void => fn('woke from sleep');
      const unlock = (): void => fn('screen unlocked');
      powerMonitor.on('resume', resume).on('unlock-screen', unlock);
      return () => { powerMonitor.off('resume', resume).off('unlock-screen', unlock); };
    },
  });

  traceMark('core:created');
  try {
    await core.start();
  } catch (e) {
    log.error('core failed to start', errMsg(e));
  }

  // Dev-only handshake for scripts/e2e-smoke.mjs; never written by packaged builds.
  if (!app.isPackaged && process.env.APPUBOT_DEV_INFO) {
    writeFileSync(process.env.APPUBOT_DEV_INFO, JSON.stringify({ url: `http://127.0.0.1:${core.gateway.port}`, token: core.ownerToken }), { mode: 0o600 });
  }

  traceMark('core:started');
  registerIpc(core);
  // this Mac's name as Finder shows it, read again now and then: a rename reaches the pairing QR, the health check and
  // the phones (system.updated) without a restart; the window asks for it itself (appubot:computerName)
  onComputerName((name) => {
    if (!core) return;
    core.ctx.deps.hostName = name;
    core.ctx.bus.emit('system.updated', core.ctx.s.system.info());
  });
  // `appubot://cloud/*` links (the browser sign-in, Dodo's return page) reach the core from here on
  setCloudLinksCore(core);
  // the window first: its page loads in its own process while the menu and the tray are built here
  // started by the OS at login, or back from an update restart that began out of sight: stay in the menu bar / tray
  const win = createMainWindow({ hidden: openedAtLogin() || relaunchHidden(paths.dataDir, app.getVersion()) });
  traceMark('main:window-created');
  win.once('ready-to-show', () => traceMark('win:ready-to-show'));
  win.webContents.once('did-finish-load', () => traceMark('win:did-finish-load'));
  // the page is committed and its renderer busy with the bundle: computer use's backend starts now (measured best of
  // starting right away, at did-navigate or at dom-ready: bench/startup.mjs)
  win.webContents.once('did-navigate', () => pageLoading());
  const quit = (): void => { if (core && !stopping) void requestQuit(core); };
  installAppMenu(quit);
  createTray(core, quit);
  // Windows and Linux: closing the window hides it to the tray; the first time, a notification says so
  onFirstHide(stillRunningHint);
  // a dev run is Electron's own app: give its Dock our icon, the glass rendition on macOS's icon grid (dock-icon.png,
  // make-icon.mjs); packaged, the bundle's Icon Composer icon draws itself. After the window: it takes ~60ms
  if (!app.isPackaged) app.dock?.setIcon(join(app.getAppPath(), 'resources', 'dock-icon.png'));
  // first launch (macOS hasn't asked yet): ask for notifications once the window is up, so the user sees why
  setTimeout(() => { void core?.ctx.s.notifications.askIfNotAsked().catch((e) => log.warn('asking for notifications failed', errMsg(e))); }, 2500);
  // Windows logoff or shutdown: Electron sends no before-quit and Windows ends the process shortly, so the window may
  // close for real and what is waiting to be saved is written now
  if (process.platform === 'win32') {
    win.on('session-end', () => {
      markQuitting();
      try { core?.ctx.store.flush(); } catch (e) { log.warn('saving at session end failed', errMsg(e)); }
    });
  }

  // Dev-only: `kill -USR2 <pid>` writes a PNG of the window to $APPUBOT_DEV_CAPTURE (UI checks without screen
  // recording). If `<capture>.js` exists it is run in the renderer first (e.g. to click somewhere), then removed.
  if (!app.isPackaged && process.env.APPUBOT_DEV_CAPTURE) {
    const out = process.env.APPUBOT_DEV_CAPTURE;
    process.on('SIGUSR2', () => {
      const w = mainWindow();
      if (!w) return;
      void (async () => {
        // `<capture>.url`: load this page first (the mocks' `?settings=…`); from main, since a navigation the page
        // makes itself goes to the default browser (window.ts will-navigate)
        if (existsSync(`${out}.url`)) {
          const url = readFileSync(`${out}.url`, 'utf8').trim();
          rmSync(`${out}.url`);
          await Promise.all([new Promise<void>((r) => w.webContents.once('did-finish-load', () => r())), w.loadURL(url)]).catch((e: unknown) => log.warn('capture load failed', errMsg(e)));
          await new Promise((r) => setTimeout(r, 1500));
        }
        if (existsSync(`${out}.js`)) {
          const script = readFileSync(`${out}.js`, 'utf8');
          rmSync(`${out}.js`);
          await w.webContents.executeJavaScript(script).catch((e: unknown) => log.warn('capture script failed', errMsg(e)));
          await new Promise((r) => setTimeout(r, 900));
        }
        // a window at opacity 0 is occluded for macOS, and its page captures empty: opaque for the shot, then back
        w.setOpacity(1);
        await new Promise((r) => setTimeout(r, 250));
        try { writeFileSync(out, (await w.webContents.capturePage()).toPNG()); } finally { w.setOpacity(0); }
      })();
    });
  }
}
