// A turn that failed, as a card with what fixes it (2026-11-17, the owner's "for model errors and other stuff make
// cards instead of a red error, with the ability to fix, like a model pick"; rules and words in chat-core
// `turnFailure.ts`): what went wrong in plain words, then the fixes for it right there: the chat's own model picker,
// Try again (the same message once more), Sign in / Install (Settings › Agents), New thread. The agent's own words
// sit under them, small, to read or copy. Only the chat's latest message offers the fixes: a failure further up is
// history, and gets the words alone.
import { useState } from 'react';
import type { Message } from '@appubot/protocol';
import { agentDisplayName, turnFailure, type FailureFix } from '@appubot/chat-core';
import { AlertTriangle, LogIn, RefreshCw, SquarePen } from '../../components/ui/icons';
import { Button, Icon } from '../../components/ui';
import { sendMessage, startThread } from '../../lib/actions';
import { ui, useStore } from '../../lib/store';
import { ThreadModelPicker } from './ComposerBar';

export function FailureCard({ msg, botName }: { msg: Message; botName: string }) {
  const thread = useStore((s) => s.threads.find((t) => t.id === msg.threadId));
  const providers = useStore((s) => s.providers);
  const provider = providers.find((p) => p.id === thread?.providerId);
  // the message this turn answered (the user's last one before it), and whether this is the chat's latest message
  const asked = useStore((s) => {
    const c = s.convo[msg.threadId];
    const at = c ? c.ids.indexOf(msg.id) : -1;
    if (!c || at < 0) return undefined;
    for (let i = at - 1; i >= 0; i--) {
      const m = c.byId[c.ids[i]!];
      if (!m) continue;
      if (m.role !== 'user') return undefined;
      const text = m.parts.map((p) => (p.type === 'text' ? p.text : '')).join('\n').trim();
      return text || undefined;
    }
    return undefined;
  });
  const latest = useStore((s) => { const c = s.convo[msg.threadId]; return !!c && c.ids[c.ids.length - 1] === msg.id; });
  const [busy, setBusy] = useState(false);
  const f = turnFailure(msg.error, { botName, agentName: provider ? agentDisplayName(provider, providers) : undefined, asked: !!asked });
  const fixes: FailureFix[] = latest && thread ? f.fixes : [];
  const retry = async () => {
    if (!thread || !asked || busy) return;
    setBusy(true);
    try { await sendMessage(thread.botId, thread.id, asked); } finally { setBusy(false); }
  };
  const buttons = fixes.filter((x) => x !== 'model');
  return (
    <section aria-label={f.title} className="chat-generative glass-raised squircle w-full max-w-[34rem] rounded-card">
      <div className="flex flex-col gap-3 px-4 pt-3.5 pb-3.5">
        <div className="flex items-start gap-2.5">
          <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-[color-mix(in_srgb,var(--ab-warning)_16%,transparent)] text-warning">
            <Icon icon={AlertTriangle} size={13} />
          </span>
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-copy leading-snug font-semibold text-fg">{f.title}</span>
            {f.body ? <span className="text-ui leading-snug text-muted">{f.body}</span> : null}
          </div>
        </div>
        {fixes.includes('model') && thread ? (
          // the chat's own picker, here: a pick goes to this chat at once, and Try again sends on it
          <div className="flex items-center justify-between gap-3 rounded-control bg-[color-mix(in_srgb,var(--ab-fg)_5%,transparent)] py-1 pr-1.5 pl-3">
            <span className="shrink-0 text-ui text-muted">Model</span>
            <ThreadModelPicker thread={thread} side="top" align="end" className="min-w-0 [&>button]:text-ui [&_.truncate]:min-w-0 [&_.truncate]:shrink" />
          </div>
        ) : null}
        {buttons.length ? (
          <div className="flex flex-wrap items-center gap-2">
            {buttons.map((fix, i) => {
              const variant = i === 0 ? 'primary' : 'secondary';
              if (fix === 'retry') return <Button key={fix} size="sm" variant={variant} icon={RefreshCw} loading={busy} onClick={() => void retry()}>Try again</Button>;
              if (fix === 'agents') return <Button key={fix} size="sm" variant={variant} icon={LogIn} onClick={() => ui.openSettings('providers')}>{f.agentsLabel}</Button>;
              return <Button key={fix} size="sm" variant={variant} icon={SquarePen} onClick={() => void startThread(thread!.botId)}>New thread</Button>;
            })}
          </div>
        ) : null}
        {f.detail ? <p className="selectable line-clamp-3 text-note leading-snug break-words text-[color-mix(in_srgb,var(--ab-fg)_42%,transparent)]" title={f.detail}>{f.detail}</p> : null}
      </div>
    </section>
  );
}
