/**
 * AppuBot's launch gift (2026-11-10, the Product Hunt launch; words and rules in chat-core `launchGift.ts`, the day
 * itself in core `services/promo.ts`): a full-window screen, in the manner of setup's, that opens by itself on this
 * computer while the free Claude day is on (`SystemInfo.promo`). Your own bots stand on it as the crew. Three steps
 * on a tracker, one at a time with one button each: support the launch on Product Hunt, share it on X (one of
 * twenty written posts, picked at random for you), then the gift: signing in to AppuBot if needed and
 * `promo.start`, which installs Claude Code where it is missing and adds Claude to the app until the day ends. No
 * bot moves by itself: the last page lists the bots with a switch each (`promo.use`), and any bot's model picker
 * offers it too. A step counts as done once its page was opened
 * (nothing checks a vote or a post). ✕ at the top or Escape puts the screen away until the next launch; the day
 * ending is said once, in a small dialog.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { LAUNCH_GIFT, LAUNCH_URL, GIFT_STEPS, giftCardOpensNow, giftEndsText, giftProgressText, launchPostText, launchPostUrl, nextGiftStep, randomLaunchPost, type GiftStep } from '@appubot/chat-core';
import { APPUBOT_AI_PROVIDER_ID, type Bot, type BotShape, type PromoStatus } from '@appubot/protocol';
import { BotAvatar, Button, Dialog, Logo, Switch, cn, useDialogOpen, useModalPresence } from '../../components/ui';
import { ArrowRight, Check, ExternalLink, LogIn, Sparkles, X } from '../../components/ui/icons';
import { useAppearancePrefs } from '../../lib/appearance';
import { errorMessage, rpc } from '../../lib/gateway';
import { native } from '../../lib/native';
import { IS_MAC } from '../../lib/platform';
import { macSystemOf, ui, useStore } from '../../lib/store';
import { DitherBackground } from '../chat/DitherBackground';
import { useCloudLink } from '../cloud/cloudClient';
import { signInToCloud, useCloud } from '../cloud/cloudAccount';
import { ProviderLogo } from '../providers/providerLogos';
import { useInFront } from '../whatsNew/WhatsNew';
import { EASE_OUT } from '../../lib/motion';

/** how long after everything is ready the screen opens (What's new, which goes first, uses the same pause) */
const OPEN_DELAY_MS = 1200;
/** Start may install Claude Code: the call waits for it */
const START_TIMEOUT_MS = 15 * 60_000;
const STEP_KEY = 'appubot.launchGiftStep';

/** put away this run: it stays away until the next launch */
let putAway = false;

/** the mocks' page picks a step: `?gift=1&giftstep=post|gift` */
const PREVIEW_STEP = import.meta.env.VITE_APPUBOT_MOCK === '1' && typeof location !== 'undefined' ? new URLSearchParams(location.search).get('giftstep') : null;
/** the mocks' `?gift=on` opens on the last page (the real one only shows it right after Start) */
const PREVIEW_ON = import.meta.env.VITE_APPUBOT_MOCK === '1' && typeof location !== 'undefined' && new URLSearchParams(location.search).get('gift') === 'on';

/** the step the person had reached for this day (kept across restarts: nobody is asked twice) */
function savedStep(id: string): GiftStep {
  if (PREVIEW_STEP && GIFT_STEPS.includes(PREVIEW_STEP as GiftStep)) return PREVIEW_STEP as GiftStep;
  try {
    const v = JSON.parse(localStorage.getItem(STEP_KEY) ?? 'null') as { id?: string; step?: string } | null;
    return v?.id === id && GIFT_STEPS.includes(v.step as GiftStep) ? (v.step as GiftStep) : 'launch';
  } catch { return 'launch'; }
}
function saveStep(id: string, step: GiftStep): void {
  try { localStorage.setItem(STEP_KEY, JSON.stringify({ id, step })); } catch { /* full: asked again */ }
}

