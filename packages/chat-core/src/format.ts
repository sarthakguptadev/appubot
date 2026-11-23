import { intlLocale } from './i18n';
export function timeAgo(ts: number | undefined, now = Date.now()): string {
  if (!ts) return '';
  const s = Math.round((now - ts) / 1000);
  if (s < 45) return 'now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(ts).toLocaleDateString(intlLocale(), { month: 'short', day: 'numeric' });
}

/** How clock times read: the system's own habit, or always 12-hour (7:28 PM) / 24-hour (19:28). */
export type ClockStyle = 'auto' | '12h' | '24h';
let clockStyle: ClockStyle = 'auto';

/** Every clock time this module writes follows it (the app sets it from its Appearance setting). */
export function setClockStyle(style: ClockStyle): void {
  clockStyle = style;
}

/** `toLocale*String` options for the clock style. */
export function clockHours(): { hourCycle?: 'h12' | 'h23' } {
  return clockStyle === '12h' ? { hourCycle: 'h12' } : clockStyle === '24h' ? { hourCycle: 'h23' } : {};
}

export function timeUntil(ts: number | undefined, now = Date.now()): string {
  if (!ts) return '-';
  const s = Math.round((ts - now) / 1000);
  if (s <= 0) return 'due';
  if (s < 60) return `in ${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `in ${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `in ${h}h`;
  return new Date(ts).toLocaleString(intlLocale(), { weekday: 'short', hour: 'numeric', minute: '2-digit', ...clockHours() });
}

export function clockTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(intlLocale(), { hour: 'numeric', minute: '2-digit', ...clockHours() });
}

/** Live clocks (Synara's formatClockDuration, MIT): floored; "12s", "1m 4s", "1m", "1h 5m", "1h", "1d 2h", "1d". */
export function formatClockDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const days = Math.floor(s / 86_400);
  const hours = Math.floor((s % 86_400) / 3_600);
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  const minutes = Math.floor((s % 3_600) / 60);
  const seconds = s % 60;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

/** Settled spans (Synara's formatDuration): "850ms", "4.2s", "23s", then the clock format, rounded. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0ms';
  if (ms < 1_000) return `${Math.max(1, Math.round(ms))}ms`;
  if (ms < 10_000) return `${(ms / 1_000).toFixed(1)}s`;
  if (ms < 60_000) return `${Math.round(ms / 1_000)}s`;
  return formatClockDuration(Math.round(ms / 1_000) * 1_000);
}

export function bytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

export function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function at(h: string, m: string): string {
  const hh = Number(h);
  const mm = Number(m);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return `${h}:${m}`;
  const d = new Date(2000, 0, 1, hh, mm);
  return d.toLocaleTimeString(intlLocale(), { hour: 'numeric', minute: '2-digit', ...clockHours() });
}

/** Human description for common cron shapes; falls back to the raw expression. */
export function cronToHuman(expr: string): string {
  const f = expr.trim().split(/\s+/);
  if (f.length === 6) f.shift(); // drop seconds
  if (f.length !== 5) return expr;
  const [min, hour, dom, mon, dow] = f as [string, string, string, string, string];
  const num = /^\d+$/;
  if (min === '*' && hour === '*' && dom === '*' && mon === '*' && dow === '*') return 'Every minute';
  const everyMin = /^\*\/(\d+)$/.exec(min);
  if (everyMin && hour === '*' && dom === '*' && mon === '*' && dow === '*') return `Every ${everyMin[1]} minutes`;
  if (num.test(min) && hour === '*' && dom === '*' && mon === '*' && dow === '*') return min === '0' ? 'Every hour' : `Every hour at :${min.padStart(2, '0')}`;
  const everyHour = /^\*\/(\d+)$/.exec(hour);
  if (num.test(min) && everyHour && dom === '*' && mon === '*' && dow === '*') return `Every ${everyHour[1]} hours`;
  if (num.test(min) && num.test(hour) && mon === '*') {
    const t = at(hour, min);
    if (dom === '*' && dow === '*') return `Every day at ${t}`;
    if (dom === '*' && (dow === '1-5' || dow === 'MON-FRI')) return `Weekdays at ${t}`;
    if (dom === '*' && (dow === '0,6' || dow === '6,0' || dow === 'SAT,SUN')) return `Weekends at ${t}`;
    if (dom === '*' && /^\d$/.test(dow)) return `Every ${DAYS[Number(dow) % 7]} at ${t}`;
    // a list of days ("1,3,5", "2-4"): "Mon, Wed and Fri at 9:00 AM"
    if (dom === '*' && /^[\d,-]+$/.test(dow)) {
      const days = new Set<number>();
      for (const part of dow.split(',')) {
        const r = /^(\d)-(\d)$/.exec(part);
        if (r) for (let d = Number(r[1]); d <= Number(r[2]); d++) days.add(d % 7);
        else if (/^\d$/.test(part)) days.add(Number(part) % 7);
      }
      const names = [...days].sort((a, b) => a - b).map((d) => DAYS[d]!.slice(0, 3));
      if (names.length > 1) return `${names.slice(0, -1).join(', ')} and ${names.at(-1)} at ${t}`;
    }
    if (num.test(dom) && dow === '*') return `Monthly on day ${dom} at ${t}`;
  }
  return expr;
}

/** Sidebar stamp (Akeru roster): today → clock time, yesterday → "Yesterday", this week → weekday, this year → "23 Oct", else M/D/YY. */
export function rosterTime(ts: number | undefined, now = Date.now()): string {
  if (!ts) return '';
  const d = new Date(ts);
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const day = new Date(ts); day.setHours(0, 0, 0, 0);
  const days = Math.round((today.getTime() - day.getTime()) / 86_400_000);
  if (days <= 0) return d.toLocaleTimeString(intlLocale(), { hour: 'numeric', minute: '2-digit', ...clockHours() });
  if (days === 1) return 'Yesterday';
  if (days < 7) return d.toLocaleDateString(intlLocale(), { weekday: 'short' });
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  // this year by its month's name ("23 Oct": a bare "23/10" reads as a fraction beside the clock times); older, the short date
  return d.toLocaleDateString(intlLocale(), sameYear ? { month: 'short', day: 'numeric' } : { month: 'numeric', day: 'numeric', year: '2-digit' });
}
