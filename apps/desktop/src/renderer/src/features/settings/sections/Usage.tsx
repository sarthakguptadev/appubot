import { useEffect, useMemo, useState } from 'react';
import { USAGE_RANGES, agentDisplayName, agentLimits, cacheHitRate, clockHours, extraUsageText, formatTokens, formatUsd, intlLocale, limitsSourcesText, limitsStatusText, updatedAgoText, usageSourceNames } from '@appubot/chat-core';
import type { ProviderLimits, UsageBucket, UsageRange, UsageSummary, UsageTotals } from '@appubot/protocol';
import { agentChoices, providerBase } from '@appubot/protocol';
import { RefreshCw } from '../../../components/ui/icons';
import { Button, Tooltip, cn } from '../../../components/ui';
import { RollingText } from '../../../components/rare/AnimatedCounter';
import { GitHubActivity, type ActivityDay } from '../../../components/rare/GitHubActivity';
import { call } from '../../../lib/actions';
import { rpc } from '../../../lib/gateway';
import { remember, useRemembered } from '../../../lib/remembered';
import { THIS_MACHINE } from '../../../lib/platform';
import { useThisComputer } from '../../cloud/thisComputer';
import { useStore } from '../../../lib/store';
import { AgentGlyph } from '../../providers/ModelPicker';
import { ProviderLogo } from '../../providers/providerLogos';
import { LimitMeter, LimitWindowRow, TONE_TEXT } from '../../providers/LimitMeter';
import { fetchedChoices } from '../../providers/useChoices';
import { refreshLimits, useAllLimits, useNow } from '../../providers/useLimits';
import { USAGE_ACTIVITY_TITLE, USAGE_BY_AGENT_TITLE, USAGE_BY_MODEL_TITLE, USAGE_LIMITS_TITLE, USAGE_TITLE } from '../nav';
import { ACTIVITY_KEY, activityDays, dayKey, mergeDays, readLedger } from './usageActivity';
import { SETTINGS_ROW, SettingsCard, SettingsEmptyState, SettingsGroup, SettingsSegmented, SectionLoading } from './shared';

/*
 * Settings › Usage (T3 Code's Usage page, smaller): how much the bots used their agents (only requests run in a bot's
 * folder: `scope: 'bots'`), from the agents' own
 * history (`usage.summary`), with what it would have cost at API prices. Three numbers, a bar per hour or day, then
 * the same by model and by agent.
 */

const NUM = 'tabular-nums text-right';

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <SettingsCard divided={false} className="flex min-w-0 flex-col gap-1 px-4 py-3.5">
      <div className="text-note text-muted">{label}</div>
      <div className="text-[24px] leading-tight font-semibold tracking-[-0.02em] tabular-nums text-fg"><RollingText text={value} /></div>
      {sub ? <div className="text-note leading-snug text-muted">{sub}</div> : null}
    </SettingsCard>
  );
}

const bucketLabel = (b: UsageBucket, bucket: UsageSummary['bucket']): string =>
  bucket === 'hour'
    ? new Date(b.start).toLocaleTimeString(undefined, { hour: 'numeric', ...clockHours() })
    : new Date(b.start).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });

const axisLabel = (b: UsageBucket, bucket: UsageSummary['bucket']): string =>
  bucket === 'hour'
    ? new Date(b.start).toLocaleTimeString(undefined, { hour: 'numeric', ...clockHours() })
    : new Date(b.start).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

