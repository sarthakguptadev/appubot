/**
 * The sidebar's cloud card (chat-core `CLOUD_PROMO`, `cloudPromoShows`): above Settings and Connect apps, for people
 * without a cloud computer (`useCloudOfferEligible`), under What's new's card. Its picture is drawn here in the app's
 * own flat look (2026-11-17, the owner's "card and UI don't match at all": the painting that topped it, a twilight
 * river in purples and pinks, had nothing of the app in it): the person's own bots, as the roster draws them, riding a
 * cloud at night (`Scene`: ink tints over the sidebar's tone, the bots the only colour, so it follows the colour scheme
 * and the chosen background; they bob, the stars twinkle, and the bots cheer when the pointer comes onto the card). Under
 * it the roster's type and the offer as a small filled pill. It opens Settings › Billing's plan cards ("Try free for 3
 * days" while a first plan starts with the free trial). It comes back for them (the owner's calls, 2026-11-17): its ✕
 * (under the pointer) puts it away for a day, `CLOUD_PROMO_SNOOZE_MS` (localStorage `appubot.cloudPromoSnoozedUntil`),
 * and a dismissal for good saved by an older version (`appubot.cloudPromoDismissed`) is ignored. Mock:
 * `?cloud=signed-out` (or any state without a plan of one's own).
 */
import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { Bot } from '@appubot/protocol';
import { CLOUD_PROMO, CLOUD_PROMO_SNOOZE_MS, cloudPromoCta, cloudPromoFrom, cloudPromoShows, trialDaysOf } from '@appubot/chat-core';
import { ArrowRight, X } from '../../components/ui/icons';
import { BotAvatar, Icon } from '../../components/ui';
import { ui, useStore } from '../../lib/store';
import { useCloud } from './cloudAccount';
import { useCloudOfferEligible } from './cloudOffer';
import './cloudPromo.css';

const SNOOZE_KEY = 'appubot.cloudPromoSnoozedUntil';
const snoozedUntilSaved = (): number => {
  try { return Number(localStorage.getItem(SNOOZE_KEY)) || 0; } catch { return 0; }
};

type Rider = Pick<Bot, 'shape' | 'color' | 'characterId'> & { id: string };
/** who rides before the bots are here (a moment at launch): the app's own orange bot */
const STAND_IN: Rider = { id: 'stand-in', shape: 'circle', color: '#f58a2a' };
/** the stars: % across, px down, px wide, seconds into the twinkle */
const STARS: readonly (readonly [number, number, number, number])[] = [
  [7, 15, 2, 0], [17, 38, 1.5, 1.2], [29, 11, 1.5, 2.1], [42, 6, 2, 0.6], [61, 10, 1.5, 1.7], [72, 30, 2, 2.6], [94, 44, 1.5, 0.9], [80, 9, 1.5, 3.1],
];
/** a cloud: three bumps on a flat base (200 by 64) */
const CLOUD = 'M18 64A22 22 0 0 1 30 24A30 30 0 0 1 84 14A30 30 0 0 1 140 20A31 31 0 0 1 182 64Z';

function Cloud({ className, way }: { className: string; way?: 'back' }) {
  return <svg viewBox="0 0 200 64" data-way={way} className={className}><path d={CLOUD} fill="currentColor" /></svg>;
}

/** Up to three of the person's bots on a cloud, the first one in the middle and a little bigger. */
export function Scene({ cheer }: { cheer: number }) {
  const bots = useStore((s) => s.bots);
  const [lead = STAND_IN, second, third] = bots as readonly Rider[];
  const riders: { bot: Rider; size: number }[] = third && second
    ? [{ bot: second, size: 38 }, { bot: lead, size: 46 }, { bot: third, size: 38 }]
    : second ? [{ bot: lead, size: 48 }, { bot: second, size: 40 }] : [{ bot: lead, size: 52 }];
  return (
    // the scene fades into the card at its foot, so the cloud never ends on a hard line
    <span aria-hidden className="relative block h-[96px] w-full overflow-hidden [mask-image:linear-gradient(to_bottom,#000_58%,transparent)]">
      {STARS.map(([x, y, w, at], i) => (
        <span key={i} className="cp-star absolute rounded-full bg-fg" style={{ left: `${x}%`, top: y, width: w, height: w, animationDelay: `-${at}s` }} />
      ))}
      {/* a crescent moon */}
      <svg viewBox="0 0 24 24" className="absolute top-3 right-[11%] size-[13px] text-[color-mix(in_srgb,var(--ab-fg)_46%,transparent)]">
        <path d="M20.5 14.2A8.7 8.7 0 0 1 9.8 3.5a8.7 8.7 0 1 0 10.7 10.7Z" fill="currentColor" />
      </svg>
      <Cloud className="cp-wisp absolute top-[46px] left-[4%] w-10" />
      <Cloud className="cp-wisp absolute top-[56px] right-[3%] w-8" way="back" />
      {/* the cloud they ride: its back, the bots, then its front over their feet */}
      <span className="absolute bottom-[-9px] left-1/2 block h-[92px] w-[196px] -translate-x-1/2">
        <span className="cp-float absolute inset-0 block">
          <Cloud className="cp-back absolute bottom-0 left-0 w-full" />
          {/* seated in it: the front cloud covers their lower part */}
          <span className="absolute bottom-[29px] left-1/2 flex -translate-x-1/2 items-end -space-x-1.5">
            {riders.map(({ bot, size }) => <BotAvatar key={bot.id} bot={bot} size={size} cheerKey={cheer} />)}
          </span>
          <Cloud className="cp-front absolute bottom-[-7px] left-1/2 w-[152px] -translate-x-1/2" />
        </span>
      </span>
    </span>
  );
}

