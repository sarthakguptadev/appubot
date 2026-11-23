/**
 * "Chat with Sarthak": the support chat as a widget in the main window, like the website's. The renderer draws the
 * bubble and the panel's frame (features/support/SupportWidget.tsx); Crisp's hosted chat page (protocol
 * `crispChatUrl`) is a `WebContentsView` of its own laid over the panel, so Crisp's script never runs in the window's
 * page (it holds the gateway's owner token). The view has no preload, a sandboxed page and a session of its own
 * (`persist:` so the conversation is still there next time), may only show Crisp's pages (any other link opens in the
 * browser) and gets no permission but notifications and copying. Collapsing only hides it, so the conversation isn't
 * loaded again; while hidden its unread count is read every few seconds for the bubble's dot.
 *
 * Wire: the renderer sends `appubot:supportPanel {open, bounds (CSS px), radius, user}`; main sends
 * `appubot:supportToggle {open}` (Escape in the chat, the Help menu, the tray) and `appubot:supportUnread {count}`.
 */
import { BrowserWindow, WebContentsView, app, ipcMain, nativeTheme, session, shell } from 'electron';
import { crispChatUrl, isCrispPage, type SupportUser } from '@appubot/protocol';
import { browserMayOpen, mainWindow, showMainWindow } from './window';

const PARTITION = 'persist:support-chat';
const ALLOWED_PERMISSIONS = new Set(['notifications', 'clipboard-sanitized-write']);
/** how often a collapsed chat's unread count is read */
const UNREAD_POLL_MS = 5_000;

interface PanelState {
  open: boolean;
  /** the panel's place in the page, in CSS pixels */
  bounds?: { x: number; y: number; width: number; height: number };
  radius?: number;
  user?: SupportUser;
}

let view: WebContentsView | null = null;
let host: BrowserWindow | null = null;
let sessionReady = false;
let unreadTimer: NodeJS.Timeout | null = null;
let lastUnread = 0;

function supportSession(): Electron.Session {
  const s = session.fromPartition(PARTITION);
  if (!sessionReady) {
    sessionReady = true;
    s.setPermissionRequestHandler((_wc, permission, done) => done(ALLOWED_PERMISSIONS.has(permission)));
    s.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission));
  }
  return s;
}

function openOutside(url: string): void {
  if (/^(https?:|mailto:)/.test(url) && browserMayOpen(url)) void shell.openExternal(url);
}

/** Tells the window's page (the widget's owner). */
function tellPage(channel: string, payload: unknown): void {
  const w = host && !host.isDestroyed() ? host : mainWindow();
  if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
}

/**
 * Runs in Crisp's own page once its `$crisp` is ready (a queue pushed earlier is replaced): what the team sees beside
 * the conversation, the app's version and OS, never a path or a name.
 */
function addSessionData(v: WebContentsView): void {
  const data = [['app', 'desktop'], ['app_version', app.getVersion()], ['os', process.platform], ['arch', process.arch]];
  const js = `(() => {
    let tries = 0;
    const t = setInterval(() => {
      const c = window.$crisp;
      if (c && typeof c.is === 'function') { clearInterval(t); try { c.push(["set", "session:data", [${JSON.stringify(data)}]]); } catch (e) {} }
      else if (++tries > 80) clearInterval(t);
    }, 250);
  })();`;
  void v.webContents.executeJavaScript(js, true).catch(() => undefined);
}

