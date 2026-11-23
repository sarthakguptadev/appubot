// What a sent message's (i) shows (the desktop's info button, the phone's long-press sheet): where it came from, when exactly, and what it carried.
// Pure, so it's tested without the window; the machine's name is passed in ("Mac", "PC", "computer").
import { clockHours, formatClockDuration } from './format';
import type { Message } from '@appubot/protocol';

export type InfoSource = 'computer' | 'phone' | 'telegram' | 'routine' | 'appubot' | 'bot';
/** `text` is the row as the (i) menu shows it, worded like a reply's "Replied …": "From your Mac", "Sent Fri, …" */
export interface MessageInfoRow { label: string; value: string; text: string; note?: string }
export interface MessageInfo { source: InfoSource; rows: MessageInfoRow[] }

const SOURCES: Record<Message['via'], { source: InfoSource; value: (machine: string) => string; from: (machine: string) => string; note?: string }> = {
  desktop: { source: 'computer', value: (m) => `Your ${m}`, from: (m) => `From your ${m}`, note: 'In the AppuBot app' },
  mobile: { source: 'phone', value: () => 'Your phone', from: () => 'From your phone', note: 'In the AppuBot app' },
  channel: { source: 'telegram', value: () => 'Telegram', from: () => 'From Telegram', note: 'Its reply went to Telegram too' },
  routine: { source: 'routine', value: () => 'A routine', from: () => 'From a routine', note: 'Sent on its schedule' },
  system: { source: 'appubot', value: () => 'AppuBot', from: () => 'From AppuBot' },
  bot: { source: 'bot', value: () => 'Another bot', from: () => 'From another bot', note: 'A bot messaged this one' },
};

/** the exact moment, seconds and year included */
export const exactTime = (t: number) =>
  new Date(t).toLocaleString([], { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', ...clockHours() });

const row = (label: string, value: string): MessageInfoRow => ({ label, value, text: `${label} ${value}` });
const count = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

export function messageInfo(msg: Message, machine: string): MessageInfo {
  const from = SOURCES[msg.via] ?? SOURCES.desktop;
  // a bot's message names the bot; a routine's prompt its routine (one from before routines were named on it: "A routine")
  const sender = msg.via === 'bot' && msg.from ? { value: msg.from.name, text: `From ${msg.from.name}`, note: 'A message from that bot' }
    : msg.via === 'routine' && msg.routine?.name.trim() ? { value: msg.routine.name.trim(), text: `From the routine ${msg.routine.name.trim()}`, note: from.note }
      : { value: from.value(machine), text: from.from(machine), note: from.note };
  const rows: MessageInfoRow[] = [
    { label: 'From', ...sender },
    row('Sent', exactTime(msg.createdAt)),
  ];
  const voice = msg.parts.find((p) => p.type === 'voice');
  if (voice?.type === 'voice') rows.push(row('Spoken', formatClockDuration(voice.durationMs)));
  const pictures = msg.parts.filter((p) => p.type === 'image').length;
  const files = msg.parts.filter((p) => p.type === 'file').length;
  const attached = [files && count(files, 'file'), pictures && count(pictures, 'picture')].filter(Boolean).join(', ');
  if (attached) rows.push(row('Attached', attached));
  return { source: from.source, rows };
}
