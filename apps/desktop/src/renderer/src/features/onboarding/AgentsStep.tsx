import { useEffect, useRef, useState } from 'react';
import type { Provider } from '@appubot/protocol';
import { providerLogin } from '@appubot/chat-core';
import { ArrowRight, ChevronDown, RefreshCw } from '../../components/ui/icons';
import { Button, Icon, cn } from '../../components/ui';
import { call } from '../../lib/actions';
import { THIS_MACHINE } from '../../lib/platform';
import { byId, getState, setState, upsertBy, useStore } from '../../lib/store';
import { ProviderActions, ProviderMark, refreshProviders } from '../providers/ProviderRow';
import { StepShell } from './StepShell';
import { TaskCheck } from '../../components/rare/TaskCheck';

/** what each agent runs on, in a few words */
const HINTS: Record<string, string> = {
  'claude-code': 'Your Claude plan',
  codex: 'Your ChatGPT plan',
  cursor: 'Your Cursor account',
  grok: 'Your Grok account',
  copilot: 'Your GitHub Copilot plan',
  opencode: 'Free models, no account needed',
};
/**
 * always shown; the others once they are on this computer (or behind "More agents"). OpenCode leads: it needs no
 * account, AppuBot installs it by itself (core `freeAgent.ts`) and a new setup starts on it
 */
const MAIN = ['opencode', 'claude-code', 'codex'];

/** it can run a bot now: signed in, or installed with a login AppuBot can't check */
const usable = (p: Provider): boolean => {
  const k = providerLogin(p).kind;
  return k === 'logged_in' || k === 'unknown';
};

const order = (p: Provider): number => (MAIN.includes(p.id) ? MAIN.indexOf(p.id) : p.builtin ? 10 : 20);

/**
 * The agent bots run on (`settings.defaultProviderId`): pick one that's signed in, or install / sign in to one here.
 * Continue makes the pick the default and moves the first bot (the one setup made) onto it, switching the agent on if
 * it was off (Cursor, Grok, Copilot and OpenCode start off).
 */
