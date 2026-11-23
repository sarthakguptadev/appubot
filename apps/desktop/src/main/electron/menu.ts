/**
 * The application menu. macOS: the standard app menu (Edit roles keep copy/paste working in the renderer), with Quit
 * on Cmd+Q like any app (it asks only while a bot is working: electron/quit.ts). Windows and Linux: the window has no
 * menu bar (its title bar is the page's own), but the menu's shortcuts still work there; Ctrl+Q quits like the tray's
 * Quit, and closing the window hides it to the tray.
 */
import { Menu, app, shell, type MenuItemConstructorOptions } from 'electron';
import { resetZoom, showMainWindow } from './window';
import { openSupportChat } from './supportChat';

/**
 * No Reload in the app: Cmd/Ctrl+R reloaded the window like a web page (the chat blinked away and came back), which no
 * app does. A dev build keeps one for working on the window, on a shortcut nobody presses by habit.
 */
const VIEW_MENU: MenuItemConstructorOptions = {
  label: 'View',
  submenu: [
    ...(app.isPackaged ? [] : [{ role: 'reload', label: 'Reload (dev)', accelerator: 'CommandOrControl+Alt+Shift+R' } satisfies MenuItemConstructorOptions]),
    { role: 'toggleDevTools' },
    { type: 'separator' },
    { label: 'Actual Size', accelerator: 'CommandOrControl+0', click: resetZoom },
    { role: 'zoomIn' },
    { role: 'zoomOut' },
    { type: 'separator' },
    { role: 'togglefullscreen' },
  ],
};

const HELP_MENU: MenuItemConstructorOptions = {
  role: 'help',
  submenu: [
    { label: 'Chat with Sarthak', click: () => { openSupportChat(); } },
    { label: 'Email sarthak@appubot.com', click: () => void shell.openExternal('mailto:sarthak@appubot.com') },
    { type: 'separator' },
    { label: 'Agent Client Protocol', click: () => void shell.openExternal('https://agentclientprotocol.com') },
  ],
};

export function installAppMenu(quit: () => void): void {
  const template: MenuItemConstructorOptions[] = process.platform === 'darwin' ? [
    {
      label: app.getName(),
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        // not the `quit` role: that goes around the "a bot is working" question in a dev build
        { label: `Quit ${app.getName()}`, accelerator: 'Command+Q', click: quit },
      ],
    },
    { role: 'editMenu' },
    VIEW_MENU,
    {
      role: 'window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { label: 'Show AppuBot', accelerator: 'Command+0', click: () => showMainWindow() },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
    HELP_MENU,
  ] : [
    { label: 'File', submenu: [{ label: `Quit ${app.getName()}`, accelerator: 'Ctrl+Q', click: quit }] },
    { role: 'editMenu' },
    VIEW_MENU,
    { role: 'windowMenu' },
    HELP_MENU,
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