/** which of the written posts this person got for this day: picked at random once, then kept (the preview and the post match) */
const POST_KEY = 'appubot.launchGiftPost';
function postPick(id: string): number {
  try {
    const v = JSON.parse(localStorage.getItem(POST_KEY) ?? 'null') as { id?: string; n?: number } | null;
    if (v?.id === id && typeof v.n === 'number') return v.n;
  } catch { /* picked again */ }
  const n = randomLaunchPost();
  try { localStorage.setItem(POST_KEY, JSON.stringify({ id, n })); } catch { /* full: another pick next time */ }
  return n;
}

export function LaunchGiftDialog() {
  const promo = useStore((s) => s.system?.promo);
  const onboarded = useStore((s) => s.settings?.onboarded ?? false);
  const loaded = useStore((s) => s.hydrated && s.conn === 'connected');
  const covered = useStore((s) => s.settingsSection !== null || s.quitPrompt !== null || s.modal !== null || s.voiceMode !== null || !!macSystemOf(s)?.update?.required);
  const thisComputer = useCloudLink((s) => s.computer !== 'cloud');
  const inFront = useInFront();
  const dialog = useDialogOpen();
  const [open, setOpen] = useState(PREVIEW_ON);
  /** Start went through on this screen: it says so before closing */
  const [started, setStarted] = useState(PREVIEW_ON);

  const opensNow = giftCardOpensNow({ state: promo?.state, onboarded, loaded, inFront, covered: covered || dialog, thisComputer, putAway });
  useEffect(() => {
    if (open || !opensNow) return;
    const t = window.setTimeout(() => setOpen(true), promo?.state === 'starting' ? 0 : OPEN_DELAY_MS);
    return () => window.clearTimeout(t);
  }, [open, opensNow, promo?.state]);
  // Start running here: its "on" comes as an event before the call's own answer, and must not close the screen
  useEffect(() => { if (open && promo?.state === 'starting') setStarted(true); }, [open, promo?.state]);
  // nothing left to show (the day ended elsewhere, another computer came on screen)
  useEffect(() => {
    if (open && (!promo || !thisComputer || (promo.state === 'on' && !started))) setOpen(false);
  }, [open, promo, thisComputer, started]);

  const close = () => { putAway = true; setOpen(false); setStarted(false); };
  const over = promo?.state === 'over';
  const done = () => { void rpc('promo.dismiss', {}).catch(() => undefined); setOpen(false); };

  return (
    <>
      <GiftScreen open={open && !!promo && !over} promo={promo && !over ? promo : null} onClose={close} onStarted={() => setStarted(true)} />
      <Dialog
        open={open && over} onClose={done} size="sm"
        title={promo?.why === 'used-up' ? LAUNCH_GIFT.over.usedUpTitle : LAUNCH_GIFT.over.title}
        footer={<>
          <Button variant="ghost" onClick={() => { done(); ui.openSettings('providers'); }}>{LAUNCH_GIFT.over.agents}</Button>
          <Button variant="primary" data-autofocus onClick={done}>{LAUNCH_GIFT.over.close}</Button>
        </>}
      >
        <p className="text-copy leading-relaxed text-fg-2">{LAUNCH_GIFT.over.body}</p>
      </Dialog>
    </>
  );
}

/* ------------------------------------------------------------------ the screen */

