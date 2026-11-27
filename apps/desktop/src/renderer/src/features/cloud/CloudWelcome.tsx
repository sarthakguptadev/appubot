/**
 * The first time an AppuBot computer comes on screen on this Mac: a full-window welcome in the manner of setup's
 * (2026-11-14, the owner's calls; before, a small dialog said it and the empty roster behind it read as the app having
 * reset itself). Few words, three screens:
 *
 * 1. Where should your bots work? "Only in the cloud" (the first choice: many people stop using their laptop for
 *    bots once they have a cloud computer) or "Cloud and this Mac". Asked only when this Mac has bots worth bringing;
 *    otherwise, and for a team's computer, the screen just says the computer is ready. Continue saves it as this
 *    Mac's `settings.cloudOnly` (Settings › Account › Where your bots work, `cloudOnly.ts`).
 * 2. Move (or copy) your bots: every bot ticked, with all of it (memory, skills, files, routines, chats), the
 *    Mac's shared skills and its groups (made there with the bots that come, their chat history too where the computer
 *    takes it); one button runs Settings › Transfer's own run (`useTransfer`) and the rows show it. A move
 *    brings the routines over as they were, on, and then switches this Mac's off, so the cloud runs them alone; a
 *    copy brings them switched off, so nothing runs twice. Nothing is ever deleted from the Mac.
 * 3. A few things left: the phone app, agents' sign-ins, apps, Telegram.
 *
 * Once per computer on this Mac (localStorage `appubot.cloudWelcomed`); ✕ or Escape puts it away, and everything on
 * it is in Settings afterwards. Someone who took the cloud computer in first-run setup never sees it (setup marks it
 * seen: they have nothing here to bring, and its first bot says hello).
 */
import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { bytes, computerDisplayName } from '@appubot/chat-core';
import type { BotExportPart, ExportableBot } from '@appubot/protocol';
import { BotAvatar, Button, Icon, Logo, Spinner, cn, useModalPresence } from '../../components/ui';
import { AlertTriangle, AppsAdd, ArrowRight, Blocks, Check, CircleCheck, Cloud, Laptop, RotateCw, Send, Smartphone, X } from '../../components/ui/icons';
import { localGateway } from '../../lib/gateway';
import { IS_MAC, MACHINE } from '../../lib/platform';
import { ui, useStore, type Modal } from '../../lib/store';
import { StepShell } from '../onboarding/StepShell';
import { PhoneAppCodes } from '../settings/PhoneApps';
import { STEP_WORDS, estimateBytes, findClash, listNames, summaryText, trimmedText, worthBringing, type ItemState, type PlanItem } from '../transfer/transferPlan';
import { GroupMembers } from '../transfer/GroupMembers';
import { useTransfer, type Transfer } from '../transfer/useTransfer';
import { useCloud } from './cloudAccount';
import { setCloudOnly } from './cloudOnly';
import { ownComputerName } from './cloudView';
import { CloudTile } from './PlanParts';
import { CloudConnectButton } from './CloudAgentLogin';
import { EASE_OUT } from '../../lib/motion';
import { TaskCheck } from '../../components/rare/TaskCheck';

const SEEN_KEY = 'appubot.cloudWelcomed';

/** the mocks' page opens on a screen, as a first visit every time: `?cloud=running&on=cloud&cloudstep=start|transfer|next[&cloudmode=both]` */
const PREVIEW = import.meta.env.VITE_APPUBOT_MOCK === '1' && typeof location !== 'undefined' ? new URLSearchParams(location.search) : null;
const PREVIEW_STEP = PREVIEW?.get('cloudstep') ?? null;

/** The computers (by their cache keys) this Mac has been told about. */
export function cloudWelcomedKeys(): string[] {
  if (PREVIEW_STEP) return [];
  try { const v = JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]') as unknown; return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []; } catch { return []; }
}
export function markCloudWelcomed(key: string): void {
  try { localStorage.setItem(SEEN_KEY, JSON.stringify([...new Set([...cloudWelcomedKeys(), key])])); } catch { /* full: told again next time */ }
}

