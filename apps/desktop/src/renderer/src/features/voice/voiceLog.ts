// Voice mode's own log: what happened when (turns, the phrases heard, cut-ins checked and their verdicts, readings
// started, stopped and failed), so "sometimes it doesn't speak" can be told from the log afterwards. The last `KEEP`
// events stay in memory (`voiceEvents()`, also `appubotVoiceLog()` in the window's console), and each is printed as
// one `[voice] …` line, always, so a log of the window (`ELECTRON_ENABLE_LOGGING=1`) holds them. Nothing leaves the
// computer.

export interface VoiceEvent {
  /** wall clock (ms) */
  at: number;
  event: string;
  data?: Record<string, unknown>;
}

export const VOICE_LOG_KEEP = 100;
const events: VoiceEvent[] = [];

const clock = (at: number) => {
  const d = new Date(at);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
};

const show = (v: unknown): string => (typeof v === 'number' ? String(Math.round(v * 100) / 100) : typeof v === 'string' ? JSON.stringify(v) : String(v));

/** One event as a line: its time, what, and its data as key=value (strings quoted). */
export function formatVoiceEvent(e: VoiceEvent): string {
  const data = e.data ? Object.entries(e.data).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${show(v)}`) : [];
  return [clock(e.at), e.event, ...data].join(' ');
}

/** Notes an event (and prints it). */
export function voiceLog(event: string, data?: Record<string, unknown>): void {
  const e: VoiceEvent = { at: Date.now(), event, ...(data ? { data } : {}) };
  events.push(e);
  if (events.length > VOICE_LOG_KEEP) events.splice(0, events.length - VOICE_LOG_KEEP);
  console.info('[voice]', formatVoiceEvent(e));
}

/** The last events, oldest first. */
export function voiceEvents(): VoiceEvent[] {
  return events.slice();
}

if (typeof window !== 'undefined') (window as unknown as { appubotVoiceLog?: () => string[] }).appubotVoiceLog = () => events.map(formatVoiceEvent);
