import type { AppuBotDesktopApi } from '../../../preload/api';

/** the browser preview's microphone: not asked until a Request (onboarding's Permissions step shows both) */
let previewMic: 'granted' | 'not-asked' = 'not-asked';

/** Fallback used when the preload bridge is absent (browser preview / mock mode). */
const fallback: AppuBotDesktopApi = {
  getGateway: () => Promise.reject(new Error('Preload bridge unavailable')),
  // a browser preview can look like another OS: ?platform=win32 or ?platform=linux
  platform: (['win32', 'linux'] as const).find((p) => typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('platform') === p) ?? 'darwin',
  version: '0.0.0-dev',
  openExternal: async (url) => { window.open(url, '_blank', 'noopener'); },
  supportPanel: () => undefined,
  onSupportToggle: () => () => undefined,
  onSupportUnread: () => () => undefined,
  showInFolder: async () => undefined,
  openNotices: async () => false,
  pickFiles: async () => [],
  pathForFile: () => '',
  imageToJpeg: async () => null,
  fileThumbnail: async () => null,
  setTheme: async () => undefined,
  onNativeTheme: (cb) => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const h = (e: MediaQueryListEvent) => cb(e.matches);
    mq.addEventListener('change', h);
    return () => mq.removeEventListener('change', h);
  },
  getNativeTheme: async () => window.matchMedia('(prefers-color-scheme: dark)').matches,
  windowControl: () => undefined,
  openTerminal: async () => undefined,
  openSystemSettings: async () => undefined,
  requestMicrophone: async () => { previewMic = 'granted'; return 'granted'; },
  microphoneAccess: async () => previewMic,
  // the browser preview's Mac, as Finder would name it
  computerName: async () => 'Sarthak’s MacBook Pro',
  atComputer: async () => document.hasFocus(),
  relaunch: () => window.location.reload(),
  onQuitRequest: () => () => undefined,
  onQuitCancel: () => () => undefined,
  quitAck: () => undefined,
  answerQuit: () => undefined,
  voiceBarSize: () => undefined,
  voiceBarIgnore: () => undefined,
  voiceBarClose: () => undefined,
  onVoiceBarEnd: () => () => undefined,
  showApp: () => undefined,
  onEndVoice: () => () => undefined,
  onNavigate: () => () => undefined,
  onAppsSignedIn: () => () => undefined,
  endVoiceBar: () => undefined,
};

/** Access the Electron preload API (or a harmless fallback). */
export function native(): AppuBotDesktopApi {
  // no window at all in unit tests (Node)
  return (typeof window === 'undefined' ? undefined : (window as Partial<Window>).appubot) ?? fallback;
}
