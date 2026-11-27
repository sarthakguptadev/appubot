/**
 * The model picker (Synara's, built from its description): agent, model and reasoning effort in one popover, used by
 * the composer (the running thread), the bot editor (that bot's) and Settings › General (new bots'). Tabs for the
 * favourites and each usable agent (profiles are agents of their own; a tab only browses, picking a model there
 * selects its agent too), a search, the tab's models (⌘1…⌘9 pick the first nine, ☆ marks a favourite) and, when the
 * chosen agent offers efforts, the effort on Settings' slider with a reset to the context's default. Where fast mode
 * applies (Claude Code), a ⚡ toggle sits at the left of the effort row.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Provider } from '@appubot/protocol';
import { agentChoices, modelDisplayName } from '@appubot/protocol';
import { giftModelName, agentLimits, modelRowLimits, planLine, limitsForModel, modelLimitText, providerInitials, providerLogin, providerMark, formatTokens, type ModelLimits } from '@appubot/chat-core';
import { Check, ChevronDown, ChevronLeft, ChevronRight, Search, Star, Undo, Zap } from '../../components/ui/icons';
import { FIELD_CLASS, Icon, Popover, Spinner, cn } from '../../components/ui';
import { shortcut } from '../../lib/platform';
import { useStore } from '../../lib/store';
import { ProviderLogo, RegistryIcon } from './providerLogos';
import { fetchedChoices, prefetchChoices, useChoices } from './useChoices';
import { ModelLimitBadge, ModelLimitsCard, PlanLineRow, TONE_TEXT } from './LimitMeter';
import { refreshLimits, useNow } from './useLimits';

type Option = { id: string; name: string; description?: string };
export interface ModelPick { providerId?: string; modelId?: string; effort?: string; fast?: boolean }

/* ---------- agents ---------- */

type Agent = Pick<Provider, 'id' | 'name'> & Partial<Provider>;

/** An agent's mark: its logo, a registry agent's icon, else its initials. */
export function AgentGlyph({ agent, size = 15, className }: { agent: Agent; size?: number; className?: string }) {
  if (providerMark(agent.id)) return <ProviderLogo id={agent.id} size={size} className={cn('text-fg', className)} />;
  if (agent.iconSvg) return <RegistryIcon svg={agent.iconSvg} size={size} className={cn('text-fg', className)} />;
  return <span className={cn('inline-flex shrink-0 items-center justify-center text-[9px] font-semibold text-fg-2', className)} style={{ width: size, height: size }}>{providerInitials(agent.name)}</span>;
}

/** Whether an agent shows a profile name: it is a profile, or a built-in that has some. */
function hasProfiles(a: Agent, all: readonly Provider[]): boolean {
  return !!a.profile || all.some((p) => p.profile?.of === a.id);
}

/** The profile's name ("sarthakfour", "Main") for an agent with profiles, else ''. */
export function profileLabel(a: Agent, all: readonly Provider[]): string {
  if (!hasProfiles(a, all)) return '';
  return a.profile?.name ?? a.profileName ?? 'Main';
}

/** "Claude Code · sarthakfour", "Codex", plus why it may not work yet ("Not logged in", "Off"). */
function agentTitle(a: Agent, all: readonly Provider[]): string {
  const base = a.profile ? all.find((p) => p.id === a.profile!.of)?.name ?? a.name.split(' · ')[0] : a.name;
  const prof = profileLabel(a, all);
  const name = prof ? `${base} · ${prof}` : a.name;
  if (a.installed === undefined) return name;
  const v = providerLogin(a as Provider);
  const why = v.kind === 'not_installed' || v.kind === 'logged_out' ? v.label : a.enabled === false ? 'Off' : '';
  return why ? `${name} (${why})` : name;
}

/** The agents to pick from: installed and switched on, plus the current one. */
function useAgents(current: string, all: boolean): Agent[] {
  const providers = useStore((s) => s.providers);
  return useMemo(() => {
    const list: Agent[] = all ? providers.filter((p) => (p.installed && p.enabled) || p.id === current) : providers.filter((p) => p.id === current);
    if (current && !list.some((p) => p.id === current)) list.unshift({ id: current, name: current });
    return list;
  }, [providers, current, all]);
}

/* ---------- favourites ---------- */