/** one bar per hour or day: cost, or tokens when nothing had a price */
function UsageChart({ data }: { data: UsageSummary }) {
  const [hover, setHover] = useState<number | null>(null);
  const byCost = data.totals.costUsd > 0;
  const value = (b: UsageBucket): number => (byCost ? b.costUsd : b.tokens);
  const show = (n: number): string => (byCost ? formatUsd(n) : `${formatTokens(n)} tokens`);
  const max = Math.max(0, ...data.series.map(value));
  const now = Date.now();
  const h = hover === null ? undefined : data.series[hover];
  const last = data.series.length - 1;
  const ticks = [0, Math.floor(last / 2), last];
  return (
    <div className={cn(SETTINGS_ROW, 'flex flex-col gap-2 py-4')}>
      <div className="flex min-h-5 items-baseline justify-between gap-4 text-note">
        <span className="text-muted">{byCost ? `Estimated cost per ${data.bucket}` : `Tokens per ${data.bucket}`}</span>
        {h ? (
          <span className="text-fg tabular-nums">
            <span className="text-muted">{bucketLabel(h, data.bucket)} · </span>
            {byCost ? `${formatUsd(h.costUsd)} · ${formatTokens(h.tokens)} tokens` : `${formatTokens(h.tokens)} tokens`}
          </span>
        ) : max > 0 ? <span className="text-muted tabular-nums">Peak {show(max)}</span> : null}
      </div>
      <div
        className="relative flex h-36 items-end gap-[2px] border-b border-[color-mix(in_srgb,var(--ab-fg)_12%,transparent)]"
        role="img"
        aria-label={`${byCost ? 'Estimated cost' : 'Tokens'} per ${data.bucket}`}
        onMouseLeave={() => setHover(null)}
      >
        {/* a faint line at the peak */}
        {max > 0 ? <div className="pointer-events-none absolute inset-x-0 top-0 border-t border-dashed border-[color-mix(in_srgb,var(--ab-fg)_8%,transparent)]" /> : null}
        {data.series.map((b, i) => {
          const v = value(b);
          const pct = max > 0 ? (v / max) * 100 : 0;
          return (
            <div key={b.start} className="flex h-full min-w-0 flex-1 items-end justify-center" onMouseEnter={() => setHover(i)}>
              <div
                className={cn(
                  'mx-auto w-full max-w-10 rounded-t-[4px] bg-accent transition-opacity duration-100',
                  hover !== null && hover !== i && 'opacity-45',
                  b.start > now && 'opacity-0',
                )}
                style={{ height: v > 0 ? `max(2px, ${pct}%)` : 0 }}
              />
            </div>
          );
        })}
      </div>
      <div className="relative h-4 text-[11px] text-muted tabular-nums">
        {ticks.map((i, k) => {
          const b = data.series[i];
          if (!b) return null;
          const left = data.series.length > 1 ? (i / last) * 100 : 0;
          return (
            <span
              key={k}
              className="absolute top-0 whitespace-nowrap"
              style={k === 0 ? { left: 0 } : k === ticks.length - 1 ? { right: 0 } : { left: `${left}%`, transform: 'translateX(-50%)' }}
            >
              {axisLabel(b, data.bucket)}
            </span>
          );
        })}
      </div>
    </div>
  );
}

/** a table: name, then numbers (tokens, cache hit, cost) */
function UsageTable({ rows, nameLabel }: {
  nameLabel: string;
  rows: (UsageTotals & { key: string; name: string; priced?: boolean })[];
}) {
  return (
    <SettingsCard>
      <div className={cn(SETTINGS_ROW, 'grid grid-cols-[minmax(0,1fr)_4.5rem_4.5rem_5.5rem] gap-3 py-2 text-note text-muted')}>
        <span>{nameLabel}</span>
        <span className={NUM}>Tokens</span>
        <span className={NUM}>From cache</span>
        <span className={NUM}>Cost</span>
      </div>
      {rows.map((r) => (
        <div key={r.key} className={cn(SETTINGS_ROW, 'grid grid-cols-[minmax(0,1fr)_4.5rem_4.5rem_5.5rem] items-center gap-3 py-2.5 text-copy')}>
          <span className="truncate font-medium text-fg">{r.name}</span>
          <span className={cn(NUM, 'text-fg')}>{formatTokens(r.tokens)}</span>
          <span className={cn(NUM, 'text-muted')}>{cacheHitRate(r) || '-'}</span>
          {r.priced === false ? (
            <Tooltip label="No price is known for this model, so only its tokens count">
              <span className={cn(NUM, 'text-muted')}>No price</span>
            </Tooltip>
          ) : (
            <span className={cn(NUM, 'text-fg')}>{formatUsd(r.costUsd)}</span>
          )}
        </div>
      ))}
    </SettingsCard>
  );
}

/* ---------- plan limits ---------- */

