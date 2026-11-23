// A spoken message's recording, or a reply read aloud, as a player in the transcript: Rare UI's voice note
// (components/rare/VoiceNote.tsx): play/pause, a waveform that fills as it plays and can be scrubbed (drawn from the
// file's id, not its sound: the waveform isn't stored), the time left with a speed to press through, and lights in
// the bot's colour drifting round the pill while it plays. One plays at a time; it never shows as a file tile.
import { useMemo, useState } from 'react';
import type { Part } from '@appubot/protocol';
import { cn } from '../../components/ui';
import { VoiceNote as RareVoiceNote } from '../../components/rare/VoiceNote';
import { useCloudFiles } from '../cloud/cloudClient';
import { useFileSrc } from '../cloud/remoteFiles';

export type VoicePart = Extract<Part, { type: 'voice' }>;

/** a number from a file's id, the same every time: its waveform's seed */
export function seedOf(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return (h >>> 0) % 100000;
}

export function VoiceNote({ part, color, className }: {
  part: VoicePart;
  /** the bot's colour: what lights the pill while it plays */
  color?: string;
  className?: string;
}) {
  // a cloud computer's files come through its channel: re-render once their bytes are here
  useCloudFiles((s) => s.rev);
  const [failed, setFailed] = useState(false);
  const seed = useMemo(() => seedOf(part.file.id), [part.file.id]);
  // a remote computer's recording comes over its channel into this Mac's cache first (as a file tile's does)
  const src = useFileSrc(part.file);
  const seconds = (part.durationMs || 0) / 1000;
  return (
    <RareVoiceNote
      // a new file is a new player (its audio element and place start over)
      key={src || 'pending'}
      src={src || undefined}
      pending={!src}
      duration={seconds || 1}
      // its length is the part's own: nothing is fetched until it is played
      preload={seconds ? 'none' : 'metadata'}
      seed={seed}
      bars={36}
      size="sm"
      accent={color}
      onError={() => setFailed(true)}
      aria-label={part.kind === 'reply' ? 'Voice reply' : 'Voice message'}
      title={failed ? 'This recording can’t be played' : part.transcript}
      className={cn('w-[264px] max-w-full', className)}
    />
  );
}
