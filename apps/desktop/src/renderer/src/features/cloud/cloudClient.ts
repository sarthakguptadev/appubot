/**
 * The window's second gateway client: the user's AppuBot Cloud computer, reached over AppuBot Connect's end-to-end
 * channel straight to its public port (`wss://<slug>.agent37.app/secure`, client `directSession` with the key pinned
 * at pairing; WebCrypto's AES-GCM does the sealing in the renderer). Plan §4.4, §5.7, §5.8.
 *
 * The person may have several cloud computers: their own and one per team they're on (Work plans). One is connected at
 * a time: `switchComputer('cloud', team)` picks which (`team` absent: their own), and a switch to another one drops the
 * previous client first.
 *
 * The computer switcher swaps what the window shows: `switchComputer('cloud')` makes this client the one `gateway()` /
 * `rpc()` talk to and refills the store from its hello; going back reconnects the Mac's own client for a fresh hello
 * (while the cloud was on screen the Mac's events were left out, so its snapshot is stale). One roster at a time.
 *
 * Hours: an open connection keeps the cloud awake, so it is open only while the person is there (`cloudHold.ts`): the
 * window in front with the cloud on screen holds it (until `AWAY_MS` without a click or key: a Mac left on), the
 * window visible behind another app for `IDLE_CLOSE_MS` after the last look, a hidden window closes it at once
 * (§5.8 item 4, revised 2026-11-06: a computer in use never sleeps, and the app in front is in use). A closed socket
 * opens again, waking the computer, at the next look. Files and uploads go through the channel too: never a URL with
 * the device token on it.
 */
import { create } from 'zustand';
import { CLOUD_READY_TIMEOUT_MS, GatewayClient, cloudDirectUrl, directSession, pathOfUrl, relayFetch, uploadStream, type BodySource, type ConnectionState, type RelaySession } from '@appubot/client';
import { PRESENCE_EVERY_MS, fromBase64Url, safeGatewayPath, setChannelCipher, webCryptoChannelCipher, type FileAttachment, type Snapshot } from '@appubot/protocol';
import { GatewayError, activeComputer, cloudGateway, errorMessage, localGateway, setActiveComputer, setCloudGateway, type ComputerId, type GatewayLike } from '../../lib/gateway';
import { applyEvent } from '../../lib/events';
import { native } from '../../lib/native';
import { MACHINE } from '../../lib/platform';
import { macName } from '../../lib/macName';
import { getState, isVoiceBarView, pushToast, setState, ui, useStore, type AppState } from '../../lib/store';
import type { CloudConnection } from '@appubot/protocol';
import { cloudConnection, loadCloud, pairCloud, useCloud } from './cloudAccount';
import { canWork, cloudPhase, teamAsView } from './cloudView';
import { forgetCommands } from '../chat/threadCommands';
import { IDLE_CLOSE_MS, holdLeftMs, holdsCloud } from './cloudHold';
import { cloudCacheKey, launchComputer, lostCloudCaches, savedCloudComputer, workingClouds } from '@appubot/chat-core';
import { cloudOnlyNow } from './cloudOnly';
import { keepInMemory, restoreComputer, serializeComputer, type RestoredComputer } from './cloudCacheData';
import { cloudWelcomedKeys, markCloudWelcomed } from './CloudWelcome';
import { dropSendsFor, failWaiting, hasPending, pumpOutbox, restoreSends, sendsFor, setOutboxLink, useCloudOutbox } from './cloudOutbox';

export { IDLE_CLOSE_MS };

export interface CloudLink {
  /** the computer on screen */
  computer: ComputerId;
  /** the cloud client's connection (while the cloud is on screen, `useStore.conn` mirrors it too) */
  conn: ConnectionState | 'idle';
  error?: string;
  /** the cloud's hello came since it was put on screen: its bots are in the store */
  ready: boolean;
  /** switching (pairing, reading the connection) */
  switching: boolean;
  /** which cloud computer the cloud client is (or was last) for: a team's id, absent for the person's own */
  team?: string;
  /** what is on screen is the computer's saved copy (cloudCacheData.ts) until its hello lands (`ready`) */
  cached: boolean;
  /** when that copy was saved */
  cachedAt?: number;
  /** at launch only: the window is still being put on the cloud computer it opens on, so nothing of this one shows meanwhile */
  placing: boolean;
}

/** which computer was on screen last (`local`, `cloud`, `cloud:<team>`): the next launch opens on it, as the phone does */
const LAST_COMPUTER_KEY = 'appubot:lastComputer';
/** kept while the last launch ended on a cloud computer: the next one will too, whichever computer was on screen last */
const LAUNCHED_ON_CLOUD_KEY = 'appubot:launchedOnCloud';