function GiftScreen({ open, promo, onClose, onStarted }: { open: boolean; promo: PromoStatus | null; onClose: () => void; onStarted: () => void }) {
  useModalPresence(open);
  const busy = promo?.state === 'starting';
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented && !busy) { e.preventDefault(); onClose(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, busy, onClose]);
  // the last day shown stays while the screen fades out
  const [last, setLast] = useState(promo);
  useEffect(() => { if (promo) setLast(promo); }, [promo]);
  const shown = promo ?? last;
  if (typeof document === 'undefined') return null;
  return createPortal(
    <AnimatePresence>
      {open && shown ? (
        <motion.div
          key="launch-gift" role="dialog" aria-modal="true" aria-label={LAUNCH_GIFT.eyebrow}
          className="drag fixed inset-0 z-[72] flex flex-col overflow-hidden bg-content text-fg"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.25, ease: 'easeOut' }}
        >
          <Backdrop />
          <TopBar promo={shown} onClose={busy ? undefined : onClose} />
          {shown.state === 'on'
            ? <GiftOn promo={shown} onClose={onClose} />
            : <GiftSteps promo={shown} onStarted={onStarted} />}
        </motion.div>
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}

/** the empty chat's dithered field (where the person keeps it on) under a soft light in the accent */
function Backdrop() {
  const { animatedBackground } = useAppearancePrefs();
  const colours = useStore((s) => s.bots.map((b) => b.color).join(','));
  const palette = useMemo(() => (colours ? colours.split(',') : undefined), [colours]);
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0">
      {animatedBackground ? <DitherBackground colours={palette} /> : null}
      <div className="absolute inset-x-0 top-0 h-[70%] bg-[radial-gradient(55%_100%_at_50%_0%,color-mix(in_srgb,var(--ab-accent)_20%,transparent),transparent_72%)]" />
      {/* the words' own ground: the dots thin out behind the middle column, so nothing reads through the text */}
      <div className="absolute inset-0 bg-[radial-gradient(46%_56%_at_50%_54%,color-mix(in_srgb,var(--ab-content)_94%,transparent)_40%,transparent_100%)]" />
      <div className="absolute inset-x-0 bottom-0 h-[30%] bg-[linear-gradient(to_top,var(--ab-content),transparent)]" />
    </div>
  );
}

function useEnds(promo: PromoStatus): string {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), 30_000); return () => window.clearInterval(t); }, []);
  return giftEndsText(promo.endsAt, now);
}

function TopBar({ promo, onClose }: { promo: PromoStatus; onClose?: () => void }) {
  const ends = useEnds(promo);
  return (
    // beside macOS's traffic lights; Windows and Linux have their window buttons on the right (--wco-right)
    <div className={cn('relative flex h-16 shrink-0 items-center gap-2.5 pr-[calc(14px+var(--wco-right))]', IS_MAC ? 'pl-[97px]' : 'pl-5')}>
      <Logo size={22} className="rounded-[6px]" />
      <span className="text-copy font-medium text-fg">{LAUNCH_GIFT.eyebrow}</span>
      {ends ? <span className="rounded-[6px] bg-accent-soft px-2 py-0.5 text-note font-medium text-accent">{ends}</span> : null}
      <div className="flex-1" />
      {onClose ? <Button variant="ghost" size="icon" className="no-drag" aria-label={LAUNCH_GIFT.later} title={LAUNCH_GIFT.later} onClick={onClose}><X size={16} /></Button> : null}
    </div>
  );
}

/** one step's page: what stands above, the tracker, the words, the step's own piece, its actions */
function Page({ hero, tracker, title, body, children, actions, note }: { hero?: ReactNode; tracker?: ReactNode; title: string; body: string; children?: ReactNode; actions: ReactNode; note?: ReactNode }) {
  return (
    <div className="relative flex min-h-0 flex-1 overflow-y-auto px-10">
      <div className="no-drag m-auto flex w-full max-w-[640px] flex-col items-center pt-2 pb-10 text-center [@media(max-height:760px)]:pb-5">
        {hero}
        {tracker ? <div className={cn(hero ? 'mt-8 [@media(max-height:760px)]:mt-5' : '')}>{tracker}</div> : null}
        <h1 className="mt-7 font-display text-[42px] leading-[1.06] font-medium tracking-display text-balance text-fg [@media(max-height:760px)]:mt-5 [@media(max-height:760px)]:text-[32px]">{title}</h1>
        <p className="mt-3.5 max-w-[540px] text-[15.5px] leading-relaxed text-balance text-fg-2 [@media(max-height:760px)]:mt-2.5 [@media(max-height:760px)]:text-copy">{body}</p>
        {children ? <div className="mt-8 flex w-full flex-col items-center [@media(max-height:760px)]:mt-5">{children}</div> : null}
        <div className="mt-9 flex flex-col items-center gap-3 [@media(max-height:760px)]:mt-6">{actions}</div>
        {note ? <div className="mt-4 max-w-[480px] text-ui leading-normal text-muted">{note}</div> : null}
      </div>
    </div>
  );
}