/** One agent's card: its glyph, name, plan pill and account, then a row per window and the extra usage. */
function LimitsCard({ l, now, wide }: { l: ProviderLimits; now: number; wide: boolean }) {
  const providers = useStore((s) => s.providers);
  const threads = useStore((s) => s.threads);
  const bots = useStore((s) => s.bots);
  const p = providers.find((x) => x.id === l.providerId);
  const agent = p ?? { id: l.providerId, name: l.providerId };
  const models = useMemo(() => {
    const known = agentChoices(threads, l.providerId).models;
    return known.length ? known : fetchedChoices.get(l.providerId)?.models ?? [];
  }, [threads, l.providerId]);
  const using = bots.filter((b) => b.providerId === l.providerId).length;
  const whole = agentLimits(l, now);
  const sub = [p?.auth?.account, using ? `${using} ${using === 1 ? 'bot' : 'bots'}` : ''].filter(Boolean).join(' · ');
  return (
    <SettingsCard className="min-w-0">
      <div className="flex items-center gap-2.5 px-4 py-3">
        <AgentGlyph agent={agent} size={16} />
        <span className="truncate text-copy font-medium text-fg">{agentDisplayName(agent, providers)}</span>
        {l.plan ? <span className="shrink-0 rounded-md bg-[color-mix(in_srgb,var(--ab-fg)_7%,transparent)] px-1.5 py-px text-[11px] text-fg-2">{l.plan}</span> : null}
        {whole && whole.tone !== 'ok' ? <span className={cn('shrink-0 text-[11px]', TONE_TEXT[whole.tone])}>{whole.tone === 'low' ? 'Running low' : whole.tone === 'extra' ? 'On extra usage' : 'Used up'}</span> : null}
        <span className="ml-auto min-w-0 truncate text-note text-muted">{sub}</span>
      </div>
      {l.status === 'error' || l.status === 'live' ? <div className={cn('px-4 pb-2 text-note', l.status === 'error' ? 'text-danger' : 'text-muted')}>{limitsStatusText(l, now)}</div> : null}
      {l.spendLimitReached ? <div className="px-4 py-2 text-note text-danger">Your workspace’s spend limit is reached.</div> : null}
      {l.windows.map((w) => <LimitWindowRow key={w.id} w={w} limits={l} models={models} now={now} compact={!wide} />)}
      {l.extra?.enabled || l.extra?.usedUsd !== undefined ? (
        wide ? (
          <div className="grid grid-cols-[minmax(7rem,1.1fr)_minmax(0,2fr)_6.5rem_minmax(8rem,1fr)] items-center gap-4 px-4 py-3">
            <div className="min-w-0">
              <div className="text-copy font-medium text-fg">Extra usage</div>
              <div className="text-note text-muted">{l.extra.enabled ? 'Used once a limit is reached' : 'Off'}</div>
            </div>
            <LimitMeter left={l.extra.limitUsd && l.extra.usedUsd !== undefined ? 100 - (l.extra.usedUsd / l.extra.limitUsd) * 100 : 100} tone={l.extra.inUse ? 'extra' : 'ok'} className="h-1.5 w-full" />
            <span className="text-right text-copy tabular-nums text-fg">{l.extra.limitUsd && l.extra.usedUsd !== undefined ? `$${(l.extra.limitUsd - l.extra.usedUsd).toFixed(2).replace(/\.00$/, '')} left` : l.extra.enabled ? 'On' : 'Off'}</span>
            <span className="truncate text-right text-note text-muted tabular-nums">{extraUsageText(l.extra)}</span>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-3 px-4 py-2.5 text-note">
            <span className="text-fg">Extra usage</span>
            <span className="text-muted tabular-nums">{extraUsageText(l.extra)}</span>
          </div>
        )
      ) : null}
    </SettingsCard>
  );
}

