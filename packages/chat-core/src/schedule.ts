/**
 * A routine's schedule as people pick it (how often, at what time, on which days) and the cron expression the Mac
 * runs it by. The routine editor builds cron from this, and reads an existing routine's cron back into it; only a
 * cron this can't express stays "custom" (shown as cron, under Advanced).
 */

export type ScheduleSpec =
  | { kind: 'hourly'; minute: number }
  | { kind: 'daily'; hour: number; minute: number }
  | { kind: 'weekdays'; hour: number; minute: number }
  /** days: 0 = Sunday … 6 = Saturday */
  | { kind: 'days'; days: number[]; hour: number; minute: number }
  | { kind: 'monthly'; day: number; hour: number; minute: number }
  | { kind: 'custom'; cron: string };

export const SHORT_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

const n = (s: string, max: number): number | null => (/^\d+$/.test(s) && Number(s) <= max ? Number(s) : null);

/** Days of the week a cron field names (`1-5`, `1,3,5`, `0,6`, `MON-FRI`), or null when it isn't a plain list. */
function dayList(field: string): number[] | null {
  const names: Record<string, number> = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };
  const one = (x: string) => (x.toUpperCase() in names ? names[x.toUpperCase()]! : n(x, 7) === null ? null : n(x, 7)! % 7);
  const out = new Set<number>();
  for (const part of field.split(',')) {
    const range = /^(\w+)-(\w+)$/.exec(part);
    if (range) {
      const a = one(range[1]!), b = one(range[2]!);
      if (a === null || b === null || b < a) return null;
      for (let d = a; d <= b; d++) out.add(d);
    } else {
      const d = one(part);
      if (d === null) return null;
      out.add(d);
    }
  }
  return [...out].sort((x, y) => x - y);
}

export function cronToSpec(expr: string): ScheduleSpec {
  const f = expr.trim().split(/\s+/);
  const custom: ScheduleSpec = { kind: 'custom', cron: expr.trim() };
  if (f.length !== 5) return custom;
  const [mi, ho, dom, mon, dow] = f as [string, string, string, string, string];
  const minute = n(mi, 59);
  if (minute === null || mon !== '*') return custom;
  if (ho === '*' && dom === '*' && dow === '*') return { kind: 'hourly', minute };
  const hour = n(ho, 23);
  if (hour === null) return custom;
  if (dom === '*' && dow === '*') return { kind: 'daily', hour, minute };
  if (dow === '*') {
    const day = n(dom, 31);
    return day && day >= 1 ? { kind: 'monthly', day, hour, minute } : custom;
  }
  if (dom !== '*') return custom;
  const days = dayList(dow);
  if (!days?.length) return custom;
  if (days.join() === '1,2,3,4,5') return { kind: 'weekdays', hour, minute };
  if (days.length === 7) return { kind: 'daily', hour, minute };
  return { kind: 'days', days, hour, minute };
}

export function specToCron(s: ScheduleSpec): string {
  switch (s.kind) {
    case 'hourly': return `${s.minute} * * * *`;
    case 'daily': return `${s.minute} ${s.hour} * * *`;
    case 'weekdays': return `${s.minute} ${s.hour} * * 1-5`;
    case 'days': return `${s.minute} ${s.hour} * * ${[...new Set(s.days)].sort((a, b) => a - b).join(',') || '*'}`;
    case 'monthly': return `${s.minute} ${s.hour} ${s.day} * *`;
    case 'custom': return s.cron.trim();
  }
}

/** `HH:MM` for a time input. */
export const timeValue = (hour: number, minute: number): string => `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;

/** A time input's `HH:MM` back to numbers (null while it is incomplete). */
export function parseTimeValue(v: string): { hour: number; minute: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  if (!m) return null;
  const hour = Number(m[1]), minute = Number(m[2]);
  return hour <= 23 && minute <= 59 ? { hour, minute } : null;
}
