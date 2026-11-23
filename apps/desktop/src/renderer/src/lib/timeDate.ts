// The pure half of the time and date pickers (components/ui/TimeDate.tsx): a time of day as "HH:MM" and a date as
// "YYYY-MM-DD" (what `<input type="time|date">` gave, so every caller keeps its values) to and from the pickers'
// segments, the 12-hour reading of an hour, and which way round a locale writes a date.

export type Parts = Record<string, number | undefined>;

export function parseTime(value: string): { hour?: number; minute?: number } {
  const m = /^(\d{1,2}):(\d{2})/.exec(value.trim());
  if (!m) return {};
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  return hour <= 23 && minute <= 59 ? { hour, minute } : {};
}

const two = (n: number) => String(n).padStart(2, '0');

/** "HH:MM", or '' while the hour or the minute is missing. */
export function formatTime(hour: number | undefined, minute: number | undefined): string {
  if (hour === undefined || minute === undefined || hour > 23 || minute > 59) return '';
  return `${two(hour)}:${two(minute)}`;
}

/** 15 -> { hour: 3, pm: 1 }; 0 -> { hour: 12, pm: 0 }. */
export const to12 = (hour: number): { hour: number; pm: 0 | 1 } => ({ hour: hour % 12 || 12, pm: hour >= 12 ? 1 : 0 });
/** 12 AM -> 0, 12 PM -> 12, 3 PM -> 15. */
export const to24 = (hour: number, pm: number): number => (hour % 12) + (pm ? 12 : 0);

export function parseDate(value: string): { year?: number; month?: number; day?: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (!m) return {};
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  return month >= 1 && month <= 12 && day >= 1 && day <= daysIn(year, month) ? { year, month, day } : {};
}

export const daysIn = (year: number, month: number): number => new Date(Date.UTC(year, month, 0)).getUTCDate();

/** "YYYY-MM-DD" (a day past the month's end becomes its last), or '' while a part is missing or the year is short. */
export function formatDate(year: number | undefined, month: number | undefined, day: number | undefined): string {
  if (year === undefined || month === undefined || day === undefined) return '';
  if (year < 1000 || year > 9999 || month < 1 || month > 12 || day < 1) return '';
  return `${year}-${two(month)}-${two(Math.min(day, daysIn(year, month)))}`;
}

export type DatePart = 'day' | 'month' | 'year';

/** The order a locale writes a date in (day first, month first, or year first). */
export function dateOrder(locale?: string): DatePart[] {
  try {
    const order = new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'numeric', day: 'numeric' })
      .formatToParts(new Date(2024, 10, 25))
      .map((p) => p.type)
      .filter((t): t is DatePart => t === 'day' || t === 'month' || t === 'year');
    if (order.length === 3 && new Set(order).size === 3) return order;
  } catch { /* an unknown locale: the default below */ }
  return ['day', 'month', 'year'];
}

/** Whether a locale's clock (or the chosen clock style) is a 12-hour one. */
export function is12Hour(locale: string | undefined, style: { hourCycle?: 'h12' | 'h23' }): boolean {
  if (style.hourCycle) return style.hourCycle === 'h12';
  try {
    const cycle = new Intl.DateTimeFormat(locale, { hour: 'numeric' }).resolvedOptions().hourCycle;
    return cycle === 'h12' || cycle === 'h11';
  } catch {
    return false;
  }
}