const QUIET = 'no-drag rounded-control-sm px-2 py-1 text-ui text-muted transition-colors hover:text-fg disabled:opacity-50';

/** the three steps: done ones checked (and a way back), this one in the accent */
function Tracker({ step, onPick, locked }: { step: GiftStep; onPick: (s: GiftStep) => void; locked?: boolean }) {
  const at = GIFT_STEPS.indexOf(step);
  return (
    <ol className="flex items-center gap-1.5" aria-label="Steps">
      {GIFT_STEPS.map((s, i) => {
        const doneStep = i < at, current = i === at;
        return (
          <li key={s} className="flex items-center gap-1.5">
            <button
              type="button" disabled={!doneStep || locked} onClick={() => onPick(s)} aria-current={current ? 'step' : undefined}
              className={cn(
                'ab-pill squircle flex h-7 items-center gap-1.5 rounded-control-sm border pr-3 pl-1.5 text-ui font-medium transition-colors',
                current ? 'border-[color-mix(in_srgb,var(--ab-accent)_45%,transparent)] bg-accent-soft text-fg'
                  : doneStep ? 'border-[var(--ab-hairline)] text-fg-2 hover:text-fg' : 'border-transparent text-muted',
              )}
            >
              <span className={cn('flex size-4 items-center justify-center rounded-full text-[10px] font-semibold tabular-nums', current ? 'bg-accent text-white' : doneStep ? 'bg-accent-soft text-accent' : 'bg-surface-3 text-muted')}>
                {doneStep ? <Check size={10} /> : i + 1}
              </span>
              {LAUNCH_GIFT.steps[s]}
            </button>
            {i < GIFT_STEPS.length - 1 ? <span aria-hidden className={cn('h-px w-5', doneStep ? 'bg-accent' : 'bg-[var(--ab-hairline)]')} /> : null}
          </li>
        );
      })}
    </ol>
  );
}

/* ------------------------------------------------------------------ the crew */

/** stand-ins beside a person's own bots, so the crew is always five */
const EXTRAS: { shape: BotShape; color: string }[] = [
  { shape: 'squircle', color: '#2E8EFF' }, { shape: 'hex', color: '#9A68FF' }, { shape: 'drop', color: '#16C47A' }, { shape: 'cloud', color: '#FFA826' },
];
/** where each stands: the first in the middle, the rest out to the sides, smaller the further out */
const PLACES = [{ x: 0, size: 124 }, { x: -108, size: 66 }, { x: 108, size: 66 }, { x: -172, size: 46 }, { x: 172, size: 46 }];

function Standing({ children, size, x, delay }: { children: ReactNode; size: number; x: number; delay: number }) {
  return (
    <motion.div
      className="absolute bottom-0 left-1/2 flex flex-col items-center"
      style={{ x: x - size / 2 }}
      initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.7, delay, ease: EASE_OUT }}
    >
      {children}
      <span className="mt-1 h-[6px] rounded-[50%] bg-[radial-gradient(closest-side,rgba(0,0,0,.16),transparent)] dark:bg-[radial-gradient(closest-side,rgba(0,0,0,.6),transparent)]" style={{ width: size * 0.78 }} />
    </motion.div>
  );
}