export function CloudPromoCard() {
  const eligible = useCloudOfferEligible();
  const loaded = useCloud((s) => !!s.view);
  const cheapest = useCloud((s) => (s.view?.catalog?.plans ?? [])
    .map((p) => p.monthly)
    .filter((p): p is NonNullable<typeof p> => !!p)
    .sort((a, b) => a.amount - b.amount)[0]?.display);
  // a first plan starts with the free trial: the link says so
  const trialDays = useCloud((s) => trialDaysOf(s.view?.catalog, s.view?.signedIn ? (s.view.account ?? {}) : null));
  const cta = cloudPromoCta(trialDays);
  const [snoozedUntil, setSnoozedUntil] = useState(snoozedUntilSaved);
  const [now, setNow] = useState(() => Date.now());
  // put away for a day: back by itself when the day is over, the app left open or not
  useEffect(() => {
    if (!snoozedUntil || snoozedUntil <= now) return;
    const t = setTimeout(() => setNow(Date.now()), Math.min(snoozedUntil - now + 500, 2 ** 31 - 1));
    return () => clearTimeout(t);
  }, [snoozedUntil, now]);
  const snooze = () => {
    const until = Date.now() + CLOUD_PROMO_SNOOZE_MS;
    try { localStorage.setItem(SNOOZE_KEY, String(until)); } catch { /* kept for this run only */ }
    setNow(Date.now());
    setSnoozedUntil(until);
  };
  const shows = cloudPromoShows({ eligible, loaded, snoozedUntil, now });
  // the bots cheer each time the pointer comes onto the card
  const [cheer, setCheer] = useState(0);
  return (
    <AnimatePresence initial={false}>
      {shows ? (
        <motion.div
          key="cloud-promo"
          initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }}
          transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
          className="shrink-0 px-2 pt-1.5"
        >
          <div className="group relative">
            <button
              type="button"
              onClick={() => ui.openSettings('billing')}
              onMouseEnter={() => setCheer((n) => n + 1)}
              aria-label={`${CLOUD_PROMO.title}: ${cta}`}
              className="no-drag squircle flex w-full flex-col overflow-hidden rounded-[14px] bg-surface-2 text-left hover:bg-surface-3 focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_var(--ab-bg),0_0_0_4px_var(--ab-ring)]"
            >
              <Scene cheer={cheer} />
              <span className="flex flex-col px-3 pt-1.5 pb-3">
                <span className="text-ui leading-[18px] font-semibold tracking-ui text-fg">{CLOUD_PROMO.title}</span>
                <span className="mt-0.5 line-clamp-2 text-[12.5px] leading-[17px] text-[color-mix(in_srgb,var(--ab-fg)_52%,transparent)]">{CLOUD_PROMO.line}</span>
                <span className="mt-2.5 flex items-center gap-2">
                  {/* the offer, as the app's own small secondary button (the whole card is the button): a white one
                      was the loudest thing in the sidebar */}
                  <span className="ab-pill squircle inline-flex h-7 shrink-0 items-center gap-1 rounded-control-sm bg-[color-mix(in_srgb,var(--ab-fg)_10%,transparent)] pr-2 pl-2.5 text-[12.5px] leading-none font-semibold text-fg group-hover:bg-[color-mix(in_srgb,var(--ab-fg)_15%,transparent)]">
                    {cta}
                    <Icon icon={ArrowRight} size={13} className="transition-transform duration-200 group-hover:translate-x-0.5" />
                  </span>
                  {cheapest ? <span className="min-w-0 truncate text-[12.5px] leading-[17px] text-[color-mix(in_srgb,var(--ab-fg)_46%,transparent)]">{cloudPromoFrom(trialDays, cheapest)}</span> : null}
                </span>
              </span>
              {/* the card's hairline */}
            </button>
            {/* put away for a day (under the pointer, or with the keyboard) */}
            <button
              type="button"
              onClick={snooze}
              aria-label="Hide for a day"
              title="Hide for a day"
              className="no-drag ab-pill absolute top-2 right-2 grid size-6 place-items-center rounded-full bg-[color-mix(in_srgb,var(--ab-fg)_14%,var(--ab-tone-side))] text-[color-mix(in_srgb,var(--ab-fg)_62%,transparent)] opacity-0 outline-none group-hover:opacity-100 hover:text-fg focus-visible:opacity-100 focus-visible:shadow-[0_0_0_2px_var(--ab-ring)]"
            >
              <Icon icon={X} size={12} strokeWidth={2.2} />
            </button>
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
