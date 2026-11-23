/**
 * The side panel's first tab, Threads: every thread of the bot on screen, the latest activity first, each with its
 * last message, time, unread dot and state; a click opens it, and it renames in place or deletes (asked first) on
 * hover (the header switcher's own row, `ThreadRow`). New thread is the tab's one action, at its top right.
 */
import { useEffect, useMemo, useState } from 'react';
import { botThreads } from '@appubot/protocol';
import { MessageSquare, SquarePen } from '../../components/ui/icons';
import { Button, EmptyState } from '../../components/ui';
import { PanelHeader } from '../../components/layout/PanelChrome';
import { openThread, startThread } from '../../lib/actions';
import { rpc } from '../../lib/gateway';
import { useNow } from '../../lib/hooks';
import { selectSelectedBot, upsertThreads, useStore } from '../../lib/store';
import { ThreadRow } from './ThreadSwitcher';

export function ThreadsPanel() {
  const bot = useStore(selectSelectedBot);
  const all = useStore((s) => s.threads);
  const onScreenId = useStore((s) => s.selectedThreadId);
  const unread = useStore((s) => s.unread);
  const pending = useStore((s) => s.pendingPermissions);
  const botId = bot?.id;
  const threads = useMemo(() => (botId ? botThreads(all, botId) : []), [all, botId]);
  const waiting = useMemo(() => new Set(pending.map((p) => p.threadId)), [pending]);
  const now = useNow();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  // the bot's whole list (the snapshot carries 200 threads in all), as the header's switcher asks on opening
  useEffect(() => {
    setRenaming(null);
    if (!botId) return;
    rpc('threads.list', { botId, limit: 200 }).then((list) => upsertThreads(list)).catch(() => undefined);
  }, [botId]);

  if (!bot) return <EmptyState title="No bot" body="Pick a bot to see its threads." />;
  const newThread = async () => {
    if (starting) return;
    setStarting(true);
    await startThread(bot.id);
    setStarting(false);
  };

  return (
    <div className="flex h-full flex-col">
      <PanelHeader actions={<Button variant="secondary" size="sm" icon={SquarePen} loading={starting} onClick={() => void newThread()}>New thread</Button>} />
      {/* room under the last row for the support bubble in the window's corner */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-24">
        {threads.length ? (
          <div role="listbox" aria-label={`${bot.name}’s threads`} className="ab-rise-list [--rise-step:22ms]">
            {threads.map((t) => (
              <ThreadRow
                key={t.id}
                t={t} now={now}
                active={false} onScreen={t.id === onScreenId} unread={!!unread[t.id]}
                waiting={t.status === 'waiting' || waiting.has(t.id)}
                renaming={renaming === t.id}
                onHover={() => undefined}
                onOpen={() => void openThread(t.id)}
                onRename={() => setRenaming(t.id)}
                onRenamed={() => setRenaming(null)}
              />
            ))}
          </div>
        ) : (
          <EmptyState icon={MessageSquare} title="No threads yet" body={`Your first message to ${bot.name} starts one.`} />
        )}
      </div>
    </div>
  );
}