export function AgentsStep({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const providers = useStore((s) => s.providers);
  const defaultId = useStore((s) => s.settings?.defaultProviderId ?? 'claude-code');
  const [picked, setPicked] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);

  const list = providers.filter((p) => !p.profile).sort((a, b) => order(a) - order(b));
  const shown = list.filter((p) => MAIN.includes(p.id) || providerLogin(p).kind !== 'not_installed' || more);
  const hidden = list.length - shown.length;
  // what Continue will use: the one picked, else the default when it can run, else the first that can
  const ready = list.filter(usable);
  const selected = [picked, defaultId].map((id) => ready.find((p) => p.id === id)).find(Boolean) ?? ready[0];

  // back from signing in (Terminal, the browser): look again, at most every few seconds
  const lastCheck = useRef(0);
  useEffect(() => {
    const f = () => {
      if (Date.now() - lastCheck.current < 4000) return;
      lastCheck.current = Date.now();
      void refreshProviders();
    };
    window.addEventListener('focus', f);
    return () => window.removeEventListener('focus', f);
  }, []);

  const proceed = async () => {
    if (!selected) return onNext();
    setSaving(true);
    try {
      if (!selected.enabled) {
        const res = await call('providers.upsert', {
          id: selected.id, name: selected.name, description: selected.description, command: selected.command, args: selected.args,
          env: selected.env, icon: selected.icon, enabled: true, installHint: selected.installHint,
        }, { errorTitle: `Could not turn on ${selected.name}` });
        if (!res) return;
        setState((s) => ({ providers: upsertBy(s.providers, res, byId) }));
      }
      if (selected.id !== defaultId) {
        const s = await call('settings.update', { defaultProviderId: selected.id, defaultModelId: '' }, { errorTitle: 'Could not save' });
        if (!s) return;
        setState({ settings: s });
      }
      // the bot setup made rides along (it hasn't talked yet, so nothing is lost)
      const first = getState().bots[0];
      if (first && first.providerId !== selected.id) await call('bots.update', { id: first.id, patch: { providerId: selected.id } }, { errorTitle: `Could not move ${first.name}` });
      onNext();
    } finally {
      setSaving(false);
    }
  };

  return (
    <StepShell
      title="Choose your AI"
      body="Your bots run on an AI app you already use, with your own plan. Nothing extra to pay."
      onBack={onBack}
      actions={
        <>
          {!selected ? <Button size="lg" variant="ghost" onClick={onNext}>Skip for now</Button> : null}
          <Button size="lg" variant="primary" iconRight={ArrowRight} loading={saving} disabled={!selected} onClick={() => void proceed()}>Continue</Button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-2.5 min-[760px]:grid-cols-2">
        {shown.map((p) => (
          <AgentCard key={p.id} provider={p} selected={selected?.id === p.id} onPick={() => setPicked(p.id)} />
        ))}
      </div>
      {!list.length ? <div className="py-8 text-center text-copy text-muted">Looking for AI apps on {THIS_MACHINE}…</div> : null}
      <div className="mt-4 flex items-center justify-center gap-1 text-ui text-muted">
        {hidden > 0 ? (
          <button type="button" onClick={() => setMore(true)} className="ab-pill squircle flex items-center gap-1 rounded-control-sm px-2 py-1 hover:text-fg">
            {hidden} more <Icon icon={ChevronDown} size={13} />
          </button>
        ) : null}
        {hidden > 0 ? <span aria-hidden>·</span> : null}
        <button
          type="button" disabled={checking}
          onClick={async () => { setChecking(true); await refreshProviders(); setChecking(false); }}
          className="ab-pill squircle flex items-center gap-1 rounded-control-sm px-2 py-1 hover:text-fg disabled:opacity-60"
        >
          <Icon icon={RefreshCw} size={12} className={cn(checking && 'animate-spin')} />
          {checking ? 'Checking…' : 'Check again'}
        </button>
      </div>
    </StepShell>
  );
}

function AgentCard({ provider: p, selected, onPick }: { provider: Provider; selected: boolean; onPick: () => void }) {
  const v = providerLogin(p);
  const ok = usable(p);
  const status = v.kind === 'logged_in' ? ['Ready', p.auth?.plan].filter(Boolean).join(' · ')
    : v.kind === 'unknown' ? 'Installed'
      : v.kind === 'logged_out' ? 'Not signed in'
        : v.kind === 'error' ? 'Couldn’t start'
          : 'Not installed';
  return (
    <div
      role={ok ? 'radio' : undefined}
      aria-checked={ok ? selected : undefined}
      tabIndex={ok ? 0 : undefined}
      onClick={ok ? onPick : undefined}
      onKeyDown={ok ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(); } } : undefined}
      className={cn(
        'glass-raised squircle flex min-h-[72px] items-center gap-3.5 rounded-[16px] px-4 py-3 text-left transition-[background-color,box-shadow] duration-150',
        ok && 'cursor-pointer hover:bg-surface-2',
        selected && '!border-transparent !bg-[color-mix(in_srgb,var(--ab-accent)_7%,var(--ab-surface))] shadow-[0_0_0_1.5px_var(--ab-accent)]',
        'focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_var(--ab-bg),0_0_0_4px_var(--ab-ring)]',
      )}
    >
      <ProviderMark provider={p} size={38} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-copy font-medium text-fg">{p.name}</span>
          {p.id === 'claude-code' ? <span className="ab-pill rounded-[5px] bg-surface-2 px-2 py-px text-[11px] font-medium text-fg-2">Recommended</span> : null}
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-note">
          <span className={cn('size-1.5 shrink-0 rounded-full', ok ? 'bg-success' : v.kind === 'logged_out' ? 'bg-attention' : 'bg-surface-3')} />
          <span className={cn('truncate', ok ? 'text-fg-2' : 'text-muted')} title={p.lastError ?? HINTS[p.id] ?? p.description}>{status}</span>
        </div>
      </div>
      {ok ? (
        <TaskCheck checked={selected} />
      ) : (
        // its own buttons don't pick the card
        <div onClick={(e) => e.stopPropagation()}><ProviderActions provider={p} compact /></div>
      )}
    </div>
  );
}