const FAV_KEY = 'appubot.modelFavorites';
const favKey = (providerId: string, modelId: string) => `${providerId}::${modelId}`;
const readFavs = (): string[] => {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(FAV_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.includes('::')) : [];
  } catch { return []; }
};
let favs = readFavs();
const favSubs = new Set<() => void>();
function toggleFav(key: string): void {
  favs = favs.includes(key) ? favs.filter((k) => k !== key) : [...favs, key];
  try { localStorage.setItem(FAV_KEY, JSON.stringify(favs)); } catch { /* private mode: this session only */ }
  favSubs.forEach((f) => f());
}
function useFavorites(): string[] {
  return useSyncExternalStore((f) => { favSubs.add(f); return () => favSubs.delete(f); }, () => favs);
}

/* ---------- the effort ---------- */

/** Fast mode's ⚡: the accent on a soft accent wash when on, muted when off; as tall as the reset beside the slider. */
function FastToggle({ on, onToggle }: { on: boolean; onToggle: (next: boolean) => void }) {
  return (
    <button
      type="button"
      aria-label="Fast mode"
      aria-pressed={on}
      title={on ? 'Fast mode on' : 'Fast mode off'}
      onClick={() => onToggle(!on)}
      className={cn(
        'ab-pill rounded-md p-1 outline-none focus-visible:shadow-[0_0_0_2px_var(--ab-ring)]',
        on ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-surface-2 hover:text-fg',
      )}
    >
      <Icon icon={Zap} size={13} className={on ? '[&_path]:fill-current' : undefined} />
    </button>
  );
}

/**
 * The effort row: its level in the accent, a reset to the context's default, and Settings' own slider (`Slider`, the
 * same drag bar as Window translucency), one step per level. Dragging shows the level as it goes and picks it on
 * release; ←/→ step.
 */
/**
 * The effort track (Synara's): a rounded bar with a dot at every level, filled in the accent up to a white knob on
 * the chosen one. Click or drag to a level (it snaps), or ←/→ when focused; the pick lands on release.
 */
function EffortTrack({ count, value, disabled, onDraft, onCommit, label, valueText }: {
  count: number; value: number; disabled: boolean; onDraft: (i: number | null) => void; onCommit: (i: number) => void; label: string; valueText: string;
}) {
  const bar = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const stops = Math.max(count, 2);
  const KNOB = 28;
  // stop i sits at a fraction of the bar's inner width (the knob never leaves the bar)
  const at = (i: number) => `calc(${KNOB / 2}px + (100% - ${KNOB}px) * ${i / (stops - 1)})`;
  const stopAt = (clientX: number): number => {
    const r = bar.current!.getBoundingClientRect();
    const f = (clientX - r.left - KNOB / 2) / Math.max(1, r.width - KNOB);
    return Math.min(count - 1, Math.max(0, Math.round(f * (stops - 1))));
  };
  const onDown = (e: React.PointerEvent) => {
    if (disabled) return;
    dragging.current = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    onDraft(stopAt(e.clientX));
  };
  const onMove = (e: React.PointerEvent) => { if (dragging.current) onDraft(stopAt(e.clientX)); };
  const onUp = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    dragging.current = false;
    onCommit(stopAt(e.clientX));
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const next = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? value + 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? value - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? count - 1 : null;
    if (next === null) return;
    e.preventDefault();
    onCommit(Math.min(count - 1, Math.max(0, next)));
  };
  return (
    <div
      ref={bar}
      role="slider"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={Math.max(count - 1, 0)}
      aria-valuenow={value}
      aria-valuetext={valueText}
      aria-disabled={disabled || undefined}
      tabIndex={disabled ? -1 : 0}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={() => { dragging.current = false; onDraft(null); }}
      onKeyDown={onKey}
      className={cn(
        'relative mt-2 h-7 w-full touch-none rounded-full bg-[color-mix(in_srgb,var(--ab-fg)_10%,transparent)] outline-none select-none',
        'focus-visible:shadow-[0_0_0_2px_var(--ab-ring)]',
        disabled ? 'opacity-45' : 'cursor-pointer',
      )}
    >
      {/* the accent fill, from the left edge to the knob's centre */}
      {!disabled ? <span aria-hidden className="absolute inset-y-0 left-0 rounded-full bg-accent transition-[width] duration-150 ease-out" style={{ width: `calc(${at(value)} + ${KNOB / 2}px)` }} /> : null}
      {Array.from({ length: stops }, (_, i) => (
        <span
          key={i}
          aria-hidden
          className={cn('absolute top-1/2 size-[5px] -translate-x-1/2 -translate-y-1/2 rounded-full', !disabled && i < value ? 'bg-white/70' : 'bg-[color-mix(in_srgb,var(--ab-fg)_35%,transparent)]')}
          style={{ left: at(i) }}
        />
      ))}
      {!disabled ? (
        <span
          aria-hidden
          className="absolute top-1/2 size-7 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[0_0_0_0.5px_rgba(0,0,0,0.12),0_1px_4px_rgba(0,0,0,0.3)] transition-[left] duration-150 ease-out"
          style={{ left: at(value) }}
        />
      ) : null}
    </div>
  );
}