/** Whether this launch will most likely end on a cloud computer: the splash then stays up until it has (`placing`). */
function expectsCloudAtLaunch(): boolean {
  if (isVoiceBarView()) return false;
  try { return !!savedCloudComputer(localStorage.getItem(LAST_COMPUTER_KEY)) || localStorage.getItem(LAUNCHED_ON_CLOUD_KEY) === '1'; } catch { return false; }
}

export const useCloudLink = create<CloudLink>()(() => ({ computer: 'local', conn: 'idle', ready: false, switching: false, cached: false, placing: expectsCloudAtLaunch() }));

/** what each computer had open, so switching back lands where you were (keyed `local`, `cloud`, `cloud:<team>`) */
type Place = Pick<AppState, 'selectedBotId' | 'threadPick'>;
const places: Partial<Record<string, Place>> = {};
const placeKey = (id: ComputerId, team?: string): string => (id === 'local' ? 'local' : team ? `cloud:${team}` : 'cloud');

/** the slices that belong to one computer: emptied on a switch, refilled by its hello */
const EMPTY_COMPUTER: Partial<AppState> = {
  bots: [], threads: [], providers: [], devices: [], computer: null, skills: [], routines: [], channels: [], system: null,
  pendingPermissions: [], pairing: null, teach: null, files: [], apps: null, voice: null, characters: [], charactersSupported: false,
  frame: null, actionFrames: [], actions: [], lastAction: null, convo: {}, convoLru: [], remembered: {},
  selectedThreadId: null, voiceMode: null,
  // a computer's groups are its own: left in the store they showed on the next computer, with none of their bots
  // groups are assumed until the computer's hello says it has none (an older one), so the + offers New group at once
  groups: [], groupsSupported: true, groupMessages: {}, groupLoaded: {}, selectedGroupId: null,
};

/* ---------- files through the channel ---------- */

/** blob: URLs of cloud files fetched so far (by path), and a counter components re-render on */
const blobs = new Map<string, string | 'loading' | 'error'>();
export const useCloudFiles = create<{ rev: number }>()(() => ({ rev: 0 }));

function cloudFileUrl(path: string, fetchImpl: typeof fetch, token: string): string {
  const safe = safeGatewayPath(path);
  if (!safe) return '';
  const have = blobs.get(safe);
  if (have && have !== 'loading' && have !== 'error') return have;
  if (!have) {
    blobs.set(safe, 'loading');
    void fetchImpl(safe, { headers: { authorization: `Bearer ${token}` } })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        blobs.set(safe, URL.createObjectURL(await r.blob()));
      })
      .catch((e: unknown) => { blobs.set(safe, 'error'); console.warn('[cloud] file', safe, errorMessage(e)); })
      .finally(() => useCloudFiles.setState((s) => ({ rev: s.rev + 1 })));
  }
  return '';
}

function dropBlobs(): void {
  for (const v of blobs.values()) if (v.startsWith('blob:')) URL.revokeObjectURL(v);
  blobs.clear();
}

/* ---------- the client ---------- */

let made: { info: CloudConnection; client: GatewayLike; offs: (() => void)[]; fetch: typeof fetch | null } | null = null;
let cipherSet = false;
/** the dev mock's stand-in for the cloud computer (VITE_APPUBOT_MOCK) */
let factory: ((info: CloudConnection) => GatewayLike) | null = null;
export function setCloudClientFactory(fn: ((info: CloudConnection) => GatewayLike) | null): void { factory = fn; }

/** each real cloud client's fetch through its channel (the dev mock has none) */
const fetches = new WeakMap<GatewayLike, typeof fetch>();

/** a Blob's bytes for `uploadStream`, a megabyte at a time */
const BLOB_PIECE = 1024 * 1024;
export function blobPieces(blob: Blob): BodySource {
  let at = 0;
  return {
    read: async () => {
      if (at >= blob.size) return null;
      const piece = new Uint8Array(await blob.slice(at, at + BLOB_PIECE).arrayBuffer());
      at += piece.length;
      return piece;
    },
  };
}

