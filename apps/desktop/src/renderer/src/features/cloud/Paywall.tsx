import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import {
  CUSTOM_CARD, FREE_CARD, PAYWALL_INTERVAL_LABELS, PAYWALL_KIND_LABELS, PAYWALL_SPEC_LABEL, PAYWALL_WHERE,
  YEARLY_SAVING, clampMembers, paywallCss, paywallIconPaths, paywallView, stepPeople, stepperText, trialDaysOf,
  type CurrentPlan, type PaywallCell, type PaywallIcon, type PaywallKind, type PaywallWhere, type PlanRow,
} from '@appubot/chat-core';
import { CLOUD_TEAM_MEMBERS, type CloudAccountView, type CloudInterval } from '@appubot/protocol';
import geistUrl from '../../assets/fonts/geist-latin-wght-normal.woff2?url';
import { native } from '../../lib/native';
import { openSupport } from '../support/support';
import { paywallStart } from './cloudAccount';
import { SOLD_OUT_TEXT } from './names';

/**
 * The plan cards (Settings › Billing): THE paywall, appubot.com's plan cards, drawn from
 * chat-core `paywall.ts` exactly as the backend's account page draws them (`paywallView` for the cells, `paywallCss`
 * for the site's classes, colours, type and breakpoints, Geist as the site sets it). The control row (Personal | Work
 * at the left; "− 1 person +", whose steps across 1 and 2 switch Personal and Work, and Monthly | Yearly "2 months
 * free" at the right), then one bordered grid of cells: Free first, Pro's or Scale's accent top edge, Custom last on
 * Work, the launch-bonus line under it. Every price is the backend's catalog. A first plan's buttons read
 * "Start 3-day free trial" (chat-core `trialDaysOf`), with the trial's terms said once under the cards. Someone changing a plan sees theirs
 * marked "Current plan" and the others labelled Upgrade / Downgrade / Switch to yearly; what a pick does is the
 * caller's (`onPick`).
 */

export type { CurrentPlan };

export interface PlanChoice {
  kind: PaywallKind; setKind: (k: PaywallKind) => void;
  interval: CloudInterval; setInterval: (i: CloudInterval) => void;
  /** the team size the Work cards are priced for (kept while Personal shows) */
  members: number; setMembers: (n: number) => void;
}

export function usePlanChoice(start: { kind?: PaywallKind; interval?: CloudInterval; members?: number } = {}): PlanChoice {
  const [kind, setKind] = useState<PaywallKind>(start.kind ?? paywallStart.kind ?? 'personal');
  const [interval, setInterval] = useState<CloudInterval>(start.interval ?? paywallStart.interval ?? 'monthly');
  const [members, setMembersRaw] = useState(() => clampMembers(start.members ?? paywallStart.members ?? CLOUD_TEAM_MEMBERS.min));
  return { kind, setKind, interval, setInterval, members, setMembers: (n) => setMembersRaw(clampMembers(n)) };
}

/** the shared stylesheet, once: the site's paywall CSS with the app's light/dark, and the face */
const STYLE = `@font-face{font-family:"Geist Variable";font-style:normal;font-display:swap;font-weight:100 900;src:url(${geistUrl}) format("woff2-variations");unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}
${paywallCss({ light: 'html:not(.dark) .pw', dark: 'html.dark .pw' })}`;

