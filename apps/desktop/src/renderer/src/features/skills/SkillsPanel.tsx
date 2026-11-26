import { useEffect, useMemo, useState } from 'react';
import type { Skill } from '@appubot/protocol';
import { BookOpen, ChevronRight, GraduationCap, Sparkles, Wand2 } from '../../components/ui/icons';
import { Badge, Card, EmptyState, Icon, Spinner, cn, type BadgeTone } from '../../components/ui';
import { ROW_HOVER } from '../../components/layout/PanelChrome';
import { call } from '../../lib/actions';
import { timeAgo } from '@appubot/chat-core';
import { useNow } from '../../lib/hooks';
import { TEACH } from '../../lib/platform';
import { useCloudLacks } from '../cloud/useCloudLacks';
import { selectSelectedBot, selectSelectedThread, setState, ui, upsertBy, useStore } from '../../lib/store';
import { activeComputer } from '../../lib/gateway';
import { remember } from '../../lib/remembered';

export const skillKey = (k: Skill): string => `${k.botId ?? ''}/${k.name}`;

const SOURCE: Record<Skill['source'], { label: string; tone: BadgeTone }> = {
  taught: { label: 'Taught', tone: 'accent' },
  bundled: { label: 'Built-in', tone: 'indigo' },
  user: { label: 'Written', tone: 'neutral' },
};

/** "just now" / "5m ago" / "Mar 4" - timeAgo with a readable suffix. */
export function ago(ts: number | undefined, now = Date.now()): string {
  const t = timeAgo(ts, now);
  if (!t) return '';
  if (t === 'now') return 'just now';
  return /^\d+[mhd]$/.test(t) ? `${t} ago` : t;
}

/** Replace a bot's skills in the store with a freshly listed set. */
export function mergeBotSkills(botId: string, list: Skill[]): void {
  setState((s) => {
    const listedKeys = new Set(list.map(skillKey));
    let next = s.skills.filter((k) => k.botId !== botId && !listedKeys.has(skillKey(k)));
    for (const k of list) next = upsertBy(next, k, skillKey);
    return { skills: next };
  });
}

/** Right-panel list of the selected bot's skills (a click opens one to read or edit), with the Teach CTA on top. */
export function SkillsPanel() {
  const bot = useStore(selectSelectedBot);
  const lacks = useCloudLacks();
  const allSkills = useStore((s) => s.skills);
  const [loading, setLoading] = useState(false);
  const now = useNow(60_000);
  const botId = bot?.id;
  // the computer on screen's connection: right after switching computers it isn't up yet, so the list waits for it
  // (and comes again once it is) rather than failing
  const connected = useStore((s) => s.conn === 'connected');

  // read on this computer before: its list (kept with the computer's lists) shows at once, and an empty one says so
  // rather than spinning while it is read again
  const readBefore = useStore((s) => !!botId && !!s.remembered[`loaded:skills:${botId}`]);
  const load = async (id: string) => {
    setLoading(true);
    const from = activeComputer();
    const list = await call('skills.list', { botId: id }, { errorTitle: 'Could not load skills' });
    if (list) { mergeBotSkills(id, list); remember(`loaded:skills:${id}`, true, from); }
    setLoading(false);
  };

  // no Refresh button (the owner's call, 2026-11-17: skills are taught or the bot is asked to save one): the list is
  // read when the tab opens, the connection comes up, the bot's turn ends (it may have saved one) and the window
  // comes back to the front
  const working = useStore((s) => { const t = selectSelectedThread(s); return !!t && t.botId === botId && t.status === 'running'; });
  useEffect(() => {
    if (botId && connected) void load(botId);
  }, [botId, connected, working]);
  useEffect(() => {
    if (!botId) return;
    const onFocus = () => { if (useStore.getState().conn === 'connected') void load(botId); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [botId]);

  const skills = useMemo(
    () =>
      allSkills
        .filter((k) => !k.botId || k.botId === botId)
        .sort((a, b) => (a.source === 'bundled' ? 1 : 0) - (b.source === 'bundled' ? 1 : 0) || b.updatedAt - a.updatedAt),
    [allSkills, botId],
  );

  if (!bot) {
    return (
      <div className="flex h-full flex-col">
        <EmptyState icon={Sparkles} title="No bot selected" body="Pick a bot to see the skills it has learned." className="flex-1" />
      </div>
    );
  }
  const open = (k: Skill) => ui.openModal({ kind: 'skill', botId: k.botId ?? bot.id, name: k.name });

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto px-2.5 pb-4">
        {TEACH && !lacks.teach ? <Card interactive className="!rounded-[14px] mx-1.5 mb-3">
          <button type="button" onClick={() => ui.openModal({ kind: 'teach' })} className="flex w-full items-center gap-3 rounded-[14px] px-3.5 py-3 text-left outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--ab-ring)]">
            <span className="ab-pill squircle flex size-8 shrink-0 items-center justify-center rounded-control bg-accent-soft text-accent-strong">
              <Icon icon={GraduationCap} size={16} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-copy font-medium text-fg">Teach a task</span>
              <span className="block text-note leading-snug text-muted">Show {bot.name} once: it learns the steps.</span>
            </span>
            <Icon icon={ChevronRight} size={15} className="text-muted" />
          </button>
        </Card> : null}

        {skills.length === 0 ? (
          loading && !readBefore ? (
            <div className="flex justify-center py-10 text-muted"><Spinner size={18} /></div>
          ) : (
            <EmptyState
              icon={Wand2}
              title="No skills yet"
              body={`Skills are step-by-step playbooks ${bot.name} can reuse. Teach one by showing it, or ask ${bot.name} to save one.`}
            />
          )
        ) : (
          <ul className="flex flex-col gap-px">
            {skills.map((k) => {
              const src = SOURCE[k.source];
              return (
                <li key={skillKey(k)}>
                  <button
                    type="button"
                    onClick={() => open(k)}
                    className={cn('flex w-full items-start gap-2.5 rounded-row px-2 py-2 text-left outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--ab-ring)]', ROW_HOVER)}
                  >
                    <span className="ab-pill mt-px flex size-7 shrink-0 items-center justify-center rounded-[8px] bg-surface-2 text-fg-2">
                      <Icon icon={k.source === 'taught' ? GraduationCap : BookOpen} size={15} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate font-mono text-ui font-medium text-fg">{k.name}</span>
                        <Badge tone={src.tone}>{src.label}</Badge>
                      </span>
                      {k.description ? <span className="mt-0.5 line-clamp-2 block text-note leading-snug text-fg-2">{k.description}</span> : null}
                      <span className="mt-0.5 block text-note text-muted">Updated {ago(k.updatedAt, now)}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
