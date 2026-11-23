import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { AppuBotDesktopApi } from './api';

const api: AppuBotDesktopApi = {
  getGateway: () => ipcRenderer.invoke('appubot:getGateway'),
  platform: process.platform as AppuBotDesktopApi['platform'],
  version: process.env.APPUBOT_VERSION ?? '0.1.0',
  openExternal: (url) => ipcRenderer.invoke('appubot:openExternal', url),
  authRelay: (req) => ipcRenderer.invoke('appubot:authRelay', req),
  authRelayCancel: (port) => ipcRenderer.invoke('appubot:authRelayCancel', port),
  supportPanel: (state) => ipcRenderer.send('appubot:supportPanel', state),
  onSupportToggle: (cb) => {
    const h = (_e: Electron.IpcRendererEvent, to: { open: boolean }) => cb(to);
    ipcRenderer.on('appubot:supportToggle', h);
    return () => ipcRenderer.off('appubot:supportToggle', h);
  },
  onSupportUnread: (cb) => {
    const h = (_e: Electron.IpcRendererEvent, u: { count: number }) => cb(u);
    ipcRenderer.on('appubot:supportUnread', h);
    return () => ipcRenderer.off('appubot:supportUnread', h);
  },
  showInFolder: (p) => ipcRenderer.invoke('appubot:showInFolder', p),
  openNotices: () => ipcRenderer.invoke('appubot:openNotices'),
  remoteFile: (req) => ipcRenderer.invoke('appubot:remoteFile', req),
  pickFiles: (opts) => ipcRenderer.invoke('appubot:pickFiles', opts ?? {}),
  pathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch { return ''; } },
  imageToJpeg: (p) => ipcRenderer.invoke('appubot:imageToJpeg', p),
  fileThumbnail: (p) => ipcRenderer.invoke('appubot:fileThumbnail', p),
  setTheme: (t) => ipcRenderer.invoke('appubot:setTheme', t),
  onNativeTheme: (cb) => {
    const h = (_e: unknown, dark: boolean) => cb(dark);
    ipcRenderer.on('appubot:nativeTheme', h);
    return () => ipcRenderer.off('appubot:nativeTheme', h);
  },
  getNativeTheme: () => ipcRenderer.invoke('appubot:getNativeTheme'),
  windowControl: (a) => ipcRenderer.send('appubot:windowControl', a),
  openTerminal: (cmd) => ipcRenderer.invoke('appubot:openTerminal', cmd),
  openSystemSettings: (pane) => ipcRenderer.invoke('appubot:openSystemSettings', pane),
  requestMicrophone: () => ipcRenderer.invoke('appubot:requestMicrophone'),
  microphoneAccess: () => ipcRenderer.invoke('appubot:microphoneAccess'),
  computerName: () => ipcRenderer.invoke('appubot:computerName'),
  atComputer: () => ipcRenderer.invoke('appubot:atComputer'),
  usedApp: () => { ipcRenderer.send('appubot:usedApp'); },
  relaunch: () => ipcRenderer.send('appubot:relaunch'),
  onQuitRequest: (cb) => {
    const h = (_e: unknown, req: { id: number; working: number }) => cb(req);
    ipcRenderer.on('appubot:quitRequest', h);
    return () => ipcRenderer.off('appubot:quitRequest', h);
  },
  onQuitCancel: (cb) => {
    const h = (_e: unknown, id: number) => cb(id);
    ipcRenderer.on('appubot:quitCancel', h);
    return () => ipcRenderer.off('appubot:quitCancel', h);
  },
  quitAck: (id) => ipcRenderer.send('appubot:quitAck', id),
  answerQuit: (id, ok) => ipcRenderer.send('appubot:quitAnswer', id, ok),
  voiceBarSize: (size) => ipcRenderer.send('appubot:voiceBarSize', size),
  voiceBarIgnore: (ignore) => ipcRenderer.send('appubot:voiceBarIgnore', ignore),
  voiceBarClose: () => ipcRenderer.send('appubot:voiceBarClose'),
  onVoiceBarEnd: (cb) => {
    const h = () => cb();
    ipcRenderer.on('appubot:voiceBarEnd', h);
    return () => ipcRenderer.off('appubot:voiceBarEnd', h);
  },
  showApp: () => ipcRenderer.send('appubot:showApp'),
  onEndVoice: (cb) => {
    const h = () => cb();
    ipcRenderer.on('appubot:endVoice', h);
    return () => ipcRenderer.off('appubot:endVoice', h);
  },
  endVoiceBar: () => ipcRenderer.send('appubot:voiceBarHangUp'),
  onNavigate: (cb) => {
    const h = (_e: Electron.IpcRendererEvent, to: { to: 'settings' | 'bot'; id?: string }) => cb(to);
    ipcRenderer.on('appubot:navigate', h);
    return () => ipcRenderer.off('appubot:navigate', h);
  },
  onAppsSignedIn: (cb) => {
    const h = (_e: Electron.IpcRendererEvent, back: { code?: string; state?: string; error?: string }) => cb(back);
    ipcRenderer.on('appubot:appsSignedIn', h);
    return () => ipcRenderer.off('appubot:appsSignedIn', h);
  },
};
contextBridge.exposeInMainWorld('appubot', api);
