/**
 * Menu bar (macOS) / tray (Windows, Linux) icon, laid out like Amphetamine's: the status (plus any warning), "Talk to:"
 * with the bots talked to last (a voice call from the menu bar, `voiceBar.ts`; More Bots for the rest, End Call during
 * one), Open AppuBot, Quick Settings (pause computer use, work in the background, keep awake), Settings…, About,
 * Feedback & Support (the support chat widget, email, What's New, the site), Restart to Update once one is downloaded and Quit
 * (asks only while a bot is working). Shortcuts are shown, not registered (the app menu owns ⌘Q). On macOS the icon is the logo's bot as a template glyph
 * (`trayGlyph.ts`); elsewhere it is the app icon, which a dark or light taskbar both show (a black template glyph would
 * vanish on a dark one).
 */
import { Menu, Tray, app, nativeImage, shell, type MenuItemConstructorOptions, type NativeImage } from 'electron';
import { computerUseSupported, machineName, type EventName, type PowerStatus } from '@appubot/protocol';
import type { Core } from '../core/app';
import { drawGlyph } from './trayGlyph';
import { appIconPath, mainWindow, showMainWindow } from './window';
import { closeVoiceBar, onVoiceBarChange, openVoiceBar, voiceBarBot } from './voiceBar';
import { openSupportChat } from './supportChat';

function trayIcon(): NativeImage {
  if (process.platform !== 'darwin') {
    const icon = nativeImage.createFromPath(appIconPath());
    if (!icon.isEmpty()) {
      // Linux tray hosts scale it themselves; Windows takes a 16px image (and a sharper one on high-DPI screens)
      if (process.platform !== 'win32') return icon.resize({ width: 64, height: 64, quality: 'best' });
      const img = nativeImage.createEmpty();
      for (const scaleFactor of [1, 1.5, 2]) {
        const px = Math.round(16 * scaleFactor);
        img.addRepresentation({ scaleFactor, width: px, height: px, dataURL: icon.resize({ width: px, height: px, quality: 'best' }).toDataURL() });
      }
      return img;
    }
  }
  // the logo's bot as a template glyph, 18pt like the system's own menu bar icons
  const img = nativeImage.createFromBitmap(drawGlyph(18), { width: 18, height: 18, scaleFactor: 1 });
  img.addRepresentation({ scaleFactor: 2, width: 36, height: 36, buffer: drawGlyph(36) });
  img.setTemplateImage(true);
  return img;
}


/** bots listed under "Talk to:" before the rest go under More Bots */
const SHOWN_BOTS = 5;

/** A section title: macOS 14's menu header, else a greyed line. */
const header = (label: string): MenuItemConstructorOptions =>
  process.platform === 'darwin' ? { type: 'header', label } : { label, enabled: false };

/** Opens the window on a place in it (Settings, a bot). */
function go(to: { to: 'settings' | 'bot'; id?: string }): void {
  const w = showMainWindow();
  const send = () => mainWindow()?.webContents.send('appubot:navigate', to);
  if (w.webContents.isLoading()) w.webContents.once('did-finish-load', send); else send();
}

const REBUILD_ON = new Set<EventName>(['computer.status', 'thread.updated', 'thread.deleted', 'settings.updated', 'system.updated', 'bot.updated', 'bot.deleted', 'cloudAccount.updated']);

const LID_LINE: Record<PowerStatus['lidClosed'], string> = {
  on: 'Lid closed: stays awake',
  off: 'Lid closed: sleeps',
  setup: 'Lid closed: set up in Settings',
  'paused-battery': 'Lid closed: paused, battery low',
  'paused-heat': 'Lid closed: paused, Mac is hot',
  error: 'Lid closed: needs attention',
};