/** The cloud's GatewayLike: GatewayClient over the channel, with files and uploads through it too. */
function makeClient(info: CloudConnection): GatewayLike {
  if (!cipherSet) {
    // AES-GCM through WebCrypto (native speed); the renderer has no node:crypto
    const c = webCryptoChannelCipher();
    if (c) setChannelCipher(c);
    cipherSet = true;
  }
  const macKey = fromBase64Url(info.key);
  if (!macKey || macKey.length !== 32) throw new Error('Your AppuBot computer’s key is missing. Sign out and in again in Settings › Account.');
  const url = cloudDirectUrl(info.publicUrl);
  const session = (): RelaySession => directSession({ url, macKey, cloud: true });
  const fetchImpl = relayFetch(session);
  const client = new GatewayClient({
    baseUrl: info.publicUrl,
    token: info.token,
    device: { id: info.deviceId, name: macName(), platform: 'desktop', appVersion: native().version },
    // a sleeping computer is woken by the connection itself: its first answer may take minutes
    connectTimeoutMs: CLOUD_READY_TIMEOUT_MS + 10_000,
    callTimeoutMs: 60_000,
    openSocket: (u) => session().openSocket(pathOfUrl(u)),
    log: (...args: unknown[]) => console.warn('[cloud]', ...args),
  });
  fetches.set(client, fetchImpl);
  return Object.assign(client, {
    fileUrl: (file: Pick<FileAttachment, 'url'> | string): string => {
      const raw = typeof file === 'string' ? file : file.url;
      return /^(data:|blob:|https?:)/.test(raw) ? raw : cloudFileUrl(raw, fetchImpl, info.token);
    },
    // the bytes themselves, read from the Blob a piece at a time as the channel takes them (a bot's bundle in a transfer
    // runs to hundreds of MB: never copied whole into a second and third buffer here)
    upload: async (file: Blob, name: string): Promise<FileAttachment> => uploadStream(session(), info.token, { name, type: file.type, pieces: blobPieces(file) }),
  });
}

/** this Mac is paired with that cloud computer already (the person's own, or a team's) */
function pairedWith(team?: string): boolean {
  const v = useCloud.getState().view;
  return team ? !!v?.teams?.find((t) => t.team.id === team)?.paired : !!v?.paired;
}

/** Drops the made client (another cloud computer is wanted, or none). */
function dropClient(): void {
  if (!made) return;
  stopPresence();
  made.offs.forEach((f) => f());
  made.client.close();
  made = null;
  dropBlobs();
  forgetCommands();
  setCloudGateway(null);
}

/** The client for one cloud computer, made (pairing this Mac first when it isn't yet) on first use. */
/** a failure the person has already been told about another way (a dialog is open): no toast on top of it */
class SaidAlready extends Error {}

async function ensureClient(team?: string): Promise<GatewayLike> {
  if (made && (made.info.team ?? undefined) === team) return made.client;
  if (made) dropClient();
  let info = await cloudConnection(team).catch(() => null);
  if (!info && !pairedWith(team)) {
    const paired = await pairCloud(team);
    if (paired === 'full') throw new SaidAlready(`Remove a device from ${team ? 'your team’s' : 'your'} AppuBot computer to connect this ${MACHINE}.`);
    if (!paired) throw new Error(team ? `This ${MACHINE} couldn’t connect to your team’s AppuBot computer.` : `This ${MACHINE} couldn’t connect to your AppuBot computer.`);
    info = await cloudConnection(team).catch(() => null);
  }
  if (!info) throw new Error('Your AppuBot computer isn’t ready to connect yet.');
  const client = factory ? factory(info) : makeClient(info);
  const offs = [
    client.onAny((event, payload) => {
      if (activeComputer() !== 'cloud') return;
      const hello = (event as string) === 'hello';
      if (hello) {
        useCloudLink.setState({ ready: true, error: undefined });
        // what was loaded from the copy (or before a drop) asks for its newest page again
        setState((st) => ({ convo: Object.fromEntries(Object.entries(st.convo).map(([k, v]) => [k, v.loaded ? { ...v, loaded: false, loading: false } : v])) }));
      }
      applyEvent(event, payload);
      // messages waiting for the computer go now
      if (hello) pumpOutbox();
    }),
    client.onState((state, err) => {
      const was = useCloudLink.getState().conn;
      useCloudLink.setState({ conn: state, error: err });
      if (activeComputer() === 'cloud') setState({ conn: state, connError: err });
      // a computer that refuses this Mac (or speaks another version) takes nothing: what waits shows "Not sent"
      if (state === 'unauthorized' || state === 'incompatible') failWaiting(err ?? 'Your AppuBot computer refused this message.');
      // a computer coming up reads as waking in Settings and the switcher meanwhile: once it answers, its state is read
      // again (a few seconds' old view will do); a drop asks only for a view over a minute old, so a socket retrying
      // doesn't read the backend on every try
      if (state === 'connected') startPresence(client); else stopPresence();
      if (state === 'connected' && was !== 'connected') void loadCloud(true);
      else if (state === 'closed' && was === 'connected' && !selfClosed) void loadCloud();
      if (state === 'closed') selfClosed = false;
    }),
  ];
  made = { info: { ...info, ...(team ? { team } : {}) }, client, offs, fetch: fetches.get(client) ?? null };
  setCloudGateway(client);
  return client;
}

