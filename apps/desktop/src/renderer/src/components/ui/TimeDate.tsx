// A time of day and a date picked on Rare UI's DurationPicker design (components/rare/DurationPicker.tsx): squircle
// segments that read as one pill ("09 Hr. 30 Min.", "14 Day 11 Mo. 2026 Yr.") and spring apart into fields when the
// pen, or a number, is pressed. Values are what `<input type="time">` and `<input type="date">` give ("HH:MM",
// "YYYY-MM-DD"), '' while a part is still missing. A 12-hour clock (the Appearance setting, else the language's own
// habit) gets hours 1 to 12 and an AM / PM segment that flips; a date's parts sit in the language's order.
import { useMemo, useState } from 'react';
import { clockHours, intlLocale } from '@appubot/chat-core';
import { SegmentPicker, type PickerSegment, type PickerSize, type PickerValues } from '../rare/DurationPicker';
import { dateOrder, formatDate, formatTime, is12Hour, parseDate, parseTime, to12, to24, type DatePart } from '../../lib/timeDate';

interface PickerProps {
  value: string;
  onChange: (value: string) => void;
  size?: PickerSize;
  disabled?: boolean;
  className?: string;
  id?: string;
  'aria-label'?: string;
  'aria-invalid'?: boolean;
}

/**
 * The fields' own numbers, kept here so a half-typed value (an hour with no minute yet) isn't lost when the caller's
 * string is '' for it; the caller's value takes over whenever it isn't what these numbers already say.
 */
function useDraft(value: string, parse: (v: string) => PickerValues, format: (v: PickerValues) => string) {
  const [draft, setDraft] = useState<PickerValues>(() => parse(value));
  const [seen, setSeen] = useState(value);
  if (value !== seen) {
    setSeen(value);
    if (value !== format(draft)) setDraft(parse(value));
  }
  return [draft, setDraft] as const;
}

const AMPM = ['AM', 'PM'] as const;

export function TimePicker({ value, onChange, size = 'sm', ...rest }: PickerProps) {
  const twelve = is12Hour(intlLocale(), clockHours());
  const segments = useMemo<PickerSegment[]>(() => [
    twelve
      ? { id: 'hour', label: 'Hr.', min: 1, max: 12, placeholder: '--', name: 'Hour' }
      : { id: 'hour', label: 'Hr.', max: 23, pad: 2, placeholder: '--', name: 'Hour' },
    { id: 'minute', label: 'Min.', max: 59, pad: 2, placeholder: '--', name: 'Minute' },
    ...(twelve ? [{ id: 'pm', options: AMPM, name: 'AM or PM' }] : []),
  ], [twelve]);
  const parse = (v: string): PickerValues => {
    const t = parseTime(v);
    if (!twelve || t.hour === undefined) return { hour: t.hour, minute: t.minute, pm: (t.hour ?? 0) >= 12 ? 1 : 0 };
    const h = to12(t.hour);
    return { hour: h.hour, minute: t.minute, pm: h.pm };
  };
  const format = (v: PickerValues): string => {
    const hour = v.hour === undefined ? undefined : twelve ? (v.hour >= 1 ? to24(v.hour, v.pm ?? 0) : undefined) : v.hour;
    return formatTime(hour, v.minute);
  };
  const [draft, setDraft] = useDraft(value, parse, format);
  const set = (v: PickerValues) => {
    setDraft(v);
    const next = format(v);
    if (next !== value) onChange(next);
  };
  return (
    <SegmentPicker
      segments={segments}
      values={draft}
      onChange={set}
      // saved with an hour and no minute: on the hour
      onConfirm={(v) => { if (v.hour !== undefined && v.minute === undefined) set({ ...v, minute: 0 }); }}
      size={size}
      editLabel="Change the time"
      saveLabel="Save the time"
      {...rest}
    />
  );
}

const DATE_SEGMENTS: Record<DatePart, PickerSegment> = {
  day: { id: 'day', label: 'Day', min: 1, max: 31, placeholder: '--', name: 'Day' },
  month: { id: 'month', label: 'Mo.', min: 1, max: 12, placeholder: '--', name: 'Month' },
  year: { id: 'year', label: 'Yr.', min: 1, max: 9999, placeholder: '----', name: 'Year' },
};

const parseDateValues = (v: string): PickerValues => ({ ...parseDate(v) });
const formatDateValues = (v: PickerValues): string => formatDate(v.year, v.month, v.day);

export function DatePicker({ value, onChange, size = 'sm', ...rest }: PickerProps) {
  const locale = intlLocale();
  const segments = useMemo(() => dateOrder(locale).map((p) => DATE_SEGMENTS[p]), [locale]);
  const [draft, setDraft] = useDraft(value, parseDateValues, formatDateValues);
  const set = (v: PickerValues) => {
    setDraft(v);
    const next = formatDateValues(v);
    if (next !== value) onChange(next);
  };
  return (
    <SegmentPicker
      segments={segments}
      values={draft}
      onChange={set}
      // saved as the 31st of a shorter month: the fields show the day the value carries
      onConfirm={(v) => { const d = parseDate(formatDateValues(v)); if (d.day !== undefined && d.day !== v.day) set({ ...v, day: d.day }); }}
      size={size}
      editLabel="Change the date"
      saveLabel="Save the date"
      {...rest}
    />
  );
}
