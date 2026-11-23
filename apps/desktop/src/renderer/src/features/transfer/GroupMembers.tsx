/**
 * A group's picture on the transfer screens (Settings › Transfer, the cloud's first visit): up to four of its members
 * huddled in a square the size of a bot's avatar, so a group's row lines up with the bots' rows above it. (The
 * sidebar's turning `GroupTile` can't be used here: the sidebar reaches the cloud client, which reaches these screens.)
 * An empty group shows the people icon.
 */
import type { Bot } from '@appubot/protocol';
import { BotAvatar, Icon } from '../../components/ui';
import { Users } from '../../components/ui/icons';

/** where each member sits, as fractions of the square, by how many there are (its avatar's size, then left and top) */
const LAYOUTS: Record<number, { s: number; at: [number, number][] }> = {
  1: { s: 1, at: [[0, 0]] },
  2: { s: 0.62, at: [[0, 0], [0.38, 0.38]] },
  3: { s: 0.56, at: [[0.22, 0], [0, 0.44], [0.44, 0.44]] },
  4: { s: 0.52, at: [[0, 0], [0.48, 0], [0, 0.48], [0.48, 0.48]] },
};

export function GroupMembers({ members, size }: { members: Bot[]; size: number }) {
  if (!members.length) return <span aria-hidden className="grid shrink-0 place-items-center text-muted" style={{ width: size, height: size }}><Icon icon={Users} size={Math.round(size * 0.6)} /></span>;
  const shown = members.slice(0, 4);
  const { s, at } = LAYOUTS[shown.length]!;
  const each = Math.round(size * s);
  return (
    <span aria-hidden className="relative block shrink-0" style={{ width: size, height: size }}>
      {shown.map((b, k) => (
        <span key={b.id} className="absolute" style={{ left: Math.round(at[k]![0] * size), top: Math.round(at[k]![1] * size) }}>
          <BotAvatar bot={b} size={each} still />
        </span>
      ))}
    </span>
  );
}