function EffortFooter({ efforts, value, defaultEffort, onPick, fast }: {
  efforts: Option[]; value: string; defaultEffort: string; onPick: (id: string) => void;
  /** fast mode's toggle, where it applies */
  fast?: { on: boolean; onToggle: (next: boolean) => void };
}) {
  const at = Math.max(efforts.findIndex((e) => e.id === value), 0);
  const [draft, setDraft] = useState<number | null>(null);
  const shown = draft ?? at;
  // an agent without a choice of effort keeps the same footer, still, so the panel never changes height
  const none = efforts.length < 2;
  const name = none ? 'Set by the model' : draft !== null ? efforts[draft]?.name : efforts.find((e) => e.id === value)?.name ?? value;
  const resettable = value !== defaultEffort && efforts.some((e) => e.id === defaultEffort);
  const defaultName = efforts.find((e) => e.id === defaultEffort)?.name ?? defaultEffort;
  const commit = (i: number) => {
    setDraft(null);
    const e = efforts[i];
    if (e && e.id !== value) onPick(e.id);
  };
  return (
    <div className="hairline-t px-3 pt-2 pb-2.5">
      <div className="grid grid-cols-[1fr_auto_1fr] items-center">
        <span className="flex min-w-0 items-center gap-1.5">
          {fast ? <FastToggle on={fast.on} onToggle={fast.onToggle} /> : null}
          <span className="text-note text-muted">Effort</span>
        </span>
        <span className={cn('text-ui font-medium', none ? 'text-muted' : 'text-accent')}>{name}</span>
        <button
          type="button"
          aria-label={`Reset effort to ${defaultName}`}
          title={resettable ? `Back to ${defaultName}` : undefined}
          disabled={none || !resettable}
          onClick={() => onPick(defaultEffort)}
          className="ab-pill justify-self-end rounded-md p-1 text-muted outline-none hover:bg-surface-2 hover:text-fg focus-visible:shadow-[0_0_0_2px_var(--ab-ring)] disabled:pointer-events-none disabled:opacity-35"
        >
          <Icon icon={Undo} size={13} />
        </button>
      </div>
      <EffortTrack count={efforts.length} value={shown} disabled={none} onDraft={setDraft} onCommit={commit} label="Reasoning effort" valueText={name ?? ''} />
    </div>
  );
}

/* ---------- the picker ---------- */

const FAVS = '__favourites';

/** the `unset` row's key */
const UNSET_KEY = '__unset__';

interface Row { key: string; providerId: string; modelId: string; name: string; description?: string; isDefault?: boolean }

/** how long the pointer rests on a row before its limits card shows */
const HOVER_CARD_MS = 300;

/** The chrome trigger (the composer's footer, beside send): 28px with 12px labels that brighten on hover. */
export const CHROME_TRIGGER = cn(
  'ab-pill squircle inline-flex h-7 max-w-full min-w-0 items-center gap-1.5 overflow-hidden rounded-control-sm px-2.5 text-note whitespace-nowrap text-muted',
  'hover:bg-surface-2 hover:text-fg focus-visible:bg-surface-2 focus-visible:outline-none aria-expanded:bg-surface-2 aria-expanded:text-fg',
);
/**
 * The field trigger (bot editor, Settings): the app's input as a pill, its choice from the left, the chevron at the
 * end. It fills its wrapper; a wrapper of auto width (Settings' rows) makes it hug what it says.
 */
export const FIELD_TRIGGER = cn(FIELD_CLASS, 'ab-pill flex h-9 w-full min-w-0 items-center gap-2 overflow-hidden rounded-control ps-3 pe-2.5 text-left whitespace-nowrap');