/* ---------- presence: the person's phones stay quiet while they're at this Mac ---------- */

let presenceTimer: ReturnType<typeof setInterval> | null = null;
let presenceClient: GatewayLike | null = null;

/** at this Mac: main's word (window in front, or the keyboard or mouse used lately, unlocked); an older main, the window's focus */
async function atThisMac(): Promise<boolean> {
  const ask = native().atComputer;
  if (ask) return ask().catch(() => false);
  return document.visibilityState !== 'hidden' && (typeof document.hasFocus !== 'function' || document.hasFocus());
}

/**
 * Tells the cloud computer whether its person is at this Mac (`devices.presence {desk}`): while they are, it pushes
 * nothing to their phones, as a Mac running the bots doesn't. Said on connecting, every PRESENCE_EVERY_MS and when the
 * window gains or loses focus; a computer from before ignores it (an unknown key is dropped, an unknown method refused).
 */
function sayPresence(): void {
  const client = presenceClient;
  if (!client) return;
  void atThisMac().then((at) => {
    if (presenceClient !== client || client.state !== 'connected') return;
    client.call('devices.presence', { foreground: at, desk: true }).catch(() => undefined);
  });
}

function startPresence(client: GatewayLike): void {
  presenceClient = client;
  sayPresence();
  presenceTimer ??= setInterval(sayPresence, PRESENCE_EVERY_MS);
}

function stopPresence(): void {
  presenceClient = null;
  if (presenceTimer) clearInterval(presenceTimer);
  presenceTimer = null;
}

/** the cloud's socket is being reopened by this window for a fresh hello (not a drop worth reading the account for) */
let selfClosed = false;

/**
 * Closes the cloud's socket (it stays made, to open again on the next look); its computer may sleep. Not while a
 * message is still on its way there (the person sent it: it goes first, then the hold applies).
 */
function closeCloud(): void {
  const key = made ? cloudCacheKey(made.info.team) : null;
  if (hasPending(useCloudOutbox.getState().sends, key)) { scheduleCheck(); return; }
  if (made && made.client.state !== 'idle' && made.client.state !== 'closed') made.client.close();
}

/** Forgets the cloud client entirely (signed out, computer deleted): back on this Mac. */
export function forgetCloud(): void {
  if (activeComputer() === 'cloud') void switchComputer('local');
  // signed out (or the computer deleted): nothing of the cloud computers stays in this window
  copies.clear();
  dropSendsFor(null);
  if (!made) return;
  dropClient();
  useCloudLink.setState({ conn: 'idle', ready: false, error: undefined, team: undefined });
}

/** A team's computer is gone for this person (they left or were removed): back on this Mac if it was on screen. */
export function forgetTeamCloud(team: string): void {
  const key = cloudCacheKey(team);
  copies.delete(key);
  dropSendsFor(key);
  if (made?.info.team !== team) return;
  forgetCloud();
  // only in the cloud: on to another cloud computer that can work, rather than this Mac
  const next = cloudOnlyNow();
  const other = next.inEffect ? next.usable.find((u) => u.team !== team) : undefined;
  if (other) void switchComputer('cloud', other.team);
}

/**
 * Swaps the store's computer slices: this one's place is kept (and its copy: this Mac's in memory, a cloud computer's
 * saved), the other's comes back at once from its copy (`copy`) when there is one, else once its hello lands.
 */
function swapPlace(from: string, to: string, copy?: RestoredComputer | null): void {
  const s = getState();
  places[from] = { selectedBotId: s.selectedBotId, threadPick: s.threadPick };
  if (from === 'local') localCopy = keepInMemory(s);
  else saveCopyNow();
  const back = places[to];
  const restored: Partial<AppState> = to === 'local' ? (localCopy ?? {}) : (copy?.state ?? {});
  setState({
    ...EMPTY_COMPUTER, ...restored,
    // where you were here this run wins over the saved copy's place
    selectedBotId: back?.selectedBotId ?? restored.selectedBotId ?? null, threadPick: back?.threadPick ?? restored.threadPick ?? {},
    selectedThreadId: null, settingsSection: s.settingsSection, appsOpen: false, supportOpen: s.supportOpen,
  });
  ui.syncSelection();
}

/* ---------- saved copies (cloudCacheData.ts; on disk through this Mac's core, services/cloudCache.ts) ---------- */