/** Settings › Usage › Plan limits: a card per agent with limits, one quiet line for the rest. */
function PlanLimitsGroup() {
  const supported = useStore((s) => s.limitsSupported);
  const providers = useStore((s) => s.providers);
  const limits = useAllLimits(supported);
  const now = useNow(30_000);
  const [refreshing, setRefreshing] = useState(false);
  const refresh = async () => { setRefreshing(true); try { await refreshLimits('force'); } finally { setRefreshing(false); } };
  if (!supported) return null;
  const withLimits = limits.filter((l) => l.windows.length && l.status !== 'unavailable' && l.status !== 'signed_out');
  const without = limits.filter((l) => !withLimits.includes(l));
  const newest = withLimits.reduce((m, l) => Math.max(m, l.updatedAt), 0);
  const name = (id: string) => { const p = providers.find((x) => x.id === id); return p ? agentDisplayName(p, providers) : id; };
  // the biggest card (most windows) on top at full width, the rest two to a row
  const sorted = [...withLimits].sort((a, b) => b.windows.length - a.windows.length);
  const wide = sorted.length === 1 || (sorted[0]?.windows.length ?? 0) > 2 ? sorted.slice(0, 1) : [];
  const rest = sorted.filter((l) => !wide.includes(l));
  const quiet = without.map((l) => `${name(l.providerId)}: ${l.message ?? limitsStatusText(l, now).toLowerCase()}`).join(' · ');
  return (
    <SettingsGroup
      title={USAGE_LIMITS_TITLE}
      description={`${limitsSourcesText(limits)}${newest ? ` ${updatedAgoText(newest, now).replace(/^updated/, 'Updated')}.` : ''}`}
      action={<Button size="sm" variant="ghost" icon={RefreshCw} loading={refreshing} onClick={() => void refresh()}>Refresh</Button>}
      bare
    >
      {!withLimits.length ? (
        <SettingsEmptyState>
          {limits.length ? `No plan limits to show. ${quiet}` : 'Nothing read yet. Plan limits show here for Claude Code, Codex and OpenCode Go sign-ins with a subscription.'}
        </SettingsEmptyState>
      ) : (
        <div className="flex flex-col gap-3">
          {wide.map((l) => <LimitsCard key={l.providerId} l={l} now={now} wide />)}
          {/* one card left over takes the full width like the one above it, never half a row */}
          {rest.length === 1 ? <LimitsCard key={rest[0]!.providerId} l={rest[0]!} now={now} wide /> : null}
          {rest.length > 1 ? <div className="grid grid-cols-1 gap-3 md:grid-cols-2">{rest.map((l) => <LimitsCard key={l.providerId} l={l} now={now} wide={false} />)}</div> : null}
          {quiet ? <p className="px-4 text-note leading-normal text-muted">{quiet}</p> : null}
        </div>
      )}
    </SettingsGroup>
  );
}

const dayText = (date: string): string =>
  new Date(`${date}T12:00:00`).toLocaleDateString(intlLocale(), { day: 'numeric', month: 'short', year: 'numeric' });

/**
 * A year of days as a grid (Rare UI's GitHubActivity): each month the computer reads is added to a tally of days kept
 * for this computer (usageActivity.ts), so the grid fills from the first look on; the panel under it stacks the
 * agents used most in the last 30 days. `shown`: the page's own answer when its range is the month (not asked twice).
 */
function ActivityGroup({ shown }: { shown: UsageSummary | null }) {
  const has = shown?.range === '30d';
  const { data } = useRemembered<UsageSummary>('usage:30d', async () => {
    if (has) return undefined;
    try { return await rpc('usage.summary', { range: '30d', scope: 'bots' }, { timeoutMs: 120_000 }); } catch { return undefined; }
  });
  const month = has ? shown : data;
  const kept = useStore((s) => s.remembered[ACTIVITY_KEY]?.value);
  const ledger = useMemo(() => readLedger(kept), [kept]);
  useEffect(() => {
    if (!month || month.bucket !== 'day') return;
    const next = mergeDays(ledger, month.series, Date.now());
    if (next !== ledger) remember(ACTIVITY_KEY, next);
  }, [month, ledger]);

  const today = dayKey(useNow(60_000));
  const activity = useMemo(() => activityDays(ledger, new Date(`${today}T12:00:00`).getTime()), [ledger, today]);
  const tops = useMemo(() => (month?.agents ?? []).filter((a) => a.tokens > 0).slice(0, 3).map((a) => ({
    name: a.name,
    count: formatTokens(a.tokens),
    logo: <ProviderLogo id={providerBase(a.id)} size={15} className="text-fg" />,
  })), [month]);
  if (!activity.since) return null;

  const describe = (d: ActivityDay): string =>
    d.unknown ? `Not counted: ${dayText(d.date)}` : d.count ? `${formatTokens(d.count)} tokens on ${dayText(d.date)}` : `Nothing on ${dayText(d.date)}`;
  return (
    <SettingsGroup title={USAGE_ACTIVITY_TITLE} description={`Each day your bots worked, counted from ${dayText(activity.since)} on.`} bare>
      <SettingsCard divided={false}>
        <GitHubActivity
          fill
          showMonths
          days={activity.days}
          tops={tops}
          heading={activity.active ? `${formatTokens(activity.tokens)} tokens on ${activity.active} ${activity.active === 1 ? 'day' : 'days'}` : 'Nothing used yet'}
          describe={describe}
          label="Most used in the last 30 days:"
          showLabel="Show the agents used most"
          hideLabel="Hide the agents used most"
          accent="var(--ab-accent)"
          cellSize={11}
          locale={intlLocale()}
          className="rounded-none bg-transparent"
        />
      </SettingsCard>
    </SettingsGroup>
  );
}

