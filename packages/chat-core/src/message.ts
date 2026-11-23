/** Small readers over messages shared by the desktop and phone transcripts. */
import type { Message, Part } from '@appubot/protocol';

/** The desktop composer appends attached paths as "Files: /path" lines; the transcripts show them as chips instead. */
export function splitFileLines(text: string): { body: string; paths: string[] } {
  const lines = text.split('\n');
  const paths: string[] = [];
  while (lines.length && /^Files: \//.test(lines[lines.length - 1]!)) paths.unshift(lines.pop()!.slice('Files: '.length));
  return { body: lines.join('\n').trim(), paths };
}

/** All of a message's text parts, joined the way the user typed them. */
export function messageRawText(msg: Pick<Message, 'parts'>): string {
  return msg.parts.map((p) => (p.type === 'text' ? p.text : '')).join('\n');
}

export type ImagePart = Extract<Part, { type: 'image' }>;
export type FilePart = Extract<Part, { type: 'file' }>;