/** this Mac's slices while a cloud computer is on screen (memory only: its hello is a local round trip away) */
let localCopy: Partial<AppState> | null = null;
/** each cloud computer's latest copy this run (by `cloudCacheKey`), so a switch back never waits for the disk */
const copies = new Map<string, string>();
/** this Mac's core predates saved copies (`unknown_method`): memory only for this run */
let diskless = false;

/** the saved-copy key of the cloud computer on screen (null while this Mac is) */
function screenKey(): string | null {
  const l = useCloudLink.getState();
  return l.computer === 'cloud' && activeComputer() === 'cloud' ? cloudCacheKey(l.team) : null;
}

/** A cloud computer's copy: this run's, else the one on disk. Never calls the backend or the computer. */
async function readCopy(team?: string): Promise<RestoredComputer | null> {
  const key = cloudCacheKey(team);
  let json = copies.get(key) ?? null;
  if (!json && !diskless) {
    try {
      json = (await localGateway().call('cloudAccount.cacheGet', team ? { team } : {}, { timeoutMs: 5000 }))?.data ?? null;
    } catch (e) {
      if (e instanceof GatewayError && e.code === 'unknown_method') diskless = true;
      else console.warn('[cloud] reading the saved copy failed', errorMessage(e));
    }
  }
  return json ? restoreComputer(json) : null;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let firstPending = 0;
/** written this long after the last change, or at most this long after the first while changes keep coming */
const SAVE_QUIET_MS = 2000;
const SAVE_MAX_WAIT_MS = 10_000;

/** Write the on-screen cloud computer's copy now (a switch away, the window hiding), if it holds a good one. */
function saveCopyNow(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  firstPending = 0;
  const key = screenKey();
  const link = useCloudLink.getState();
  // only a whole picture: the computer's hello this time, or the copy it started from; never a half-filled store
  if (!key || (!link.ready && !link.cached)) return;
  const json = serializeComputer(getState(), sendsFor(key));
  copies.set(key, json);
  if (diskless) return;
  const team = link.team;
  void localGateway().call('cloudAccount.cacheSet', { ...(team ? { team } : {}), data: json }, { timeoutMs: 15_000 }).catch((e: unknown) => {
    if (e instanceof GatewayError && e.code === 'unknown_method') diskless = true;
    else console.warn('[cloud] saving the copy failed', errorMessage(e));
  });
}

/** A change on screen worth keeping: written once things are quiet, or within SAVE_MAX_WAIT_MS while a reply streams. */
function saveSoon(): void {
  const now = Date.now();
  if (!firstPending) firstPending = now;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(saveCopyNow, Math.max(0, Math.min(SAVE_QUIET_MS, firstPending + SAVE_MAX_WAIT_MS - now)));
}

/** Forget the copies of computers that aren't the person's any more (memory; the core drops the files itself). */
function pruneCopies(view: ReturnType<typeof useCloud.getState>['view']): void {
  if (!view) return;
  const keys = [...new Set([...copies.keys(), ...Object.values(useCloudOutbox.getState().sends).map((q) => q.key)])];
  const gone = lostCloudCaches({
    signedIn: view.signedIn, read: !!view.readAt && !view.error,
    accountStatus: view.account?.status ?? null, ownState: view.computer?.state ?? null,
    teams: view.teams ? view.teams.map((t) => ({ id: t.team.id, state: t.computer?.state ?? null })) : null,
  }, keys);
  for (const key of gone) { copies.delete(key); dropSendsFor(key); }
}

/** Keeps the on-screen cloud computer's copy saved as it changes, and drops lost computers' copies. Mount once. */
export function watchCloudCopies(): () => void {
  const watched = (st: AppState) => [st.bots, st.threads, st.convo, st.routines, st.skills, st.channels, st.providers, st.settings, st.system, st.devices, st.files, st.characters, st.voice, st.limits, st.selectedBotId, st.threadPick];
  let prev = watched(getState());
  const offStore = useStore.subscribe((st) => {
    const next = watched(st);
    if (next.every((v, i) => v === prev[i])) return;
    prev = next;
    if (screenKey()) saveSoon();
  });
  const offSends = useCloudOutbox.subscribe((st, before) => { if (st.sends !== before.sends && screenKey()) saveSoon(); });
  const offView = useCloud.subscribe((st, before) => { if (st.view !== before.view) pruneCopies(st.view); });
  // (the window hiding writes it at once: watchCloudVisibility)
  return () => { offStore(); offSends(); offView(); };
}

setOutboxLink({
  onScreen: screenKey,
  ready: () => {
    const l = useCloudLink.getState();
    return screenKey() && l.ready && made && made.client.state === 'connected' ? made.client : null;
  },
  wake: () => { lookedNow(); reopenIfOnScreen(); },
});

/**
 * Shows this Mac's bots or the cloud's. The cloud's client connects (waking the computer) and its hello refills the
 * store; this Mac's reconnects for a fresh hello.
 */
export async function switchComputer(to: ComputerId, team?: string): Promise<void> {
  const from = activeComputer();
  const fromTeam = useCloudLink.getState().team;
  const fromKey = placeKey(from, fromTeam);
  if (to === from && (to === 'local' || fromTeam === team)) {
    // Try again on a cloud that didn't answer
    if (to === 'cloud' && made && (made.client.state === 'closed' || made.client.state === 'idle' || made.client.state === 'incompatible')) {
      useCloudLink.setState({ error: undefined });
      lookedNow();
      made.client.connect();
    }
    return;
  }
  if (useCloudLink.getState().switching) return;
  if (to === 'cloud') {
    // the account as the Mac read it (read now when it hasn't yet: a switch right after launch)
    const view = useCloud.getState().view ?? await loadCloud();
    const teamView = team && view ? view.teams?.find((t) => t.team.id === team) : undefined;
    const phase = cloudPhase(team && view && teamView ? teamAsView(view, teamView) : team ? null : view);
    if (!canWork(phase) && phase !== 'on-hold') {
      // export-only, suspended, being set up: Settings › Account says what to do
      setState({ settingsSection: 'account', settingsTarget: null });
      return;
    }
    useCloudLink.setState({ switching: true, error: undefined });
    // from another cloud computer: its copy is saved before its client goes
    if (from === 'cloud') saveCopyNow();
    let client: GatewayLike;
    let copy: RestoredComputer | null;
    try {
      // the saved copy is read on this Mac alone (never the backend or the computer) beside making the client (a
      // local read too once paired), so both are here in a few milliseconds
      [client, copy] = await Promise.all([ensureClient(team), readCopy(team)]);
    } catch (e) {
      useCloudLink.setState({ switching: false });
      if (e instanceof SaidAlready) return;
      pushToast({ title: team ? 'Couldn’t open your team’s AppuBot computer' : 'Couldn’t open your AppuBot computer', body: errorMessage(e), level: 'error' });
      return;
    }
    swapPlace(fromKey, placeKey('cloud', team), copy);
    setActiveComputer('cloud');
    rememberComputer(placeKey('cloud', team));
    useCloudLink.setState({ computer: 'cloud', team, switching: false, ready: false, conn: client.state, cached: !!copy, cachedAt: copy?.savedAt });
    setState({ conn: client.state === 'idle' || client.state === 'closed' ? 'connecting' : client.state });
    // the first time this computer is on screen here: what it is, so a fresh one doesn't read as the app reset
    const welcomeKey = cloudCacheKey(team);
    if (!cloudWelcomedKeys().includes(welcomeKey)) {
      markCloudWelcomed(welcomeKey);
      ui.openModal({ kind: 'cloud-welcome', ...(team && teamView ? { teamName: teamView.team.name } : {}) });
    }
    // what was on its way there: from the copy, and what this run still holds for it
    const live = sendsFor(cloudCacheKey(team));
    restoreSends([...(copy?.outbox ?? []).filter((q) => !live.some((l) => l.localId === q.localId)), ...live]);
    lookedNow();
    if (client.state === 'connected' && copy) {
      // already open (within the idle window), but its events were left out while away: a fresh hello over the copy
      selfClosed = true;
      client.close();
      client.connect();
    } else if (client.state === 'idle' || client.state === 'closed') {
      client.connect();
    } else if (client.snapshot) {
      // already open with no copy to show: what it said, a reconnect brings it up to date
      useCloudLink.setState({ ready: true });
      applyEvent('hello', client.snapshot as Snapshot);
    }
    return;
  }
  // back to this Mac: its events were left out while the cloud was on screen, so a reconnect brings a fresh hello.
  // It starts while the cloud is still the active one, so its brief "closed" never reads as this Mac going away.
  const local = localGateway();
  local.close();
  local.connect();
  swapPlace(fromKey, 'local');
  setActiveComputer('local');
  rememberComputer('local');
  useCloudLink.setState({ computer: 'local', ready: false, cached: false, cachedAt: undefined });
  scheduleClose();
  setState({ conn: local.state, connError: undefined });
}

/* ---------- open only while the person is there (plan §5.8 item 4, `cloudHold.ts`) ---------- */

let closeTimer: ReturnType<typeof setTimeout> | null = null;
/** when the person last looked at the cloud (`lookedNow`) */
let lastLookAt = 0;

/** the window as the hold rules see it (tests and the mock have no focus: a document without `hasFocus` counts as in front) */
function holdState(): { visible: boolean; focused: boolean; sinceLookMs: number } {
  return { visible: document.visibilityState !== 'hidden', focused: typeof document.hasFocus === 'function' ? document.hasFocus() : true, sinceLookMs: Date.now() - lastLookAt };
}

/** Looks again when the hold would run out as things stand: closes the socket then, or waits on. */
function scheduleCheck(): void {
  if (closeTimer) clearTimeout(closeTimer);
  closeTimer = setTimeout(() => {
    closeTimer = null;
    if (holdsCloud(holdState())) scheduleCheck();
    else closeCloud();
  }, Math.max(1000, holdLeftMs(holdState())));
}

/**
 * The user looked at the cloud (it came on screen, they clicked or typed while it was there, the window came to the
 * front or they left it): the hold counts from here (`holdsCloud`), so a window in front keeps the computer
 * connected and an app left behind lets it sleep after IDLE_CLOSE_MS.
 */
function lookedNow(): void {
  lastLookAt = Date.now();
  scheduleCheck();
}
const scheduleClose = lookedNow;

/** Opens the cloud's socket again after an idle close, when it is on screen. */
function reopenIfOnScreen(): void {
  if (activeComputer() === 'cloud' && made && (made.client.state === 'closed' || made.client.state === 'idle')) made.client.connect();
}

/**
 * Keeps the cloud's connection to what the user sees: a hidden window closes it at once; coming back to the cloud
 * (visible again, in front again, a click, a key) opens it; in front it stays (until AWAY_MS untouched), behind
 * another app it closes IDLE_CLOSE_MS after the last look. Mount once (MainLayout).
 */
export function watchCloudVisibility(): () => void {
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') { if (closeTimer) clearTimeout(closeTimer); closeTimer = null; saveCopyNow(); closeCloud(); return; }
    if (activeComputer() === 'cloud') { lookedNow(); reopenIfOnScreen(); }
  };
  // the window going away (quit, the updater's restart, a reload): what changed in the last moments is written now, so
  // the next launch shows it (a save still waiting its quiet two seconds would be lost)
  const onLeave = () => saveCopyNow();
  // the window coming to the front is a look (and opens a closed socket); leaving it starts the IDLE_CLOSE_MS clock
  const onFocus = () => { sayPresence(); if (activeComputer() === 'cloud') { lookedNow(); reopenIfOnScreen(); } };
  const onBlur = () => { sayPresence(); if (activeComputer() === 'cloud') lookedNow(); };
  let lastPoke = 0;
  const onInput = () => {
    if (activeComputer() !== 'cloud') return;
    const now = Date.now();
    if (now - lastPoke < 10_000) return;
    lastPoke = now;
    lookedNow();
    reopenIfOnScreen();
  };
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', onLeave);
  window.addEventListener('focus', onFocus);
  window.addEventListener('blur', onBlur);
  window.addEventListener('pointerdown', onInput, true);
  window.addEventListener('keydown', onInput, true);
  return () => {
    document.removeEventListener('visibilitychange', onVisibility); window.removeEventListener('pagehide', onLeave);
    window.removeEventListener('focus', onFocus);
    window.removeEventListener('blur', onBlur);
    window.removeEventListener('pointerdown', onInput, true);
    window.removeEventListener('keydown', onInput, true);
  };
}

