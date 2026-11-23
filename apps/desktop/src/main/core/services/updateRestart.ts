/**
 * Restarting for a downloaded update by itself, and picking the work back up afterwards. Pure parts (the decision and
 * the resume file); `AppUpdateService` runs them and `ChatService.resumeAfterUpdate` does the picking up.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { compareVersions } from '@appubot/chat-core';
import type { MethodName } from '@appubot/protocol';

/** how often a downloaded update looks for a moment to restart */
export const RESTART_CHECK_MS = 30_000;
/** the user did something in AppuBot this recently (sent, answered, talked): not now */
export const USER_QUIET_MS = 2 * 60_000;
/** bots still busy this long after the download: restart anyway, their work is picked up afterwards */
export const FORCE_AFTER_MS = 6 * 3600_000;
/** an install that hasn't quit AppuBot after this long failed: the quit prompt works again and Restart to update can be retried */
export const INSTALL_GIVE_UP_MS = 15_000;
/** a resume file older than this is stale (the update never happened, or AppuBot stayed closed) */
export const RESUME_MAX_AGE_MS = 24 * 3600_000;

/**
 * Calls that mean someone is using AppuBot right now: writing, answering, reacting, a voice conversation (voice mode
 * calls `voice.warm` every 20 s while it's open, so it counts as long as it lasts).
 */
export const ACTIVITY_METHODS: ReadonlySet<MethodName> = new Set<MethodName>([
  'chat.send', 'chat.answer', 'chat.cancel', 'chat.react', 'permissions.respond',
  'voice.transcribe', 'voice.speak', 'voice.warm',
  // a person in control of the screen through live view
  'computer.control', 'computer.liveInput',
]);

export interface RestartState {
  now: number;
  /** when the update finished downloading */
  readySince: number;
  /** the last call in `ACTIVITY_METHODS` (0: none) */
  lastActivity: number;
  /** threads with a turn running or queued (a question or approval waiting is part of a running turn) */
  busyThreads: number;
  /** a call from the menu bar is open */
  voiceCall: boolean;
  /** this version was stopped by the version policy: its turns were cancelled already, nothing waits on the user */
  required: boolean;
  /** AppuBot's window is in front and focused: the user may be writing (drafts live only in the window) */
  focused: boolean;
  /** this version's install was tried before and AppuBot is still here: it failed, so only the user restarts for it */
  triedBefore: boolean;
}

/**
 * Whether to restart for the update now. Idle: no turns, no call, the window not in use (not focused, nothing sent,
 * answered or said in the last 2 minutes). Bots still busy 6 hours after the download don't hold it back any longer
 * (their work resumes after the restart), but a call or someone using AppuBot always does. A stopped version restarts
 * as soon as nothing runs. A version whose install was already tried never restarts by itself again (no loop when
 * installing fails and the old version comes back): Restart to update still works.
 */
export function shouldRestart(s: RestartState): boolean {
  if (s.triedBefore || s.voiceCall) return false;
  if (s.required) return s.busyThreads === 0;
  if (s.focused || s.now - s.lastActivity < USER_QUIET_MS) return false;
  return s.busyThreads === 0 || s.now - s.readySince >= FORCE_AFTER_MS;
}

/** A thread whose work the restart stops. */
const ResumeThreadSchema = z.object({
  threadId: z.string(),
  /** the agent message that was streaming when AppuBot quit; absent when only queued messages waited */
  interrupted: z.string().optional(),
  /** where the interrupted turn came from (a Telegram turn's reply goes back there) */
  via: z.enum(['desktop', 'mobile', 'routine', 'channel', 'system', 'bot']).optional(),
  /** user messages already in the thread that hadn't reached the agent yet, oldest first */
  queued: z.array(z.string()).default([]),
});
export type ResumeThread = z.infer<typeof ResumeThreadSchema>;

const ResumeFileSchema = z.object({
  at: z.number(),
  from: z.string(),
  to: z.string(),
  /** the window was hidden (menu bar only): the relaunch stays hidden too */
  hidden: z.boolean().default(false),
  threads: z.array(ResumeThreadSchema).default([]),
});
export type ResumeFile = z.infer<typeof ResumeFileSchema>;

export const resumeFilePath = (dataDir: string): string => join(dataDir, 'resume-after-update.json');

export function writeResumeFile(dataDir: string, file: ResumeFile): void {
  writeFileSync(resumeFilePath(dataDir), JSON.stringify(file));
}

/**
 * What the resume file says for this version: `use` once AppuBot is the version it updated to (or a newer one),
 * `pending` while it is still the version it left (the install hasn't happened, or failed: keep it), `stale` when it
 * is too old or unreadable (remove it), `none` when there is none.
 */
export function inspectResumeFile(dataDir: string, version: string, now = Date.now()): { verdict: 'use' | 'pending' | 'stale' | 'none'; file?: ResumeFile } {
  const path = resumeFilePath(dataDir);
  if (!existsSync(path)) return { verdict: 'none' };
  try {
    const file = ResumeFileSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    if (now - file.at > RESUME_MAX_AGE_MS || now < file.at - 60_000) return { verdict: 'stale' };
    if (compareVersions(version, file.to) >= 0) return { verdict: 'use', file };
    return { verdict: compareVersions(version, file.from) > 0 ? 'use' : 'pending', file };
  } catch {
    return { verdict: 'stale' };
  }
}

/** The resume file, if this version should use it (`inspectResumeFile`). */
export function readResumeFile(dataDir: string, version: string, now = Date.now()): ResumeFile | null {
  const r = inspectResumeFile(dataDir, version, now);
  return r.verdict === 'use' ? r.file! : null;
}

export function removeResumeFile(dataDir: string): void {
  rmSync(resumeFilePath(dataDir), { force: true });
}

/** Electron main, before the window: whether the relaunch after an update should stay in the menu bar (a stale file goes). */
export function relaunchHidden(dataDir: string, version: string): boolean {
  const r = inspectResumeFile(dataDir, version);
  if (r.verdict === 'stale') removeResumeFile(dataDir);
  return r.verdict === 'use' && !!r.file?.hidden;
}

/** The last install AppuBot tried (any version), so a failed one isn't tried again by itself. */
const attemptPath = (dataDir: string): string => join(dataDir, 'update-attempt.json');

export function noteInstallAttempt(dataDir: string, version: string, at = Date.now()): void {
  writeFileSync(attemptPath(dataDir), JSON.stringify({ version, at }));
}

/** Whether installing `version` was tried already (and AppuBot, still running the old one, is evidence it failed). */
export function installTried(dataDir: string, version: string): boolean {
  try {
    const a = JSON.parse(readFileSync(attemptPath(dataDir), 'utf8')) as { version?: unknown };
    return a.version === version;
  } catch {
    return false;
  }
}

/**
 * What the bot is told when its turn was cut short by the restart (a hidden prompt: never shown as a message). Its
 * reply lands in the chat like any other.
 */
export const RESUME_PROMPT = 'AppuBot just restarted to install an update, which interrupted what you were doing in this chat. Continue where you left off. Start with one short sentence saying what you are picking up, then carry on. If the task was already done, say so briefly.';