export function createTray(core: Core, quit: () => void): Tray {
  const tray = new Tray(trayIcon());
  tray.setToolTip('AppuBot');
  const rebuild = (): void => {
    const cs = core.services.computer.status();
    const running = core.services.threads.list({ limit: 200 }).filter((t) => t.status !== 'idle').length;
    const status = running ? `${running} bot${running === 1 ? '' : 's'} working` : 'Idle';
    const power = core.services.settings.get().power;
    const ps = core.services.power.status();
    const lid = ps && power.keepAwake && power.lidClosed ? LID_LINE[ps.lidClosed] : null;
    const update = core.services.appUpdate.status();
    const bots = core.services.bots.list();
    // bots by when you last talked to them (their non-Telegram chats), newest first
    const lastAt = new Map<string, number>();
    for (const t of core.services.threads.list({ limit: 200 })) {
      if (t.source === 'channel') continue;
      const at = t.lastActiveAt ?? t.createdAt;
      if (at > (lastAt.get(t.botId) ?? -1)) lastAt.set(t.botId, at);
    }
    const byRecent = [...bots].sort((a, b) => (lastAt.get(b.id) ?? -1) - (lastAt.get(a.id) ?? -1));
    const inCall = voiceBarBot();
    const callee = inCall ? bots.find((b) => b.id === inCall) : undefined;
    const call = (id: string) => () => openVoiceBar(id);
    // a voice call from the menu bar: the bots talked to last, the rest under More Bots
    const talk: MenuItemConstructorOptions[] = inCall
      ? [{ label: `End Call${callee ? ` with ${callee.name}` : ''}`, click: () => closeVoiceBar() }]
      : [
        ...byRecent.slice(0, SHOWN_BOTS).map((b) => ({ label: b.name, click: call(b.id) })),
        ...(byRecent.length > SHOWN_BOTS ? [{ label: 'More Bots', submenu: byRecent.slice(SHOWN_BOTS).map((b) => ({ label: b.name, click: call(b.id) })) }] : []),
      ];
    const quick: MenuItemConstructorOptions[] = [
      // computer use: macOS, Windows and Linux
      ...(computerUseSupported(process.platform) ? [{
        label: 'Pause Computer Use', type: 'checkbox' as const, checked: cs.paused,
        click: () => { if (cs.paused) core.services.computer.resume(); else core.services.computer.pause(); },
      }, {
        // background mode: bots' windows stay behind the user's while they keep working
        label: 'Work in the Background', type: 'checkbox' as const, checked: cs.background,
        click: () => { const c = core.services.settings.get().computer; core.services.settings.update({ computer: { ...c, background: !c.background } }); },
      }] : []),
      ...(ps ? [{
        label: `Keep ${machineName(process.platform)} Awake`, type: 'checkbox' as const, checked: power.keepAwake,
        click: () => { core.services.settings.update({ power: { ...power, keepAwake: !power.keepAwake } }); },
      }] : []),
    ];
    const notes = [
      ...(update.required ? ['Update required to keep working'] : []),
      ...(lid ? [lid] : []),
      // background mode: a bot's step that needs its window in front waits for the user to pause
      ...(cs.waiting ? [`A bot needs ${cs.waiting.app ?? 'its window'} in front: waiting for you to pause`] : []),
    ];
    tray.setContextMenu(Menu.buildFromTemplate([
      header(`AppuBot: ${status}`),
      ...notes.map((label) => ({ label, enabled: false })),
      { type: 'separator' },
      // "Only in the cloud": this computer's bots aren't offered for a call (one already on stays, to be ended)
      ...(bots.length && (inCall || !core.services.cloudAccount.cloudOnly()) ? [header(inCall ? 'On a Call:' : 'Talk to:'), ...talk, { type: 'separator' as const }] : []),
      { label: 'Open AppuBot', accelerator: 'CommandOrControl+O', registerAccelerator: false, click: () => showMainWindow() },
      ...(quick.length ? [{ label: 'Quick Settings', submenu: quick }] : []),
      { label: 'Settings…', accelerator: 'CommandOrControl+,', registerAccelerator: false, click: () => go({ to: 'settings' }) },
      { type: 'separator' },
      { label: `About ${app.getName()}`, click: () => go({ to: 'settings', id: 'about' }) },
      {
        label: 'Feedback & Support',
        submenu: [
          { label: 'Chat with Sarthak', click: () => { openSupportChat(); } },
          { label: 'Email sarthak@appubot.com', click: () => void shell.openExternal('mailto:sarthak@appubot.com') },
          { type: 'separator' },
          { label: "What's New", click: () => go({ to: 'settings', id: 'whats-new' }) },
          { label: 'appubot.com', click: () => void shell.openExternal('https://appubot.com') },
        ],
      },
      { type: 'separator' },
      // a downloaded update (it would install at the next quit anyway)
      ...(update.state === 'ready' ? [{ label: `Restart to Update to ${update.version ?? 'the New Version'}`, click: () => { core.services.appUpdate.install(); } }] : []),
      { label: `Quit ${app.getName()}`, accelerator: 'CommandOrControl+Q', registerAccelerator: false, click: quit },
    ]));
  };
  rebuild();
  // Windows: a click on the tray icon opens the window (the menu is on right-click); macOS and Linux show the menu
  if (process.platform === 'win32') tray.on('click', () => showMainWindow());
  let timer: NodeJS.Timeout | null = null;
  onVoiceBarChange(() => { if (!tray.isDestroyed()) rebuild(); });
  core.ctx.bus.on(({ event }) => {
    if (!REBUILD_ON.has(event)) return;
    if (!timer) timer = setTimeout(() => { timer = null; if (!tray.isDestroyed()) rebuild(); }, 250);
  });
  return tray;
}