/* ---------- Download my bots ---------- */

/** Waits for the cloud's client to say hello (it may be waking), opening it if it is closed. */
async function connected(client: GatewayLike, timeoutMs = CLOUD_READY_TIMEOUT_MS + 10_000): Promise<void> {
  if (client.state === 'connected') return;
  if (client.state === 'idle' || client.state === 'closed') client.connect();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error('Your AppuBot computer didn’t wake up in time. Try again in a minute.')); }, timeoutMs);
    const off = client.onState((st, err) => {
      if (st === 'connected') { clearTimeout(timer); off(); resolve(); }
      else if (st === 'unauthorized' || st === 'incompatible') { clearTimeout(timer); off(); reject(new Error(err ?? `Your AppuBot computer refused this ${MACHINE}. Sign out and in again.`)); }
    });
  });
}

export interface ExportProgress { step: 'waking' | 'packing' | 'downloading' | 'done'; name?: string; size?: number }

/**
 * "Download my bots": the cloud computer zips `~/AppuBot` and its store (secrets left out, `cloud.export`), then the
 * zip comes back through the channel and is saved where the user picks (the browser engine's download).
 */
export async function downloadCloudBots(onProgress: (p: ExportProgress) => void, team?: string): Promise<void> {
  const client = await ensureClient(team);
  onProgress({ step: 'waking' });
  await connected(client);
  lookedNow();
  onProgress({ step: 'packing' });
  const zip = await client.call('cloud.export', {}, { timeoutMs: 10 * 60_000 });
  onProgress({ step: 'downloading', name: zip.name, size: zip.size });
  const path = `/files/${encodeURIComponent(zip.fileId)}?download=1`;
  let blob: Blob;
  const viaChannel = made?.fetch;
  if (viaChannel) {
    const r = await viaChannel(path, { headers: { authorization: `Bearer ${made!.info.token}` } });
    if (!r.ok) throw new Error(`The download failed (${r.status}).`);
    blob = await r.blob();
  } else {
    blob = new Blob([`AppuBot export (preview): ${zip.name}`], { type: 'application/zip' });
  }
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = zip.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 60_000);
  onProgress({ step: 'done', name: zip.name, size: zip.size });
}