/**
 * The agents' tab row: it scrolls sideways when the tabs don't fit, with an arrow at the end that has more (shown on
 * hover, over a fade), and keeps the open tab in view.
 */
function TabStrip({ active, children }: { active: string; children: ReactNode }) {
  const row = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState({ left: false, right: false });
  const measure = () => {
    const el = row.current;
    if (el) setMore({ left: el.scrollLeft > 2, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 2 });
  };
  useLayoutEffect(() => {
    row.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    measure();
  }, [active]);
  useEffect(() => {
    const el = row.current;
    if (!el) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const scroll = (dir: -1 | 1) => row.current?.scrollBy({ left: dir * 140, behavior: 'smooth' });
  const ARROW = 'absolute top-1.5 bottom-0 z-10 flex w-9 items-center opacity-0 transition-opacity duration-150 group-hover/tabs:opacity-100 focus-visible:opacity-100';
  return (
    <div className="group/tabs hairline-b relative shrink-0">
      <div ref={row} role="tablist" aria-label="Agents" onScroll={measure} className="flex items-stretch gap-0.5 overflow-x-auto px-1.5 pt-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {children}
      </div>
      {more.left ? (
        <button type="button" aria-label="Scroll agents left" onClick={() => scroll(-1)} className={cn(ARROW, 'left-0 justify-start bg-[linear-gradient(to_right,var(--ab-popover)_55%,transparent)] pl-1')}>
          <span className="flex size-6 items-center justify-center rounded-full text-fg-2 hover:bg-surface-2 hover:text-fg"><Icon icon={ChevronLeft} size={14} /></span>
        </button>
      ) : null}
      {more.right ? (
        <button type="button" aria-label="Scroll agents right" onClick={() => scroll(1)} className={cn(ARROW, 'right-0 justify-end bg-[linear-gradient(to_left,var(--ab-popover)_55%,transparent)] pr-1')}>
          <span className="flex size-6 items-center justify-center rounded-full text-fg-2 hover:bg-surface-2 hover:text-fg"><Icon icon={ChevronRight} size={14} /></span>
        </button>
      ) : null}
    </div>
  );
}

export function ModelPicker({
  context, providerId, modelId, effort, defaultEffort, onChange, models: ownModels, efforts: ownEfforts, fast = false, fastAvailable = false, contextSize,
  allowAgentSwitch = true, variant = context === 'thread' ? 'chrome' : 'field', side = context === 'thread' ? 'top' : 'bottom',
  align = context === 'thread' ? 'end' : 'start', label = 'Model', className, unset,
}: {
  /**
   * A choice of "no pick here" above every agent's models (a group's "Each bot's own"): `on` while nothing is picked,
   * when the trigger reads `label`; choosing it calls `onReset`.
   */
  unset?: { label: string; on: boolean; onReset: () => void };
  /** the running thread (composer), a bot's defaults (editor) or new bots' (Settings): only the latter two offer "Agent's default" */
  context: 'thread' | 'bot' | 'defaults';
  providerId: string;
  /** '' is the agent's own default */
  modelId: string;
  effort: string;
  /** what the effort's reset goes back to */
  defaultEffort: string;
  onChange: (next: ModelPick) => void;
  /** the thread's own lists for its agent (the composer); otherwise read with `useChoices` */
  models?: Option[];
  efforts?: Option[];
  /** fast mode is on (shown, as a ⚡ in the effort row, only when `fastAvailable`) */
  fast?: boolean;
  /** fast mode applies here: the thread's model offers it (composer), or the agent is Claude Code (editor, Settings) */
  fastAvailable?: boolean;
  /** the chat's context window in tokens (the composer's "(1M)"), when its agent said */
  contextSize?: number;
  allowAgentSwitch?: boolean;
  variant?: 'chrome' | 'field';
  side?: 'top' | 'bottom';
  align?: 'start' | 'end';
  label?: string;
  className?: string;
}) {
  const providers = useStore((s) => s.providers);
  const threads = useStore((s) => s.threads);
  const allLimits = useStore((s) => s.limits);
  const agents = useAgents(providerId, allowAgentSwitch);
  const agent = agents.find((a) => a.id === providerId) ?? { id: providerId, name: providerId };
  const current = useChoices(providerId, !ownModels);
  const curModels = ownModels ?? current.models;
  const curEfforts = ownEfforts ?? current.efforts;
  const withDefault = context !== 'thread';

  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState(providerId);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const anchor = useRef<HTMLSpanElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const favorites = useFavorites();

  const browsing = tab !== FAVS && tab !== providerId;
  const other = useChoices(browsing ? tab : '', open && browsing);

  const nameOf = (pid: string, mid: string): string => {
    const known = pid === providerId ? curModels : agentChoices(threads, pid).models.length ? agentChoices(threads, pid).models : fetchedChoices.get(pid)?.models ?? [];
    return known.find((m) => m.id === mid)?.name ?? giftModelName(providers.find((a) => a.id === pid)) ?? modelDisplayName(mid);
  };

  const rows = useMemo<Row[]>(() => {
    let out: Row[];
    if (tab === FAVS) {
      out = favorites.flatMap((k) => {
        const i = k.indexOf('::');
        const pid = k.slice(0, i), mid = k.slice(i + 2);
        return agents.some((a) => a.id === pid) ? [{ key: k, providerId: pid, modelId: mid, name: nameOf(pid, mid) }] : [];
      });
    } else {
      const models = tab === providerId ? curModels : other.models;
      out = models.map((m) => ({ key: favKey(tab, m.id), providerId: tab, modelId: m.id, name: m.name, ...(m.description ? { description: m.description } : {}) }));
      // a model the agent no longer lists stays visible while it is the current one
      if (tab === providerId && modelId && !models.some((m) => m.id === modelId)) out.unshift({ key: favKey(tab, modelId), providerId: tab, modelId, name: giftModelName(providers.find((a) => a.id === tab)) ?? modelDisplayName(modelId) });
      if (withDefault) out.unshift({ key: favKey(tab, ''), providerId: tab, modelId: '', name: "Agent's default", isDefault: true });
      if (unset) out.unshift({ key: UNSET_KEY, providerId: tab, modelId: '', name: unset.label, isDefault: true });
    }
    const q = query.trim().toLowerCase();
    return q ? out.filter((r) => r.name.toLowerCase().includes(q) || r.modelId.toLowerCase().includes(q)) : out;
  }, [tab, favorites, agents, providerId, curModels, other.models, modelId, withDefault, query, threads, unset?.label]);
  const loading = tab !== FAVS && (tab === providerId ? !ownModels && current.loading : other.loading);

  const isCurrent = (r: Row) => (r.key === UNSET_KEY ? !!unset?.on : !unset?.on && r.providerId === providerId && r.modelId === modelId);

  /* plan limits: what's left of each agent's subscription, per model (features/providers/useLimits.ts) */
  const now = useNow(30_000);
  const limitsOf = (pid: string) => allLimits.find((l) => l.providerId === pid);
  const rowLimits = (r: Row): ModelLimits | undefined => (r.isDefault && !r.description ? undefined : limitsForModel(limitsOf(r.providerId), { id: r.modelId || 'default', name: r.name, description: r.description }, now));
  const [hoverCard, setHoverCard] = useState<{ key: string; top: number; left: number; right: boolean } | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelHover = () => { if (hoverTimer.current) clearTimeout(hoverTimer.current); hoverTimer.current = null; };
  const armHover = (r: Row, el: HTMLElement) => {
    cancelHover();
    if (!rowLimits(r)) { setHoverCard(null); return; }
    hoverTimer.current = setTimeout(() => {
      const rect = el.getBoundingClientRect();
      // the card sits beside the panel, on the side with room
      const right = rect.left < 320;
      setHoverCard({ key: r.key, top: rect.top, left: right ? rect.right + 8 : rect.left - 8, right });
    }, HOVER_CARD_MS);
  };
  useEffect(() => { if (!open) { cancelHover(); setHoverCard(null); } }, [open]);
  useEffect(() => { setHoverCard(null); }, [tab, query]);

  // it opens on the current agent's tab, with the current model active
  const toggle = () => {
    if (open) return setOpen(false);
    setTab(providerId);
    setQuery('');
    // every tab's models, now: the Mac answers from its saved lists, so browsing tabs doesn't wait
    prefetchChoices(agents.map((a) => a.id).filter((id) => !agentChoices(threads, id).models.length));
    // and the plans' limits, where the computer's copy is over 5 min old
    void refreshLimits('stale');
    setOpen(true);
  };
  useEffect(() => {
    if (!open) return;
    const i = rows.findIndex(isCurrent);
    setActive(i >= 0 && !query ? i : 0);
  }, [open, tab, query, rows.length]);
  // the pointer never moves `active`: only the arrow keys do, so hovering neither highlights a row nor scrolls the list
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-row="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open, tab]);

  const choose = (r: Row) => {
    setOpen(false);
    if (r.key === UNSET_KEY) { if (!unset?.on) unset?.onReset(); return; }
    // from "no pick" to a pick: the agent and model both, even on the agent shown
    if (unset?.on) { onChange({ providerId: r.providerId, modelId: r.modelId }); return; }
    if (r.providerId !== providerId) onChange({ providerId: r.providerId, modelId: r.modelId });
    else if (r.modelId !== modelId) onChange({ modelId: r.modelId });
  };

  // ⌘1…⌘9 pick a row while the panel is open (ahead of the app's ⌘n bot shortcuts)
  const latest = useRef({ rows, choose });
  latest.current = { rows, choose };
  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || !/^[1-9]$/.test(e.key)) return;
      e.preventDefault(); e.stopPropagation();
      const r = latest.current.rows[Number(e.key) - 1];
      if (r) latest.current.choose(r);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);

  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => (rows.length ? (a + 1) % rows.length : 0)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => (rows.length ? (a - 1 + rows.length) % rows.length : 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); const r = rows[active]; if (r) choose(r); }
  };

  const tabs: (Agent | typeof FAVS)[] = [FAVS, ...agents];
  const hasPlanLine = tab !== FAVS && !!planLine(limitsOf(tab), now);

  /* trigger */
  const curModel = curModels.find((m) => m.id === modelId);
  // the agent's own name for it, else a Claude id read as a name ("claude-haiku-5-5" → "Haiku 5.5"), never the raw id
  const modelName = modelId ? curModel?.name ?? giftModelName(agent) ?? modelDisplayName(modelId) : withDefault ? "Agent's default" : curModels[0]?.name ?? '';
  const effortName = curEfforts.find((e) => e.id === effort)?.name ?? '';
  const effortText = [effortName, fastAvailable && fast ? 'Fast' : ''].filter(Boolean).join(' · ');
  const prof = profileLabel(agent, providers);
  // what's left for this model, only when it matters: "· 18% left" in amber at 20% or under, "· back in 47m" in red
  const curLimits = modelId || context === 'thread' ? limitsForModel(limitsOf(providerId), { id: modelId || curModels[0]?.id || 'default', name: modelName, description: curModel?.description }, now) : undefined;
  const limitSuffix = curLimits && curLimits.tone !== 'ok' ? (curLimits.tone === 'out' ? modelLimitText(curLimits, now).replace(/^Back/, 'back').replace(/^Used/, 'used') : curLimits.tone === 'extra' ? 'extra usage' : `${curLimits.left}% left`) : '';
  // When room runs short only the profile's name gives way (it truncates, and a narrow chat hides it, then the context
  // size and the effort); the model's name never shrinks: it is what the trigger is for. A very long custom model id is
  // the one exception, capped so it can't push everything else out.
  const content: ReactNode = unset?.on ? (
    <>
      <span className="shrink-0 text-fg">{unset.label}</span>
      <Icon icon={ChevronDown} size={variant === 'chrome' ? 12 : 14} className={cn('shrink-0 text-muted', variant === 'chrome' ? 'ms-0.5 opacity-70' : 'ms-auto')} />
    </>
  ) : (
    <>
      <AgentGlyph agent={agent} size={variant === 'chrome' ? 14 : 15} className="shrink-0" />
      {prof ? <span className={cn('max-w-[10rem] min-w-0 truncate text-muted', variant === 'chrome' && '@max-[34rem]:hidden')}>{prof}</span> : null}
      {modelName ? <span className={cn('max-w-[16rem] shrink-0 truncate', variant === 'chrome' ? 'text-fg' : modelId ? 'text-fg' : 'text-fg-2')}>{modelName}</span> : null}
      {effortText ? <span className={cn('shrink-0 text-muted', variant === 'chrome' && '@max-[24rem]:hidden')}>{effortText}</span> : null}
      {contextSize ? <span className={cn('shrink-0 text-muted opacity-80', variant === 'chrome' && '@max-[30rem]:hidden')}>({formatTokens(contextSize)})</span> : null}
      {limitSuffix && curLimits ? <span className={cn('shrink-0', TONE_TEXT[curLimits.tone])}>· {limitSuffix}</span> : null}
      <Icon icon={ChevronDown} size={variant === 'chrome' ? 12 : 14} className={cn('shrink-0 text-muted', variant === 'chrome' ? 'ms-0.5 opacity-70' : 'ms-auto')} />
    </>
  );
  const fullTitle = [agentTitle(agent, providers), modelName, effortText, contextSize ? `(${formatTokens(contextSize)})` : '', curLimits ? modelLimitText(curLimits, now).replace(/^(\d+)%$/, '$1% left') : ''].filter(Boolean).join(' · ');

  return (
    <>
      <span ref={anchor} className={cn('inline-flex min-w-0', variant === 'field' && 'w-full', className)}>
        <button
          type="button"
          aria-label={label}
          aria-haspopup="dialog"
          aria-expanded={open}
          title={fullTitle}
          onClick={toggle}
          className={variant === 'chrome' ? CHROME_TRIGGER : FIELD_TRIGGER}
        >
          {content}
        </button>
      </span>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} side={side} align={align} label={label} className="squircle w-[320px] rounded-card">
        {/* agents (and the favourites) */}
        <TabStrip active={tab}>
          {tabs.map((t) => {
            const id = t === FAVS ? FAVS : t.id;
            const on = tab === id;
            const name = t === FAVS ? 'Favourites' : agentTitle(t, providers);
            const short = t === FAVS ? 'Favourites' : profileLabel(t, providers) || t.name;
            // an amber dot on an agent at 20% or less, red when something of it is used up
            const dot = t === FAVS ? undefined : agentLimits(limitsOf(t.id), now)?.tone;
            return (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={on}
                aria-label={name}
                title={name}
                onClick={() => { setTab(id); setQuery(''); }}
                className={cn(
                  'relative flex h-8 min-w-8 shrink-0 items-center justify-center gap-1.5 rounded-t-lg px-2 text-note outline-none focus-visible:bg-surface-2',
                  on ? 'text-fg' : 'text-muted hover:bg-surface-2 hover:text-fg',
                )}
              >
                {t === FAVS ? <Icon icon={Star} size={14} className={cn(on && 'text-accent [&_path]:fill-current')} /> : <AgentGlyph agent={t} size={14} className={on ? undefined : 'opacity-80'} />}
                {on ? <span className="max-w-[120px] truncate font-medium">{short}</span> : null}
                {dot && dot !== 'ok' ? <span aria-label={dot === 'out' ? 'Used up' : 'Running low'} className={cn('absolute top-1 right-1 size-1.5 rounded-full', dot === 'out' ? 'bg-danger' : 'bg-attention')} /> : null}
                {on ? <span aria-hidden className="absolute inset-x-1.5 bottom-0 h-0.5 rounded-full bg-accent" /> : null}
              </button>
            );
          })}
        </TabStrip>
        {/* the plan's shared windows, for agents with limits (the list gives up its room: see below) */}
        {hasPlanLine ? <PlanLineRow limits={limitsOf(tab)} now={now} className="hairline-b" /> : null}

        <div className="flex shrink-0 items-center gap-2 px-3 pt-2 pb-1">
          <Icon icon={Search} size={14} className="shrink-0 text-muted" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onSearchKey}
            placeholder="Search models…"
            aria-label="Search models"
            className="h-7 min-w-0 flex-1 bg-transparent text-copy text-fg outline-none placeholder:text-muted"
          />
        </div>

        {/* one fixed height, whatever the tab, the plan line, the search or the loading: the panel never jumps */}
        <div ref={list} role="listbox" aria-label="Models" className={cn(hasPlanLine ? 'h-[214px]' : 'h-[244px]', 'min-h-0 overflow-y-auto overscroll-contain px-1.5 pb-1.5')}>
          {rows.map((r, i) => {
            const fav = favorites.includes(r.key);
            const cur = isCurrent(r);
            const rowAgent = tab === FAVS ? agents.find((a) => a.id === r.providerId) : undefined;
            const lim = rowLimits(r);
            // the tab's plan line says what every model shares: a row's meter only where its own window says more (none on Favourites)
            const badge = tab === FAVS ? lim : modelRowLimits(limitsOf(r.providerId), lim, now);
            return (
              <div
                key={r.key}
                data-row={i}
                role="option"
                aria-selected={cur}
                onMouseEnter={(e) => armHover(r, e.currentTarget)}
                onMouseLeave={() => { cancelHover(); setHoverCard((h) => (h?.key === r.key ? null : h)); }}
                onClick={() => choose(r)}
                className={cn(
                  'group/row ab-pill squircle flex h-9 cursor-default items-center gap-2 rounded-control-sm pr-1 pl-2.5 text-copy',
                  i === active ? 'bg-[color-mix(in_srgb,var(--ab-fg)_8%,transparent)]' : cur ? 'bg-[color-mix(in_srgb,var(--ab-fg)_4%,transparent)]' : '',
                )}
              >
                {rowAgent ? <span title={agentTitle(rowAgent, providers)} className="inline-flex"><AgentGlyph agent={rowAgent} size={14} /></span> : null}
                <span className={cn('min-w-0 flex-1 truncate', r.isDefault ? 'text-fg-2' : 'text-fg', cur && 'font-medium', lim?.tone === 'out' && 'opacity-60')}>{r.name}</span>
                {badge ? <ModelLimitBadge limits={badge} now={now} /> : null}
                {cur ? <Icon icon={Check} size={14} className="shrink-0 text-accent" /> : null}
                {i < 9 ? <kbd className="shrink-0 rounded-[5px] bg-[color-mix(in_srgb,var(--ab-fg)_6%,transparent)] px-1 font-sans text-[11px] leading-[16px] text-muted">{shortcut(String(i + 1))}</kbd> : null}
                {r.isDefault ? <span className="size-6 shrink-0" /> : (
                  <button
                    type="button"
                    aria-label={fav ? `Remove ${r.name} from favourites` : `Add ${r.name} to favourites`}
                    aria-pressed={fav}
                    onClick={(e) => { e.stopPropagation(); toggleFav(r.key); }}
                    className={cn(
                      'ab-pill flex size-6 shrink-0 items-center justify-center rounded-md transition-[opacity,color] outline-none hover:text-fg focus-visible:opacity-100',
                      // always shown, as in Synara: muted, the favourites filled in the accent
                      fav ? 'text-accent' : 'text-muted/70 hover:text-fg',
                    )}
                  >
                    <Icon icon={Star} size={13} className={fav ? '[&_path]:fill-current' : undefined} />
                  </button>
                )}
              </div>
            );
          })}
          {!rows.length ? (
            <div className="flex h-full items-center justify-center gap-2 px-3 text-center text-ui text-muted">
              {loading ? <><Spinner size={12} /> Loading models…</>
                : query ? 'No models match.'
                  : tab === FAVS ? 'Star a model to keep it here.'
                    : 'This agent lists no models.'}
            </div>
          ) : loading ? (
            <div className="flex h-8 items-center gap-2 px-2.5 text-ui text-muted"><Spinner size={12} /> Loading models…</div>
          ) : null}
        </div>

        {/* the windows that count the hovered model */}
        {hoverCard ? (() => {
          const r = rows.find((x) => x.key === hoverCard.key);
          const lim = r && rowLimits(r);
          const l = r && limitsOf(r.providerId);
          if (!r || !lim || !l) return null;
          const a = agents.find((x) => x.id === r.providerId);
          return createPortal(
            <ModelLimitsCard
              title={`${r.name} · ${modelLimitText(lim, now).replace(/^(\d+)%$/, '$1% left')}`}
              subtitle={[a ? agentTitle(a, providers) : r.providerId, l.plan].filter(Boolean).join(' · ')}
              limits={l}
              model={lim}
              now={now}
              className="fixed z-[80]"
              style={{ top: Math.max(8, Math.min(hoverCard.top - 12, window.innerHeight - 320)), ...(hoverCard.right ? { left: hoverCard.left } : { left: hoverCard.left, transform: 'translateX(-100%)' }) }}
            />,
            document.body,
          );
        })() : null}

        <EffortFooter
          efforts={curEfforts}
          value={effort}
          defaultEffort={defaultEffort}
          onPick={(e) => onChange({ effort: e })}
          fast={fastAvailable ? { on: fast, onToggle: (next) => onChange({ fast: next }) } : undefined}
        />
      </Popover>
    </>
  );
}
