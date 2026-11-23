// A bot named in a group message (@Name, chat-core linkMentions): its avatar and name right in the text, with no chip
// or fill round them (the owner's call, 2026-11-18: "no need of bubble, show direct"); @everyone the same with the
// people icon. A bot that's gone keeps the text as written.
import type { ReactNode } from 'react';
import { Users } from '../../components/ui/icons';
import { BotAvatar, Icon } from '../../components/ui';
import { useStore } from '../../lib/store';

const CHIP = 'inline-flex max-w-full translate-y-[-1px] items-center gap-1 align-middle font-semibold text-fg no-underline';

export function MentionChip({ id, fallback }: { id: string; fallback?: ReactNode }) {
  const bot = useStore((s) => (id === 'everyone' ? undefined : s.bots.find((b) => b.id === id)));
  if (id === 'everyone') {
    return (
      <span className={CHIP}>
        <span className="grid size-4 place-items-center"><Icon icon={Users} size={12} /></span>
        <span className="truncate">everyone</span>
      </span>
    );
  }
  if (!bot) return <>{fallback}</>;
  return (
    <span title={bot.job || bot.name} className={CHIP}>
      <BotAvatar bot={bot} size={16} still />
      <span className="truncate">{bot.name}</span>
    </span>
  );
}