/** The cloud client if made (for the agents' sign-in, which listens to its events). */
export function cloudClientIfAny(): GatewayLike | null { return cloudGateway(); }

/* ---------- the computer used last ---------- */

function rememberComputer(key: string): void {
  try { localStorage.setItem(LAST_COMPUTER_KEY, key); } catch { /* no storage */ }
}

/** The cloud computer to open at launch, if the one used last was one: `{}` the person's own, `{team}` a team's. */
export function lastCloudComputer(saved: string | null): { team?: string } | null {
  return savedCloudComputer(saved);
}

let reopened = false;
/** how long a launch waits behind the splash for its cloud computer: past it this computer shows, and the cloud one when it comes */
const LAUNCH_WAIT_MS = 4000;

/**
 * Once per launch: onto a cloud computer whenever the person has one that can work, whichever computer was on screen
 * when AppuBot was last used (chat-core `launchComputer`: the cloud computer used last, else their own before a
 * team's). A plan that ended, a sign-out or a team left: this computer stays on screen. The account is this Mac's
 * own copy of it, which the window reads at start anyway. A launch expected to end on a cloud computer keeps the
 * splash up until it has (`placing`), so this computer's bots never show for a moment first.
 */
export async function reopenLastComputer(): Promise<void> {
  if (reopened) return;
  reopened = true;
  const giveUp = setTimeout(() => useCloudLink.setState({ placing: false }), LAUNCH_WAIT_MS);
  try {
    await openLaunchComputer();
  } finally {
    clearTimeout(giveUp);
    useCloudLink.setState({ placing: false });
    try {
      if (activeComputer() === 'cloud') localStorage.setItem(LAUNCHED_ON_CLOUD_KEY, '1'); else localStorage.removeItem(LAUNCHED_ON_CLOUD_KEY);
    } catch { /* no storage */ }
  }
}