export function PlanCards({ view, choice, mode, current, soldOut, blocked, loadingId, onPick, onFree, freeLabel }: {
  view: CloudAccountView;
  choice: PlanChoice;
  /** `buy`: no plan yet (the Personal | Work switch, Free first); `personal`: changing one's own plan; `team`: a team's (the stepper is its seats) */
  mode: 'buy' | 'personal' | 'team';
  current?: CurrentPlan;
  soldOut?: boolean;
  /** why no card can be picked right now (a team smaller than its people), shown under the grid */
  blocked?: string;
  loadingId?: string | null;
  onPick: (card: PaywallCell, interval: CloudInterval, members: number) => void;
  /** first-run setup: the Free card's button goes on with this computer (`freeLabel`); elsewhere it only says "Your plan" */
  onFree?: () => void;
  freeLabel?: string;
}) {
  // a first plan starts with the free trial: a signed-in person's own (none once they've had a plan), else the catalog's
  const trialDays = trialDaysOf(view.catalog, view.signedIn ? (view.account ?? {}) : null);
  const v = paywallView(view.catalog, { mode, kind: choice.kind, interval: choice.interval, members: choice.members, current: current ?? null, soldOut: !!soldOut, blocked: !!blocked, trialDays });
  const bounds = view.catalog?.work?.members ?? CLOUD_TEAM_MEMBERS;
  const setPeople = (n: number) => {
    const next = stepPeople(mode, v.kind, n, bounds);
    if (next.kind !== v.kind) choice.setKind(next.kind);
    if (next.members !== undefined) choice.setMembers(next.members);
  };

  return (
    <div className="pw" data-row="">
      <style>{STYLE}</style>
      <div className="pw-controls">
        {v.showKinds ? (
          <Segmented label="Plans for" value={v.kind} onChange={choice.setKind} options={(['personal', 'work'] as const).map((k) => ({ value: k, label: PAYWALL_KIND_LABELS[k] }))} />
        ) : <span />}
        <div className="pw-controls-end">
          {v.showStepper ? (
            <div className="pw-members" role="group" aria-label="People">
              <button type="button" aria-label="One person fewer" disabled={v.people <= v.stepper.min} onClick={() => setPeople(v.people - 1)}><Icon name="minus" /></button>
              <output aria-live="off">{stepperText(v.people)}</output>
              <button type="button" aria-label="One person more" disabled={v.people >= v.stepper.max} onClick={() => setPeople(v.people + 1)}><Icon name="plus" /></button>
            </div>
          ) : null}
          {v.intervals.length > 1 ? (
            <Segmented
              label="Billing"
              value={v.interval}
              onChange={choice.setInterval}
              options={v.intervals.map((i) => ({ value: i, label: i === 'yearly' ? <>{PAYWALL_INTERVAL_LABELS[i]} <span className="pw-save">{YEARLY_SAVING}</span></> : PAYWALL_INTERVAL_LABELS[i] }))}
            />
          ) : null}
        </div>
      </div>

      <div className="pw-grid">
        <div className="pw-cols" data-cols={v.columns >= 4 ? 4 : v.columns}>
          {v.cells.map((c) => (
            <Cell
              key={c.id}
              name={c.name}
              where="cloud"
              specLabel={PAYWALL_SPEC_LABEL[v.kind]}
              highlight={c.highlight}
              off={c.off}
              badge={c.badge ? <span className="pw-badge" data-tone={c.badge.tone}>{c.badge.text}</span> : null}
              price={<Price price={c.price} per={c.per} struck={c.struck} sub={c.sub} />}
              blurb={c.blurb}
              cta={(
                <button
                  type="button"
                  className="pw-btn"
                  data-primary={c.button.primary || undefined}
                  disabled={c.button.disabled || loadingId === c.id}
                  aria-busy={loadingId === c.id || undefined}
                  aria-label={c.button.aria}
                  onClick={() => onPick(c, v.interval, v.members)}
                >
                  {c.button.label}
                </button>
              )}
              rows={c.rows}
            />
          ))}
          {v.custom ? <CustomCell /> : null}
        </div>
      </div>

      {v.free ? <FreeCard onPick={onFree} label={freeLabel} /> : null}
      {blocked ? <p className="pw-warn">{blocked}</p> : soldOut && !current ? <p className="pw-warn">{SOLD_OUT_TEXT}</p> : null}
    </div>
  );
}

/* ---------- the site's controls ---------- */

function Icon({ name, size = 16 }: { name: PaywallIcon; size?: number }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden
      dangerouslySetInnerHTML={{ __html: paywallIconPaths(name) }}
    />
  );
}