type Step = 'start' | 'transfer' | 'next';
/** where the bots work from now on: the cloud alone (a move) or both computers (a copy) */
type Mode = 'cloud' | 'both';
const SLIDE = {
  enter: (dir: number) => ({ opacity: 0, x: dir * 28 }),
  center: { opacity: 1, x: 0, transition: { duration: 0.32, ease: EASE_OUT } },
  exit: (dir: number) => ({ opacity: 0, x: dir * -28, transition: { duration: 0.18, ease: 'easeIn' as const } }),
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const size = (n: number) => bytes(n) || '0 B';
const figureOf = (item: ExportableBot) => (item.character ? { body: item.character.body, face: item.character.face } : item.bot.shape);

export function CloudWelcome({ modal }: { modal: Extract<Modal, { kind: 'cloud-welcome' }> | null }) {
  const open = !!modal;
  useModalPresence(open);
  // the team it was opened for stays while the screen fades out
  const [last, setLast] = useState(modal);
  useEffect(() => { if (modal) setLast(modal); }, [modal]);
  if (typeof document === 'undefined') return null;
  return createPortal(
    <AnimatePresence>
      {open ? (
        <motion.div
          key="cloud-welcome" role="dialog" aria-modal="true" aria-label="Your cloud computer"
          className="fixed inset-0 z-[71] flex flex-col overflow-hidden bg-content text-fg"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.25, ease: 'easeOut' }}
        >
          <Flow teamName={(modal ?? last)?.teamName} onClose={ui.closeModal} />
        </motion.div>
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}

function Flow({ teamName, onClose }: { teamName?: string; onClose: () => void }) {
  const view = useCloud((s) => s.view);
  const name = teamName ? computerDisplayName({ team: teamName }) : ownComputerName(view);
  const transfer = useTransfer({ only: worthBringing });
  // a team's computer is shared: nothing of one person's goes there by a default
  const looking = !teamName && !transfer.mac && !transfer.loadError;
  const canTransfer = !teamName && !!transfer.mac?.bots.length;
  const steps: Step[] = ['start', ...(canTransfer ? ['transfer' as const] : []), 'next'];
  const [step, setStep] = useState<Step>(PREVIEW_STEP === 'next' ? 'next' : 'start');
  const [mode, setMode] = useState<Mode>(PREVIEW?.get('cloudmode') === 'both' ? 'both' : 'cloud');
  const [dir, setDir] = useState(1);
  const at = Math.max(0, steps.indexOf(step));
  const goTo = (s: Step) => { setDir(steps.indexOf(s) >= at ? 1 : -1); setStep(s); };
  const next = () => { const to = steps[at + 1]; if (to) goTo(to); else onClose(); };
  const back = at > 0 ? () => goTo(steps[at - 1]!) : undefined;
  // the mocks' `cloudstep=transfer`: on once this Mac's bots are read
  const [jump, setJump] = useState(PREVIEW_STEP === 'transfer');
  useEffect(() => {
    if (!jump || looking) return;
    setJump(false);
    if (canTransfer) setStep('transfer');
  }, [jump, looking, canTransfer]);
  // a step that went away (this Mac's bots couldn't be read after all)
  useEffect(() => { if (!steps.includes(step)) setStep('next'); }, [steps, step]);

  const busy = transfer.running;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented && !busy) { e.preventDefault(); onClose(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  return (
    <>
      {/* beside macOS's traffic lights; Windows and Linux have their window buttons on the right (--wco-right) */}
      <div className="drag relative flex h-16 shrink-0 items-center justify-center">
        <div className={cn('absolute top-5', IS_MAC ? 'left-[97px]' : 'left-5')}><Logo size={24} /></div>
        <Progress at={at + 1} of={steps.length} />
        <div className="absolute top-3.5 right-[calc(14px+var(--wco-right))]">
          <Button variant="ghost" size="icon" className="no-drag" aria-label="Close" disabled={busy} onClick={onClose}><X size={16} /></Button>
        </div>
      </div>
      <AnimatePresence mode="wait" custom={dir} initial={false}>
        <motion.div key={step} custom={dir} variants={SLIDE} initial="enter" animate="center" exit="exit" className="flex min-h-0 flex-1 flex-col">
          {step === 'start' ? <Start name={name} teamName={teamName} looking={looking} choose={canTransfer} mode={mode} onMode={setMode} onNext={() => { if (canTransfer) void setCloudOnly(mode === 'cloud'); next(); }} /> : null}
          {step === 'transfer' ? <TransferStep t={transfer} mode={mode} onNext={() => goTo('next')} onBack={back} /> : null}
          {step === 'next' ? <NextStep onBack={busy ? undefined : back} onClose={onClose} /> : null}
        </motion.div>
      </AnimatePresence>
    </>
  );
}

/** The screens as segments, filled up to this one. */
function Progress({ at, of }: { at: number; of: number }) {
  return (
    <div className="flex items-center gap-1.5" role="progressbar" aria-valuemin={1} aria-valuemax={of} aria-valuenow={at} aria-label={`Step ${at} of ${of}`}>
      {Array.from({ length: of }, (_, k) => (
        <span key={k} className="h-[3px] w-7 overflow-hidden rounded-full bg-surface-3">
          <span className={cn('block h-full origin-left rounded-full bg-fg transition-transform duration-500 ease-reveal', k < at ? 'scale-x-100' : 'scale-x-0')} />
        </span>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ 1: where the bots work */

function Start({ name, teamName, looking, choose, mode, onMode, onNext }: {
  name: string; teamName?: string;
  /** this Mac's bots are still being read */
  looking: boolean;
  /** this Mac has bots to bring: ask where they work */
  choose: boolean;
  mode: Mode; onMode: (m: Mode) => void; onNext: () => void;
}) {
  const title = teamName ? `${name} is ready` : 'Your cloud computer is ready';
  const action = (
    <Button size="xl" variant="primary" iconRight={looking ? undefined : ArrowRight} disabled={looking} onClick={onNext} className="min-w-[150px]" autoFocus>
      {looking ? <><Spinner size={14} />One moment…</> : 'Continue'}
    </Button>
  );
  if (!choose) {
    return (
      <StepShell
        width="sm" title={title} actions={action}
        hero={<div className="mb-7"><CloudTile size={76} team={teamName ?? null} /></div>}
        body={looking ? undefined : teamName ? 'Your team’s bots work here day and night.' : `Your bots work here day and night, even with your ${MACHINE} shut.`}
      />
    );
  }
  return (
    <StepShell width="md" title={title} body="Where should your bots work?" actions={action}>
      <div role="radiogroup" aria-label="Where your bots work" className="mx-auto grid w-full max-w-[640px] grid-cols-2 gap-3">
        <Choice
          on={mode === 'cloud'} onPick={() => onMode('cloud')} tag="Most people pick this"
          icons={<Icon icon={Cloud} size={22} />}
          title="Only in the cloud" line={`Move your bots there. Shut your ${MACHINE} and they keep working.`}
        />
        <Choice
          on={mode === 'both'} onPick={() => onMode('both')}
          icons={<><Icon icon={Cloud} size={22} /><Icon icon={Laptop} size={21} /></>}
          title={`Cloud and this ${MACHINE}`} line="Keep your bots in both places."
        />
      </div>
      <p className="mt-5 text-center text-ui text-muted">Nothing is deleted from your {MACHINE}.</p>
    </StepShell>
  );
}

function Choice({ on, onPick, tag, icons, title, line }: { on: boolean; onPick: () => void; tag?: string; icons: ReactNode; title: string; line: string }) {
  return (
    <button
      type="button" role="radio" aria-checked={on} onClick={onPick}
      className={cn(
        'no-drag relative flex flex-col gap-3 rounded-[20px] border-[1.5px] p-5 text-left focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_var(--ab-ring)]',
        on ? 'border-accent bg-accent-soft' : 'border-[var(--ab-hairline)] bg-surface-2 hover:bg-surface-3',
      )}
    >
      {tag ? <span className="ab-pill squircle absolute -top-2.5 right-4 rounded-[7px] bg-accent px-2.5 py-0.5 text-note font-medium text-white">{tag}</span> : null}
      <div className="flex items-center gap-2">
        <span className={cn('flex h-11 items-center gap-1.5 ab-pill squircle rounded-[12px] px-3', on ? 'bg-accent text-white' : 'bg-surface-3 text-fg-2')}>{icons}</span>
        <span className="flex-1" />
        <TaskCheck checked={on} />
      </div>
      <div>
        <div className="text-title font-semibold text-fg">{title}</div>
        <div className="mt-1 text-copy leading-snug text-fg-2">{line}</div>
      </div>
    </button>
  );
}

/* ------------------------------------------------------------------ 2: move or copy the bots */

const PARTS: { part: BotExportPart; label: string }[] = [
  { part: 'memory', label: 'Memory' },
  { part: 'skills', label: 'Skills' },
  { part: 'files', label: 'Files' },
  { part: 'routines', label: 'Routines' },
  { part: 'chats', label: 'Chats' },
];

/** what a bot holds, in a line: "2 skills · 4 files · 1 routine · 3 chats" */
function holds(item: ExportableBot): string {
  return [
    item.skills.names.length ? plural(item.skills.names.length, 'skill') : '',
    item.files.count ? plural(item.files.count, 'file') : '',
    item.routines.count ? plural(item.routines.count, 'routine') : '',
    item.chats.threads ? plural(item.chats.threads, 'chat') : '',
  ].filter(Boolean).join(' · ');
}

/**
 * After a move: this Mac's routines of the bots that came over are switched off, so the cloud runs them alone. Best
 * effort (one that can't be switched off stays on, and says so in Routines like any other).
 */
async function pauseMacRoutines(items: PlanItem[], states: Record<string, ItemState>): Promise<void> {
  const moved = new Set(items.filter((i) => i.kind === 'bot' && states[i.key]?.status === 'done').map((i) => (i.kind === 'bot' ? i.macBotId : '')));
  if (!moved.size) return;
  try {
    const mac = localGateway();
    const on = (await mac.call('routines.list', {})).filter((r) => r.enabled && moved.has(r.botId));
    await Promise.allSettled(on.map((r) => mac.call('routines.update', { id: r.id, patch: { enabled: false } })));
  } catch { /* this Mac's routines stay as they are */ }
}

function TransferStep({ t, mode, onNext, onBack }: { t: Transfer; mode: Mode; onNext: () => void; onBack?: () => void }) {
  const move = mode === 'cloud';
  const bots = t.mac?.bots ?? [];
  const locked = t.running || !!t.ran;
  const picked = bots.filter((b) => t.pickOf(b.bot.id).selected);
  // a part is on when every bot that comes brings it
  const partOn = (part: BotExportPart) => (picked.length ? picked : bots).every((b) => t.pickOf(b.bot.id).include[part]);
  const setPart = (part: BotExportPart, on: boolean) => { for (const b of bots) t.setPick(b.bot.id, { include: { ...t.pickOf(b.bot.id).include, [part]: on } }); };
  const skills = t.mac?.sharedSkills ?? [];
  const skillsOn = skills.length > 0 && t.shared.names.length === skills.length;
  const count = t.plan?.items.filter((i) => i.kind === 'bot').length ?? 0;
  const groupCount = t.plan?.items.filter((i) => i.kind === 'group').length ?? 0;
  const groupsOn = t.groups.length > 0 && t.groups.every((g) => t.groupPickOf(g.id).selected);
  const allBots = t.all.map((b) => b.bot);
  const came = t.ran?.filter((i) => i.kind === 'bot' && t.states[i.key]?.status === 'done').length ?? 0;
  const done = t.finished && !t.failed.length;
  const run = async (items: PlanItem[]) => {
    const ended = await t.run(items, { routinesOn: move });
    if (move) await pauseMacRoutines(items, ended);
  };
  return (
    <StepShell
      width="md" onBack={locked ? undefined : onBack}
      title={move ? 'Move your bots' : 'Copy your bots'}
      body="They come with everything they know."
      actions={t.finished ? (
        <>
          {t.failed.length ? <Button size="xl" variant="ghost" icon={RotateCw} onClick={() => void run(t.ran!)}>Try again</Button> : null}
          <Button size="xl" variant="primary" iconRight={ArrowRight} onClick={onNext} className="min-w-[140px]" autoFocus>Continue</Button>
        </>
      ) : (
        <>
          {t.running ? null : <Button size="xl" variant="ghost" onClick={onNext}>Not now</Button>}
          <Button size="xl" variant="primary" disabled={t.running || !t.plan?.ready} onClick={() => void run(t.plan!.items)} className="min-w-[170px]" autoFocus>
            {t.running ? <><Spinner size={14} />{move ? 'Moving…' : 'Copying…'}</> : count || groupCount ? `${move ? 'Move' : 'Copy'} ${[count ? plural(count, 'bot') : '', groupCount ? plural(groupCount, 'group') : ''].filter(Boolean).join(' and ')}` : 'Pick a bot'}
          </Button>
        </>
      )}
    >
      <div className="mx-auto flex w-full max-w-[680px] flex-col gap-4">
        <div className="max-h-[296px] overflow-y-auto rounded-[18px] border border-[var(--ab-hairline)] bg-surface-2 [@media(max-height:760px)]:max-h-[200px]">
          {bots.map((item, i) => {
            const pick = t.pickOf(item.bot.id);
            const key = `bot:${item.bot.id}`;
            const ranItem = t.ran?.find((x) => x.key === key);
            const state = ranItem ? t.states[key] : undefined;
            const clash = t.ran ? undefined : findClash(item.bot.name, t.refs);
            const trimmed = t.ran || !pick.selected ? null : trimmedText(item, pick, t.limit, { target: 'your cloud computer', machine: MACHINE });
            return (
              <label key={item.bot.id} className={cn('flex items-center gap-3 px-4 py-3', i > 0 && 'border-t border-[var(--ab-hairline)]', locked ? 'cursor-default' : 'cursor-pointer')}>
                <Tick on={pick.selected} disabled={locked} onChange={(v) => t.setPick(item.bot.id, { selected: v })} label={`Bring ${item.bot.name}`} />
                <BotAvatar figure={figureOf(item)} color={item.bot.color} size={34} still />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-copy font-medium text-fg">{item.bot.name}</div>
                  {state?.status === 'failed' && state.error
                    ? <div className="text-ui leading-snug text-danger">{state.error}</div>
                    : trimmed ? <div className="text-ui leading-snug text-attention">{trimmed}</div>
                    : <div className="truncate text-ui text-muted">{clash ? (pick.selected ? 'Already there. Comes as a copy.' : 'Already there') : holds(item) || item.bot.job || 'A new bot'}</div>}
                </div>
                <div className="shrink-0 text-right text-ui tabular-nums">
                  {ranItem ? <RowStatus state={state} /> : pick.selected ? <span className="text-muted">{size(estimateBytes(item, pick.include))}</span> : null}
                </div>
              </label>
            );
          })}
          {t.groups.map((g) => {
            const key = `group:${g.id}`;
            const on = t.groupPickOf(g.id).selected;
            const ranItem = t.ran?.find((x) => x.key === key);
            const state = ranItem ? t.states[key] : undefined;
            const members = g.botIds.map((id) => allBots.find((b) => b.id === id)).filter((b): b is NonNullable<typeof b> => !!b);
            const held = t.ran ? undefined : t.plan?.held[g.id];
            const line = state?.status === 'failed' && state.error ? state.error : held ?? (!t.ran && findClash(g.name, t.groupRefs) ? (on ? 'Already there. Comes as a copy.' : 'Already there') : `Group · ${listNames(members.map((b) => b.name))}`);
            return (
              <label key={g.id} className={cn('flex items-center gap-3 border-t border-[var(--ab-hairline)] px-4 py-3', locked ? 'cursor-default' : 'cursor-pointer')}>
                <Tick on={on} disabled={locked} onChange={(v) => t.setGroupPick(g.id, v)} label={`Bring ${g.name}`} />
                <GroupMembers members={members} size={34} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-copy font-medium text-fg">{g.name}</div>
                  <div className={cn('text-ui leading-snug', (state?.status === 'failed' && state.error) ? 'text-danger' : held && on ? 'text-attention' : 'truncate text-muted')}>{line}</div>
                </div>
                <div className="shrink-0 text-right text-ui tabular-nums">{ranItem ? <RowStatus state={state} /> : null}</div>
              </label>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-ui text-fg-2">With their</span>
          {PARTS.map((p) => <Chip key={p.part} on={partOn(p.part)} disabled={locked} onChange={(v) => setPart(p.part, v)}>{p.label}</Chip>)}
          {skills.length ? (
            <Chip on={skillsOn} disabled={locked} onChange={(v) => t.setShared((s) => ({ ...s, names: v ? skills.map((k) => k.name) : [] }))}>
              {plural(skills.length, 'shared skill')}
            </Chip>
          ) : null}
          {t.groups.length ? (
            <Chip on={groupsOn} disabled={locked} onChange={(v) => { for (const g of t.groups) t.setGroupPick(g.id, v); }}>
              {plural(t.groups.length, 'group')}
            </Chip>
          ) : null}
        </div>

        {!t.ran && t.plan?.problems.length ? (
          <ul className="flex flex-col gap-1.5">{t.plan.problems.map((p) => <li key={p} className="flex gap-2 text-copy text-danger"><Icon icon={AlertTriangle} size={14} className="mt-0.5 shrink-0" /><span>{p}</span></li>)}</ul>
        ) : null}
        {t.finished ? (
          <div className="flex items-center gap-2 text-copy text-fg">
            <Icon icon={done ? CircleCheck : AlertTriangle} size={16} className={done ? 'text-success' : 'text-attention'} />
            <span>{done ? `${plural(came, 'bot')} ${came === 1 ? 'is' : 'are'} in the cloud now.${move ? ' Routines run there from now on.' : ''}` : `${summaryText(t.ran!, t.states)}.`}</span>
          </div>
        ) : (
          <p className="text-ui leading-normal text-muted">
            {move ? 'Routines run in the cloud from now on.' : 'Routines stay off in the cloud, so nothing runs twice.'} Passwords and sign-ins stay on your {MACHINE}.
          </p>
        )}
      </div>
    </StepShell>
  );
}

/** a row's tick: a square that fills with the accent */
function Tick({ on, disabled, onChange, label }: { on: boolean; disabled?: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <span className="relative flex size-5 shrink-0">
      <input type="checkbox" className="peer absolute inset-0 cursor-[inherit] opacity-0" checked={on} disabled={disabled} onChange={() => onChange(!on)} aria-label={label} />
      <span className={cn('ab-pill flex size-5 items-center justify-center rounded-[7px] border transition-colors peer-focus-visible:shadow-[0_0_0_2px_var(--ab-ring)]', on ? 'border-accent bg-accent text-white' : 'border-[var(--ab-hairline)] bg-transparent text-transparent', disabled && 'opacity-60')}>
        <Check size={13} strokeWidth={2.4} />
      </span>
    </span>
  );
}

/** a part of every bot, ticked or not */
function Chip({ on, disabled, onChange, children }: { on: boolean; disabled?: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <button
      type="button" role="checkbox" aria-checked={on} disabled={disabled} onClick={() => onChange(!on)}
      className={cn(
        'ab-pill squircle flex h-[30px] items-center gap-1.5 rounded-control-sm border pr-2.5 pl-1.5 text-ui focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_var(--ab-ring)] disabled:cursor-default',
        on ? 'border-[color-mix(in_srgb,var(--ab-accent)_45%,transparent)] bg-accent-soft text-fg' : 'border-[var(--ab-hairline)] text-muted hover:text-fg',
      )}
    >
      <TaskCheck checked={on} size={16} />
      {children}
    </button>
  );
}

function RowStatus({ state }: { state?: ItemState }) {
  if (!state || state.status === 'waiting') return <span className="text-muted">Waiting…</span>;
  if (state.status === 'running') return <span className="flex items-center gap-2 text-muted"><Spinner size={13} />{state.step ? STEP_WORDS[state.step] : 'Starting…'}</span>;
  if (state.status === 'done') return <span className="flex items-center gap-1.5 text-fg"><Icon icon={CircleCheck} size={15} className="text-success" />Done</span>;
  if (state.status === 'skipped') return <span className="text-muted">Skipped</span>;
  return <span className="flex items-center gap-1.5 text-danger"><Icon icon={AlertTriangle} size={14} />Failed</span>;
}

/* ------------------------------------------------------------------ 3: a few things left */

function NextStep({ onBack, onClose }: { onBack?: () => void; onClose: () => void }) {
  const bots = useStore((s) => s.bots);
  const [codes, setCodes] = useState(false);
  // the bots cheer once the screen has landed
  const [cheer, setCheer] = useState(0);
  useEffect(() => { const timer = setTimeout(() => setCheer(1), 500); return () => clearTimeout(timer); }, []);
  const go = (open: () => void) => () => { onClose(); open(); };
  // the computer's agent list not read yet (or an older one without them): Settings › Agents instead
  const listsAi = useStore((s) => s.providers.some((p) => p.id === 'claude-code' || p.id === 'codex'));
  return (
    <StepShell
      width="md" onBack={onBack}
      hero={bots.length ? (
        <div className="mb-6 flex items-end justify-center gap-2 [@media(max-height:760px)]:mb-3">
          {bots.slice(0, 5).map((b, i) => <BotAvatar key={b.id} bot={b} size={i === 0 ? 64 : 44} cheerKey={cheer} />)}
        </div>
      ) : undefined}
      title="You’re all set"
      body="A few things left, whenever you like."
      actions={<Button size="xl" variant="primary" iconRight={ArrowRight} onClick={onClose} className="min-w-[170px]" autoFocus>Start chatting</Button>}
    >
      <div className="mx-auto w-full max-w-[560px] overflow-hidden rounded-[18px] border border-[var(--ab-hairline)] bg-surface-2 text-left">
        <NextRow icon={Smartphone} title="Get the phone app" line="Sign in with the same account. Your bots are there.">
          <Button size="sm" variant="secondary" onClick={() => setCodes((v) => !v)}>{codes ? 'Hide' : 'Get it'}</Button>
        </NextRow>
        {codes ? <div className="border-t border-[var(--ab-hairline)] px-4 py-3"><PhoneAppCodes size={84} /></div> : null}
        {/* signed in right here, the AI installed first where missing: never through the computer's screen */}
        <NextRow icon={Blocks} title="Sign in to Claude or ChatGPT" line="So your bots use your own plan here.">
          {listsAi ? (
            <div className="flex items-center gap-2">
              <CloudConnectButton providerId="claude-code" label="Claude" />
              <CloudConnectButton providerId="codex" label="ChatGPT" />
            </div>
          ) : <Button size="sm" variant="secondary" onClick={go(() => ui.openSettings('providers'))}>Sign in</Button>}
        </NextRow>
        <NextRow icon={AppsAdd} title="Connect your apps" line="Gmail, Calendar, Notion and more.">
          <Button size="sm" variant="secondary" onClick={go(() => ui.openApps())}>Connect</Button>
        </NextRow>
        <NextRow icon={Send} title="Set up Telegram" line="Message your bots from anywhere.">
          <Button size="sm" variant="secondary" onClick={go(() => ui.openSettings('channels'))}>Set up</Button>
        </NextRow>
      </div>
    </StepShell>
  );
}

function NextRow({ icon, title, line, children }: { icon: typeof Smartphone; title: string; line: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3.5 border-t border-[var(--ab-hairline)] px-4 py-3 first:border-t-0">
      <span aria-hidden className="ab-pill flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-surface-3 text-fg-2"><Icon icon={icon} size={17} /></span>
      <div className="min-w-0 flex-1">
        <div className="text-copy font-medium text-fg">{title}</div>
        <div className="text-ui leading-snug text-muted">{line}</div>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