/** the person's own bots (looks of ours where they have fewer than five), alive; they cheer when `cheer` moves */
function Crew({ cheer }: { cheer: number }) {
  const bots = useStore((s) => s.bots);
  const crew: ({ bot: Bot } | { shape: BotShape; color: string })[] = [...bots.slice(0, 5).map((bot) => ({ bot })), ...EXTRAS].slice(0, 5);
  return (
    <div className="relative h-[150px] w-[440px] max-w-full [@media(max-height:760px)]:h-[124px] [@media(max-height:760px)]:scale-[0.82] [@media(max-height:760px)]:origin-bottom">
      {crew.map((c, i) => {
        const place = PLACES[i]!;
        return (
          <Standing key={i} size={place.size} x={place.x} delay={0.05 + 0.07 * i}>
            {'bot' in c
              ? <BotAvatar bot={c.bot} size={place.size} cheerKey={cheer} />
              : <BotAvatar shape={c.shape} color={c.color} size={place.size} cheerKey={cheer} />}
          </Standing>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ the pieces */

/** the gift as the model picker shows it: Claude's mark, "Claude", the profile, and how a bot gets it */
function GiftTicket({ promo }: { promo: PromoStatus }) {
  const ends = useEnds(promo);
  return (
    <div className="w-full max-w-[480px] overflow-hidden rounded-card border border-[var(--ab-hairline)] bg-[color-mix(in_srgb,var(--ab-content)_82%,transparent)] text-left shadow-[0_18px_40px_-18px_rgba(0,0,0,.35)] backdrop-blur-md">
      <div className="flex items-center gap-3.5 px-4 py-4">
        <span className="flex size-12 shrink-0 items-center justify-center rounded-control-lg bg-accent-soft"><ProviderLogo id="claude-code" size={26} /></span>
        <div className="min-w-0 flex-1">
          <div className="text-[17px] leading-tight font-semibold text-fg">Claude</div>
          <div className="mt-0.5 truncate text-ui text-muted">{LAUNCH_GIFT.eyebrow}</div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {['Unlimited', 'Free'].map((chip) => <span key={chip} className="rounded-[7px] bg-accent-soft px-2.5 py-1 text-note font-medium text-accent">{chip}</span>)}
        </div>
      </div>
      <div className="flex items-center gap-3 border-t border-[var(--ab-hairline)] px-4 py-3">
        <span className="min-w-0 flex-1 truncate text-ui text-fg-2">You pick the bots that use it</span>
        {ends ? <span className="shrink-0 text-note text-muted">{ends}</span> : null}
      </div>
    </div>
  );
}

/** the last page's list: every bot with a switch; on puts it on the gift, off back on what it used */
function BotPicks() {
  const bots = useStore((s) => s.bots);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | undefined>();
  const use = async (bot: Bot, on: boolean) => {
    setBusy(bot.id); setError(undefined);
    try { await rpc('promo.use', { botId: bot.id, on }); }
    catch (e) { setError(errorMessage(e)); }
    finally { setBusy(null); }
  };
  return (
    <div className="w-full max-w-[480px] text-left">
      <div className="max-h-[236px] overflow-y-auto rounded-card border border-[var(--ab-hairline)] bg-[color-mix(in_srgb,var(--ab-content)_82%,transparent)] shadow-[0_18px_40px_-18px_rgba(0,0,0,.35)] backdrop-blur-md [@media(max-height:760px)]:max-h-[168px]">
        {bots.map((b, i) => {
          const on = b.providerId === APPUBOT_AI_PROVIDER_ID;
          return (
            <div key={b.id} className={cn('flex items-center gap-3 px-4 py-2.5', i > 0 ? 'border-t border-[var(--ab-hairline)]' : '')}>
              <BotAvatar bot={b} size={30} still />
              <div className="min-w-0 flex-1">
                <div className="truncate text-copy font-medium text-fg">{b.name}</div>
                <div className="truncate text-note text-muted">{on ? 'On Claude until the gift ends' : 'Keeps what it uses now'}</div>
              </div>
              <Switch checked={on} disabled={busy === b.id} label={`${LAUNCH_GIFT.on.choose}: ${b.name}`} onChange={(v) => void use(b, v)} />
            </div>
          );
        })}
      </div>
      {error ? <p className="selectable mt-2 text-center text-note text-danger" role="alert">{error}</p> : null}
    </div>
  );
}

/** the post as X will show it, written and ready */
function PostPreview({ promo, text }: { promo: PromoStatus; text: string }) {
  const url = promo.launchUrl ?? LAUNCH_URL;
  let host = 'producthunt.com';
  try { host = new URL(url).host.replace(/^www\./, ''); } catch { /* the app's own */ }
  return (
    <div className="w-full max-w-[480px] rounded-card border border-[var(--ab-hairline)] bg-[color-mix(in_srgb,var(--ab-content)_82%,transparent)] px-4 py-3.5 text-left shadow-[0_18px_40px_-18px_rgba(0,0,0,.35)] backdrop-blur-md">
      <div className="flex items-center gap-2.5">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-surface-3 text-copy font-semibold text-fg-2">You</span>
        <div className="min-w-0 leading-tight">
          <div className="text-copy font-semibold text-fg">Your post</div>
          <div className="text-note text-muted">on X · ready to send</div>
        </div>
      </div>
      <p className="selectable mt-3 text-copy leading-relaxed whitespace-pre-line text-fg">{text}</p>
      <div className="mt-3 flex items-center gap-2.5 rounded-control-lg border border-[var(--ab-hairline)] px-3 py-2.5">
        <Logo size={30} className="rounded-[8px]" />
        <div className="min-w-0 leading-tight">
          <div className="truncate text-copy font-medium text-fg">AppuBot on Product Hunt</div>
          <div className="truncate text-note text-muted">{host}</div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ the steps */

const SLIDE = {
  enter: (dir: number) => ({ opacity: 0, x: 24 * dir }),
  center: { opacity: 1, x: 0, transition: { duration: 0.45, ease: EASE_OUT } },
  exit: (dir: number) => ({ opacity: 0, x: -16 * dir, transition: { duration: 0.18, ease: [0.4, 0, 1, 1] as const } }),
};

function GiftSteps({ promo, onStarted }: { promo: PromoStatus; onStarted: () => void }) {
  const [stepState, setStepState] = useState<GiftStep>(() => savedStep(promo.id));
  const [dir, setDir] = useState(1);
  /** this step's page was opened: its "next" is offered */
  const [opened, setOpened] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [waiting, setWaiting] = useState(false);
  const signedIn = useCloud((s) => !!s.view?.signedIn) || promo.signedIn;
  const signInBusy = useCloud((s) => !!s.busy.signIn);
  const starting = promo.state === 'starting' || busy;
  // Start is running (also one found running after a reload): the gift's own step
  const step: GiftStep = promo.state === 'starting' ? 'gift' : stepState;

  const setStep = (next: GiftStep) => {
    setDir(GIFT_STEPS.indexOf(next) >= GIFT_STEPS.indexOf(step) ? 1 : -1);
    saveStep(promo.id, next); setStepState(next); setOpened(false); setError(undefined);
  };
  useEffect(() => { if (signedIn) setWaiting(false); }, [signedIn]);

  // this person's post: one of the written ones at random (the backend's own words when it sent any)
  const [pick] = useState(() => postPick(promo.id));
  const postText = launchPostText(promo.postText, pick);
  const pageUrl = step === 'launch' ? promo.launchUrl ?? LAUNCH_URL : launchPostUrl(postText, promo.launchUrl);
  const openPage = () => { void native().openExternal(pageUrl); setOpened(true); };
  const start = async () => {
    setBusy(true); setError(undefined);
    try { await rpc('promo.start', {}, { timeoutMs: START_TIMEOUT_MS }); onStarted(); }
    catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  };
  const back = () => setStep(GIFT_STEPS[GIFT_STEPS.indexOf(step) - 1]!);
  const tracker = <Tracker step={step} onPick={setStep} locked={starting} />;
  const shownError = error ?? (step === 'gift' ? promo.error : undefined);

  let page: ReactNode;
  if (step === 'gift') {
    page = (
      <Page
        tracker={tracker} title={LAUNCH_GIFT.gift.title} body={LAUNCH_GIFT.gift.body}
        actions={<>
          {signedIn || starting
            ? <Button size="xl" variant="primary" icon={Sparkles} loading={starting} className="min-w-[200px]" autoFocus onClick={() => void start()}>{LAUNCH_GIFT.gift.start}</Button>
            : <Button size="xl" variant="primary" icon={LogIn} loading={signInBusy} className="min-w-[200px]" autoFocus onClick={async () => { const r = await signInToCloud(); if (r) setWaiting(true); }}>{waiting ? 'Open the sign-in again' : LAUNCH_GIFT.gift.signIn}</Button>}
          {starting ? null : <button type="button" className={QUIET} onClick={back}>{LAUNCH_GIFT.back}</button>}
        </>}
        note={
          starting ? <span role="status">{giftProgressText(promo.step)}</span>
            : shownError ? <span className="selectable text-danger" role="alert">{shownError}</span>
              : !signedIn ? (waiting ? LAUNCH_GIFT.gift.waiting : LAUNCH_GIFT.gift.signInLine)
                : LAUNCH_GIFT.gift.note
        }
      >
        <GiftTicket promo={promo} />
      </Page>
    );
  } else {
    const words = LAUNCH_GIFT[step];
    page = (
      <Page
        hero={step === 'launch' ? <Crew cheer={1} /> : undefined}
        tracker={tracker} title={words.title} body={words.body}
        actions={<>
          {opened
            ? <Button size="xl" variant="primary" iconRight={ArrowRight} className="min-w-[200px]" autoFocus onClick={() => setStep(nextGiftStep(step))}>{words.done}</Button>
            : <Button size="xl" variant="primary" icon={ExternalLink} className="min-w-[200px]" autoFocus onClick={openPage}>{words.open}</Button>}
          {opened || step !== 'launch' ? (
            <div className="flex items-center gap-1">
              {opened ? <button type="button" className={QUIET} onClick={openPage}>{words.again}</button> : null}
              {opened && step !== 'launch' ? <span aria-hidden className="text-note text-muted">·</span> : null}
              {step !== 'launch' ? <button type="button" className={QUIET} onClick={back}>{LAUNCH_GIFT.back}</button> : null}
            </div>
          ) : null}
        </>}
      >
        {step === 'post' ? <PostPreview promo={promo} text={postText} /> : undefined}
      </Page>
    );
  }

  return (
    <AnimatePresence mode="wait" custom={dir} initial={false}>
      <motion.div key={step} custom={dir} variants={SLIDE} initial="enter" animate="center" exit="exit" className="relative flex min-h-0 flex-1 flex-col">
        {page}
      </motion.div>
    </AnimatePresence>
  );
}

/** Start went through: the crew cheers, and the gift is theirs */
function GiftOn({ promo, onClose }: { promo: PromoStatus; onClose: () => void }) {
  const [cheer, setCheer] = useState(1);
  useEffect(() => { const t = window.setTimeout(() => setCheer(2), 500); return () => window.clearTimeout(t); }, []);
  return (
    <Page
      hero={<Crew cheer={cheer} />} title={LAUNCH_GIFT.on.title} body={LAUNCH_GIFT.on.body}
      actions={<Button size="xl" variant="primary" iconRight={ArrowRight} className="min-w-[200px]" autoFocus onClick={onClose}>{LAUNCH_GIFT.on.close}</Button>}
    >
      <BotPicks />
    </Page>
  );
}