/** `.seg`: a radio group pill, arrow keys and one tab stop */
function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    const to = e.key === 'Home' ? 0 : e.key === 'End' ? options.length - 1 : step ? (i + step + options.length) % options.length : -1;
    if (to < 0) return;
    e.preventDefault();
    onChange(options[to]!.value);
    refs.current[to]?.focus();
  };
  return (
    <div role="radiogroup" aria-label={label} className="pw-seg">
      {options.map((o, i) => (
        <button
          key={o.value}
          ref={(el) => { refs.current[i] = el; }}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          tabIndex={o.value === value ? 0 : -1}
          onClick={() => onChange(o.value)}
          onKeyDown={(e) => onKey(e, i)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ---------- one plan's cell ---------- */

function Price({ price, per, struck, sub, forever }: { price: string; per?: string; struck?: string; sub: string; forever?: boolean }) {
  return (
    <>
      <div className="pw-price" data-forever={forever || undefined}>
        {struck ? <span className="pw-struck" aria-hidden="true">{struck}</span> : null}
        <span className="pw-amount">{price}</span>
        {per ? <span className="pw-per">{per}</span> : null}
      </div>
      <p className="pw-sub">{sub}</p>
    </>
  );
}

function Cell({ name, badge, where, specLabel, highlight, off, price, blurb, cta, rows }: {
  name: string; badge?: ReactNode; where: PaywallWhere; specLabel?: string; highlight?: boolean; off?: boolean;
  price: ReactNode; blurb: string; cta: ReactNode; rows: PlanRow[];
}) {
  const w = PAYWALL_WHERE[where];
  return (
    <article className="pw-cell" data-highlight={highlight || undefined} data-off={off || undefined} aria-label={`${name} plan`}>
      <div className="pw-head">
        <h3>{name}</h3>
        <span className="pw-tags">
          {badge}
          <span role="img" aria-label={w.label} title={w.label} className="pw-where"><Icon name={w.icon} /></span>
        </span>
      </div>
      {price}
      <p className="pw-blurb">{blurb}</p>
      <div className="pw-cta">{cta}</div>
      {specLabel ? <p className="pw-spec">{specLabel}</p> : null}
      <ul className="pw-rows" data-top={specLabel ? undefined : ''}>
        {rows.map((r) => <li key={r.text}><Icon name={r.icon} />{r.text}</li>)}
      </ul>
    </article>
  );
}

/** Free, as a wide card under the plans: bots on this computer, no account or card. The person's plan until they pick another. */
function FreeCard({ onPick, label }: { onPick?: () => void; label?: string }) {
  const w = PAYWALL_WHERE.own;
  return (
    <section className="pw-free" aria-label={`${FREE_CARD.name} plan`}>
      <div>
        <div className="pw-head">
          <h3>{FREE_CARD.name}</h3>
          <span className="pw-tags">
            <span className="pw-badge">Current plan</span>
            <span role="img" aria-label={w.label} title={w.label} className="pw-where"><Icon name={w.icon} /></span>
          </span>
        </div>
        <Price price={FREE_CARD.price} per={FREE_CARD.per} sub={FREE_CARD.sub} forever />
        <p className="pw-blurb">{FREE_CARD.blurb}</p>
      </div>
      <ul className="pw-rows">
        {FREE_CARD.rows.map((r) => <li key={r.text}><Icon name={r.icon} />{r.text}</li>)}
      </ul>
      <div className="pw-free-cta"><button type="button" className="pw-btn" disabled={!onPick} onClick={onPick}>{onPick && label ? label : 'Your plan'}</button></div>
    </section>
  );
}

/** Custom: bigger or unusual teams, priced in a conversation. */
function CustomCell() {
  return (
    <Cell
      name={CUSTOM_CARD.name}
      where="cloud"
      price={<Price price={CUSTOM_CARD.price} sub={CUSTOM_CARD.sub} forever />}
      blurb={CUSTOM_CARD.blurb}
      cta={(
        <div className="pw-cta-stack">
          <button type="button" className="pw-btn" data-primary onClick={() => openSupport()}>{CUSTOM_CARD.talk}</button>
          <button type="button" className="pw-btn" onClick={() => void native().openExternal('mailto:sarthak@appubot.com')}>{CUSTOM_CARD.email}</button>
        </div>
      )}
      rows={CUSTOM_CARD.rows}
    />
  );
}