function makeView(win: BrowserWindow, user: SupportUser): WebContentsView {
  const v = new WebContentsView({
    webPreferences: { session: supportSession(), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: true },
  });
  v.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#1a1a1a' : '#ffffff');
  v.setVisible(false);
  const wc = v.webContents;
  wc.setWindowOpenHandler(({ url }) => { openOutside(url); return { action: 'deny' }; });
  wc.on('will-navigate', (e, url) => {
    if (isCrispPage(url)) return;
    e.preventDefault();
    openOutside(url);
  });
  wc.on('will-redirect', (e, url) => { if (!isCrispPage(url)) e.preventDefault(); });
  wc.on('did-finish-load', () => addSessionData(v));
  // Escape in the chat collapses it, like Escape in the window
  wc.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') { e.preventDefault(); tellPage('appubot:supportToggle', { open: false }); }
  });
  wc.on('render-process-gone', () => dropView());
  win.contentView.addChildView(v);
  win.once('closed', () => { if (host === win) dropView(); });
  void wc.loadURL(crispChatUrl(user));
  return v;
}

function dropView(): void {
  stopUnreadPoll();
  if (view) {
    try { host?.contentView.removeChildView(view); } catch { /* window gone */ }
    if (!view.webContents.isDestroyed()) view.webContents.close();
  }
  view = null;
  host = null;
}

function readUnread(): void {
  if (!view || view.webContents.isDestroyed()) return;
  void view.webContents.executeJavaScript('(() => { try { return Number(window.$crisp.get("chat:unread:count")) || 0; } catch (e) { return 0; } })()', true)
    .then((n: unknown) => {
      const count = typeof n === 'number' && n > 0 ? n : 0;
      if (count !== lastUnread) { lastUnread = count; tellPage('appubot:supportUnread', { count }); }
    })
    .catch(() => undefined);
}
function startUnreadPoll(): void {
  if (!unreadTimer) unreadTimer = setInterval(readUnread, UNREAD_POLL_MS);
}
function stopUnreadPoll(): void {
  if (unreadTimer) clearInterval(unreadTimer);
  unreadTimer = null;
}

function applyPanel(win: BrowserWindow, state: PanelState): void {
  if (!state.open) {
    if (view) {
      const hadFocus = view.webContents.isFocused();
      view.setVisible(false);
      if (hadFocus && !win.isDestroyed()) win.webContents.focus();
      startUnreadPoll();
    }
    return;
  }
  if (!view || host !== win) {
    if (view) dropView();
    view = makeView(win, state.user ?? {});
    host = win;
  }
  if (state.bounds) {
    // the page's CSS pixels are the window's points times its zoom (100% unless the person zoomed)
    const z = win.webContents.getZoomFactor();
    const b = state.bounds;
    view.setBounds({ x: Math.round(b.x * z), y: Math.round(b.y * z), width: Math.max(1, Math.round(b.width * z)), height: Math.max(1, Math.round(b.height * z)) });
    if (state.radius) view.setBorderRadius(Math.round(state.radius * z));
  }
  if (!view.getVisible()) {
    view.setVisible(true);
    view.webContents.focus();
  }
  stopUnreadPoll();
  if (lastUnread) { lastUnread = 0; tellPage('appubot:supportUnread', { count: 0 }); }
}

export function registerSupportChatIpc(): void {
  ipcMain.on('appubot:supportPanel', (e, raw: unknown) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win || win !== mainWindow() || !raw || typeof raw !== 'object') return;
    const p = raw as Record<string, unknown>;
    const b = p.bounds as Record<string, unknown> | undefined;
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    const u = p.user as Record<string, unknown> | undefined;
    applyPanel(win, {
      open: p.open === true,
      ...(b ? { bounds: { x: num(b.x), y: num(b.y), width: num(b.width), height: num(b.height) } } : {}),
      radius: num(p.radius),
      user: {
        ...(typeof u?.email === 'string' ? { email: u.email } : {}),
        ...(typeof u?.name === 'string' ? { name: u.name } : {}),
      },
    });
  });
}

/** The Help menu and the tray: brings the window forward and opens the chat in it. */
export function openSupportChat(): void {
  const w = showMainWindow();
  const send = () => { if (!w.isDestroyed()) w.webContents.send('appubot:supportToggle', { open: true }); };
  if (w.webContents.isLoading()) w.webContents.once('did-finish-load', send); else send();
}