export function UsageSection() {
  const computer = useThisComputer();
  const [range, setRange] = useState<UsageRange>('7d');
  // the last numbers read show at once (lib/remembered.ts, per computer); a fresh read replaces them when it lands
  // (a first look reads weeks of logs: longer than a normal call)
  const { data, loading, reload } = useRemembered<UsageSummary>(`usage:${range}`, () =>
    call('usage.summary', { range, scope: 'bots' }, { errorTitle: 'Could not read usage', timeoutMs: 120_000 }));

  const phrase = USAGE_RANGES.find((r) => r.id === range)?.phrase ?? '';
  const t = data?.totals;
  const empty = !!data && data.sources.length === 0;
  const unused = !!data && !empty && t!.requests === 0;
  // the agents whose history was found here, as read (before the first answer: none named)
  const found = data ? usageSourceNames(data.sources) : '';
  const asOf = data ? new Date(`${data.pricesAsOf}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }) : '';

  return (
    <div>
      <PlanLimitsGroup />
      <SettingsGroup
        title={USAGE_TITLE}
        description={`From the agents' own history on ${computer.name}${found ? ` (${found})` : ''}, at API prices. Nothing is sent anywhere.`}
        action={(
          <div className="flex items-center gap-1">
            <SettingsSegmented label="Time range" value={range} onChange={setRange} options={USAGE_RANGES.map((r) => ({ value: r.id, label: r.label }))} />
            <Tooltip label="Read again">
              <Button size="icon-sm" variant="ghost" icon={RefreshCw} aria-label="Read again" loading={loading && !!data} onClick={() => void reload()} />
            </Tooltip>
          </div>
        )}
        bare
      >
        {!data ? (
          loading ? <SectionLoading /> : <SettingsEmptyState>Couldn’t read usage.</SettingsEmptyState>
        ) : empty ? (
          <SettingsEmptyState>
            No agent history on {computer.name} yet. Once a bot uses Claude Code, Codex, Grok, OpenCode, GitHub Copilot,
            Gemini CLI or Pi, its usage shows here.
          </SettingsEmptyState>
        ) : (
          <div className={cn('flex flex-col gap-3 transition-opacity', loading && 'opacity-60')}>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Tile
                label="Estimated cost"
                value={formatUsd(t!.costUsd)}
                sub="At API prices"
              />
              <Tile label="Tokens" value={formatTokens(t!.tokens)} sub={`${formatTokens(t!.output)} written · ${formatTokens(t!.cacheRead)} from cache`} />
              <Tile label="Saved by caching" value={formatUsd(t!.cacheSavingsUsd)} sub={cacheHitRate(t!) ? `${cacheHitRate(t!)} of input came from the cache` : undefined} />
            </div>
            {unused ? (
              <SettingsEmptyState>Your bots used nothing {phrase}.</SettingsEmptyState>
            ) : (
              <SettingsCard><UsageChart data={data} /></SettingsCard>
            )}
          </div>
        )}
      </SettingsGroup>

      {data && !empty ? <ActivityGroup shown={data} /> : null}

      {data && !empty && !unused ? (
        <>
          <SettingsGroup title={USAGE_BY_MODEL_TITLE} bare>
            <UsageTable nameLabel="Model" rows={data.models.map((m) => ({ ...m, key: m.model }))} />
          </SettingsGroup>
          <SettingsGroup title={USAGE_BY_AGENT_TITLE} bare>
            <UsageTable nameLabel="Agent" rows={data.agents.map((a) => ({ ...a, key: a.id }))} />
          </SettingsGroup>
        </>
      ) : null}

      {data && !empty ? (
        <p className="mt-6 px-4 text-note leading-normal text-muted">
          Costs are estimates at public API prices (checked {asOf}), or the cost an agent logged itself (Grok, and
          OpenCode or Pi where they know it), not your bill: on a subscription you pay for the plan. Models without a
          known price count their tokens only.
        </p>
      ) : null}
    </div>
  );
}