async function openLaunchComputer(): Promise<void> {
  let saved: string | null = null;
  try { saved = localStorage.getItem(LAST_COMPUTER_KEY); } catch { /* no storage */ }
  if (activeComputer() !== 'local') return;
  const view = useCloud.getState().view ?? await loadCloud();
  if (!view?.signedIn) return;
  const target = launchComputer(saved, { chosen: cloudOnlyNow().chosen, usable: workingClouds(view) });
  if (!target) return;
  // nothing in the way: the person hasn't gone anywhere yet in the moments this took
  if (activeComputer() !== 'local' || getState().settingsSection || getState().modal) return;
  await switchComputer('cloud', target.team);
}

/**
 * A connected client for a cloud computer (the person's own, or a team's) without putting it on screen: carrying a
 * bot over needs both computers at once. The computer wakes for it; the connection closes again after the idle
 * window like any look at the cloud.
 */
export async function cloudClientReady(team?: string): Promise<GatewayLike> {
  const client = await ensureClient(team);
  lookedNow();
  await connected(client);
  return client;
}

/** One of the cloud computer's files, as bytes through its channel (the dev mock has no channel: a stand-in). */
export async function cloudFileBlob(client: GatewayLike, file: { id: string; name: string }): Promise<Blob> {
  const viaChannel = fetches.get(client) ?? made?.fetch;
  const info = made?.info;
  if (!viaChannel || !info) return new Blob([`AppuBot bundle (preview): ${file.name}`], { type: 'application/zip' });
  const r = await viaChannel(`/files/${encodeURIComponent(file.id)}?download=1`, { headers: { authorization: `Bearer ${info.token}` } });
  if (!r.ok) throw new Error(`The download failed (${r.status}).`);
  return r.blob();
}
