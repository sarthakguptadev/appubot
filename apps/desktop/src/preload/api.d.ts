/** A file of another computer: which one (`own`, `team-<id>`), its id there, its name and size. */
export interface RemoteFileRef { computer: string; id: string; name: string; size?: number }

/** Shape of `window.appubot` exposed by the preload script. Renderer talks to the gateway over WebSocket like any other client. */
export interface AppuBotDesktopApi {
  /** Local gateway endpoint for this desktop (loopback) + the owner token. */
  getGateway(): Promise<{ url: string; token: string; deviceId: string }>;
  platform: 'darwin' | 'win32' | 'linux';
  version: string;
  openExternal(url: string): Promise<void>;
  /**
   * An agent's sign-in run on another computer that comes back to a port there (`DeviceLogin.relay`): listens on that
   * port here, opens `url` in this computer's browser and resolves with the address the sign-in came back to (main's
   * electron/authRelay.ts). Absent from a main process older than the window.
   */
  authRelay?(req: { url: string; port: number; path: string }): Promise<string>;
  authRelayCancel?(port: number): Promise<void>;
  /**
   * The support chat widget's panel (main's electron/supportChat.ts lays Crisp's hosted page over it): open with its
   * place in the page (CSS px) and corner radius, or closed (hidden, kept loaded). `user` fills in who is writing.
   */
  supportPanel(state: { open: boolean; bounds?: { x: number; y: number; width: number; height: number }; radius?: number; user?: { email?: string; name?: string } }): void;
  /** Main asks the widget to open or close (Escape in the chat, the Help menu, the tray). */
  onSupportToggle(cb: (to: { open: boolean }) => void): () => void;
  /** Replies waiting in the collapsed chat. */
  onSupportUnread(cb: (u: { count: number }) => void): () => void;
  showInFolder(path: string): Promise<void>;
  /** Opens the file of every package's licence this build carries (THIRD_PARTY_NOTICES.txt); false where it has none. */
  openNotices(): Promise<boolean>;
  /**
   * Another computer's files on this one (main's electron/remoteFiles.ts, a folder per computer: `own`, `team-<id>`):
   * whether a copy is here (its path), its bytes to show, saving fetched bytes, opening the copy in its own app, and
   * putting it in Downloads (shown in Finder). `forget`: one computer's copies, or every one's. Absent from a main
   * process older than the window (a dev reload): the window then keeps the bytes in memory and the browser saves them.
   */
  remoteFile?(req:
    | { op: 'cached' | 'open' | 'download'; ref: RemoteFileRef }
    | { op: 'read'; ref: RemoteFileRef }
    | { op: 'save'; ref: RemoteFileRef; bytes: Uint8Array }
    | { op: 'forget'; computer?: string }): Promise<string | Uint8Array | null>;
  pickFiles(opts?: { multiple?: boolean; directories?: boolean; filters?: { name: string; extensions: string[] }[] }): Promise<string[]>;
  /** Where a dropped or pasted file lives on disk ('' for one that has no file, like a copied screenshot). */
  pathForFile(file: File): string;
  /** A picture on disk the window can't decode (HEIC, TIFF…) as a JPEG ≤2048px (macOS `sips`, else nativeImage); null when it can't. */
  imageToJpeg(path: string): Promise<{ data: string; mimeType: string } | null>;
  /** a file's thumbnail as the system draws it (a data: URL), null where there is none */
  fileThumbnail(path: string): Promise<string | null>;
  setTheme(theme: 'system' | 'light' | 'dark'): Promise<void>;
  onNativeTheme(cb: (dark: boolean) => void): () => void;
  getNativeTheme(): Promise<boolean>;
  windowControl(action: 'minimize' | 'maximize' | 'close'): void;
  /** Opens Terminal.app running a command (used for provider login flows). */
  openTerminal(command: string): Promise<void>;
  openSystemSettings(pane: 'accessibility' | 'screen_recording' | 'input_monitoring' | 'microphone'): Promise<void>;
  /** Asks the OS to let AppuBot use the microphone (macOS prompts once); elsewhere 'unknown' and the browser's own prompt applies. */
  requestMicrophone(): Promise<'granted' | 'denied' | 'unknown'>;
  /** Whether macOS lets AppuBot use the microphone, without asking ('not-asked' until it has); elsewhere 'unknown'. */
  microphoneAccess(): Promise<'granted' | 'denied' | 'not-asked' | 'unknown'>;
  /** This Mac's name as Finder shows it ("Sarthak’s MacBook Pro"), read again on every ask. Optional: a preload from before. */
  computerName?(): Promise<string>;
  /** Whether the person is at this Mac: the window in front, or the keyboard or mouse used lately with the screen unlocked. Optional: a preload from before. */
  atComputer?(): Promise<boolean>;
  /**
   * The person just typed or clicked in the window: an update waiting to install doesn't restart AppuBot under them.
   * The Mac's own gateway only hears of work done on this Mac, so with an AppuBot computer on screen nothing else
   * says the app is in use.
   */
  usedApp?(): void;
  relaunch(): void;
  /** Main asks before quitting (`working`: bots mid-turn). Ack at once if the dialog can show, then answer. */
  onQuitRequest(cb: (req: { id: number; working: number }) => void): () => void;
  /** Main stopped waiting for that request (no ack in time, the window hung, or the app is stopping): drop its dialog. */
  onQuitCancel(cb: (id: number) => void): () => void;
  quitAck(id: number): void;
  answerQuit(id: number, ok: boolean): void;
  /** The menu bar's call bar (`?view=voicebar`): its content size, so the window fits it with its bottom edge kept. */
  voiceBarSize(size: { width: number; height: number }): void;
  /** Clicks go through the call bar's window to what's behind it (around the bar), or are taken again. */
  voiceBarIgnore(ignore: boolean): void;
  voiceBarClose(): void;
  /** The menu bar's "End call": hang up (the page then closes its window). */
  onVoiceBarEnd(cb: () => void): () => void;
  /** Brings the main window forward. */
  showApp(): void;
  /** The main window: a menu bar call opened, so voice mode here ends (one conversation at a time). */
  onEndVoice(cb: () => void): () => void;
  /** the menu bar menu opens a place in the window: Settings, the support chat or a bot */
  onNavigate(cb: (to: { to: 'settings' | 'bot'; id?: string }) => void): () => void;
  /**
   * A Composio sign-in the window started for the cloud computer came back to `appubot://apps/signed-in` (main checked
   * the link): hand it to the cloud with `apps.finishSignIn`.
   */
  onAppsSignedIn(cb: (back: { code?: string; state?: string; error?: string }) => void): () => void;
  /** The main window's voice mode started: an open menu bar call hangs up through its own end path. */
  endVoiceBar(): void;
}
declare global { interface Window { appubot: AppuBotDesktopApi } }
export {};
