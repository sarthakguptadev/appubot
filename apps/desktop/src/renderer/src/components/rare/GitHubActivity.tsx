/**
 * GitHubActivity: a year of days as a grid of squares, a column a week, each square stronger the more happened that
 * day; the columns sweep in left to right, a square says its day on hover, and a frosted panel at the bottom stacks
 * the top few as overlapping avatars that fly out into a list when it opens.
 *
 * Ported from Rare UI's `components/ui/github-activity.tsx` (https://rareui.com).
 * Copyright (c) 2026 Swami Malode. MIT + Commons Clause + Attribution (apps/desktop/scripts/licenses/RareUI.txt).
 *
 * The grid, its sweep, the tooltip, the panel, the avatars' shared-layout flight, the chevron and every spring are
 * Rare UI's. Changed for AppuBot's Usage page (features/settings/sections/Usage.tsx): nothing is fetched (Rare UI
 * reads a GitHub user's calendar and events from the network; this takes its days and its top rows from the caller,
 * so nothing leaves the computer); the heading and each day's words are the caller's (`heading`, `describe`), a top
 * row's count is any text ("1.2M") and it has no link; a day may be `unknown` (nothing was counted then: drawn
 * fainter, never as a day with no use); `fill` makes the card as wide as its place instead of as wide as its
 * columns; month names follow the app's language; colours are the app's.
 */
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type PointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useReducedMotion, type Transition } from 'motion/react';
import { cn } from '../ui/cn';

export type ActivityLevel = 0 | 1 | 2 | 3 | 4;

export type ActivityDay = {
  /** YYYY-MM-DD; the first day is a Sunday, so every column is a week */
  date: string;
  count: number;
  level: ActivityLevel;
  /** nothing was counted that day (before the count began) */
  unknown?: boolean;
};

export type ActivityTop = {
  name: string;
  /** as it should read ("1.2M") */
  count: ReactNode;
  logo?: ReactNode;
};

const DEFAULT_ACCENT = '#39d353';
const DEFAULT_CELL_SIZE = 11;
const DEFAULT_MONTHS = 12;
const WEEKS_PER_MONTH = 365.25 / 12 / 7;
const STACK_LIMIT = 3;
const MIN_CARD_WIDTH = 320;
const MIN_LABEL_WEEKS = 3;
// the p-4 on the card, both sides; the width math below has to add it back
const CARD_PADDING = 32;

const gapFor = (cellSize: number) => Math.max(2, Math.round(cellSize / 4));
// never zero: weeks.slice(-0) would hand back the whole history instead of nothing
const weeksFor = (months: number) => Math.max(1, Math.ceil(months * WEEKS_PER_MONTH));

const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

const EASE_OUT = [0.22, 1, 0.36, 1] as const;
const SPRING = { type: 'spring', bounce: 0.2, duration: 0.62 } as const;
const HEADER_SPRING = { ...SPRING, bounce: 0.45 } as const;
const ROW_SPRING = { ...SPRING, bounce: 0.26, delay: 0.08 } as const;
const ROW_OFFSET = 16;
const CELL_FADE = { duration: 0.2, ease: EASE_OUT } as const;
const TOOLTIP_FADE = { duration: 0.14, ease: EASE_OUT } as const;
const TOOLTIP_EDGE = 8;
const COLUMN_STAGGER = 0.012;
const LABEL_BLUR = 6;
const LABEL_REVEAL = { duration: 0.45, ease: EASE_OUT } as const;

const LEVELS = [0, 1, 2, 3, 4] as const;

function monthNames(locale: string | undefined): string[] {
  try {
    const f = new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' });
    return Array.from({ length: 12 }, (_, m) => f.format(new Date(Date.UTC(2024, m, 15))));
  } catch {
    return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  }
}

function toMonthLabels(weeks: ActivityDay[][], names: string[]) {
  const labels: (string | null)[] = weeks.map(() => null);
  const monthAt = (index: number) => weeks[index]?.[0]?.date.slice(5, 7);

  let start = 0;
  for (let i = 1; i <= weeks.length; i++) {
    if (i < weeks.length && monthAt(i) === monthAt(start)) continue;
    // a shorter run is narrower than the label itself, so it would sit under the next month
    if (i - start >= MIN_LABEL_WEEKS) labels[start] = names[Number(monthAt(start)) - 1] ?? null;
    start = i;
  }

  return labels;
}

const LEVEL_OPACITY: Record<ActivityLevel, number> = { 0: 0, 1: 0.3, 2: 0.52, 3: 0.76, 4: 1 };

type LevelStyle = { backgroundColor: string; opacity: number };

type HoveredDay = { day: ActivityDay; x: number; y: number };

function toScale(accent: string | string[]): LevelStyle[] {
  if (typeof accent === 'string') return LEVELS.map((level) => ({ backgroundColor: accent, opacity: LEVEL_OPACITY[level] }));

  const colors = accent.length > 4 ? accent : ['transparent', ...accent];
  return LEVELS.map((level) => {
    const color = colors[level] ?? colors.at(-1) ?? 'transparent';
    return { backgroundColor: color, opacity: color === 'transparent' ? 0 : 1 };
  });
}

function toWeeks(days: ActivityDay[]) {
  const weeks: ActivityDay[][] = [];
  for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7));
  return weeks;
}

function useFittedColumns(cellSize: number, gap: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [columns, setColumns] = useState<number>();

  useIsoLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const measure = () => setColumns(Math.max(1, Math.floor((el.clientWidth + gap) / (cellSize + gap))));

    measure();
    if (typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [cellSize, gap]);

  return [ref, columns] as const;
}

const Tooltip = ({ hovered, text, reduceMotion }: { hovered: HoveredDay; text: string; reduceMotion: boolean | null }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [left, setLeft] = useState(hovered.x);

  useIsoLayoutEffect(() => {
    const half = (ref.current?.offsetWidth ?? 0) / 2;
    const edge = TOOLTIP_EDGE + half;
    setLeft(Math.min(Math.max(hovered.x, edge), window.innerWidth - edge));
  }, [hovered]);

  return createPortal(
    <div className="pointer-events-none fixed z-[90]" style={{ left, top: hovered.y, transform: 'translate(-50%, calc(-100% - 8px))' }}>
      <motion.div
        ref={ref}
        className="rounded-lg bg-fg px-2 py-1 text-[11px] font-medium whitespace-nowrap text-[var(--ab-content)] shadow-md"
        initial={reduceMotion ? false : { opacity: 0, scale: 0.94 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.94 }}
        transition={reduceMotion ? { duration: 0 } : TOOLTIP_FADE}
      >
        {text}
      </motion.div>
    </div>,
    document.body,
  );
};

const ActivityGrid = ({
  days,
  scale,
  cellSize,
  months,
  showMonths,
  label,
  describe,
  locale,
  reduceMotion,
}: {
  days: ActivityDay[];
  scale: LevelStyle[];
  cellSize: number;
  months: number;
  showMonths: boolean;
  label: string;
  describe: (day: ActivityDay) => string;
  locale: string | undefined;
  reduceMotion: boolean | null;
}) => {
  const weeks = useMemo(() => toWeeks(days), [days]);
  const names = useMemo(() => monthNames(locale), [locale]);
  const gap = gapFor(cellSize);
  const [ref, columns] = useFittedColumns(cellSize, gap);
  const [hovered, setHovered] = useState<HoveredDay>();

  const cap = Math.min(weeks.length, weeksFor(months));
  const visible = weeks.slice(-Math.min(cap, columns ?? cap));
  const sweepEnd = (visible.length - 1) * COLUMN_STAGGER + CELL_FADE.duration;

  const hover = (day: ActivityDay) => (event: PointerEvent) => {
    const cell = event.currentTarget.getBoundingClientRect();
    setHovered({ day, x: cell.left + cell.width / 2, y: cell.top });
  };

  return (
    <div ref={ref} data-slot="github-activity-grid" role="img" aria-label={label} className="relative">
      {showMonths && (
        <motion.div
          className="flex justify-center"
          style={{ gap, marginBottom: gap }}
          initial={reduceMotion ? false : { opacity: 0, filter: `blur(${LABEL_BLUR}px)` }}
          animate={{ opacity: 1, filter: 'blur(0px)' }}
          transition={{ ...LABEL_REVEAL, delay: reduceMotion ? 0 : sweepEnd }}
        >
          {toMonthLabels(visible, names).map((month, index) => (
            <div key={index} className="relative h-3 shrink-0" style={{ width: cellSize }}>
              {month && <span className="absolute top-0 left-0 text-[10px] leading-none whitespace-nowrap text-muted">{month}</span>}
            </div>
          ))}
        </motion.div>
      )}

      <div className="flex justify-center overflow-hidden" style={{ gap }} onPointerLeave={() => setHovered(undefined)}>
        {visible.map((week, weekIndex) => (
          <div key={week[0]?.date ?? weekIndex} className="flex flex-col" style={{ gap }}>
            {week.map((day) => (
              <motion.div
                key={day.date}
                onPointerEnter={hover(day)}
                className={cn('shrink-0 rounded-[3px]', day.unknown ? 'bg-[color-mix(in_srgb,var(--ab-fg)_3.5%,transparent)]' : 'bg-[color-mix(in_srgb,var(--ab-fg)_8%,transparent)]')}
                style={{ width: cellSize, height: cellSize }}
                initial={reduceMotion ? false : { opacity: 0, scale: 0.4 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ ...CELL_FADE, delay: reduceMotion ? 0 : weekIndex * COLUMN_STAGGER }}
              >
                <div className="h-full w-full rounded-[3px]" style={scale[day.level] ?? scale[0]} />
              </motion.div>
            ))}
          </div>
        ))}
      </div>

      <AnimatePresence>{hovered && <Tooltip key="tooltip" hovered={hovered} text={describe(hovered.day)} reduceMotion={reduceMotion} />}</AnimatePresence>
    </div>
  );
};

const Avatar = ({ top, layoutId, transition, className }: { top: ActivityTop; layoutId: string; transition: Transition; className?: string }) => (
  <motion.span
    layoutId={layoutId}
    transition={transition}
    className={cn(
      'grid size-7 shrink-0 place-items-center overflow-hidden rounded-full bg-[color-mix(in_srgb,var(--ab-fg)_15%,var(--ab-surface))] text-[11px] font-medium text-fg-2 uppercase ring-2 ring-[var(--ab-surface)]',
      '[&_img]:size-full [&_img]:object-cover',
      className,
    )}
  >
    {top.logo ?? top.name.charAt(0)}
  </motion.span>
);

const TopRow = ({ top, layoutId, transition }: { top: ActivityTop; layoutId: string; transition: Transition }) => (
  <div className="mx-2 flex items-center gap-3 rounded-xl px-2 py-2 hover:bg-[color-mix(in_srgb,var(--ab-fg)_5%,transparent)]">
    <Avatar top={top} layoutId={layoutId} transition={transition} />
    <span className="flex-1 truncate text-sm text-fg">{top.name}</span>
    <span className="text-sm text-fg-2 tabular-nums">{top.count}</span>
  </div>
);

const Chevron = ({ open, transition }: { open: boolean; transition: Transition }) => (
  <motion.svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
    className="size-7 text-[#C4C9CC] dark:text-[#3E4346]"
    initial={false}
    animate={{ rotate: open ? 180 : 0 }}
    transition={transition}
  >
    <circle cx="12" cy="12" r="10" />
    <path d="m16 10-4 4-4-4" />
  </motion.svg>
);

export type GitHubActivityProps = ComponentProps<'div'> & {
  days: ActivityDay[];
  tops?: ActivityTop[];
  heading: string;
  /** a square's words on hover */
  describe: (day: ActivityDay) => string;
  accent?: string | string[];
  cellSize?: number;
  months?: number;
  showMonths?: boolean;
  /** the panel's line ("Most used:") */
  label?: string;
  /** as wide as its place, the columns fitted to it */
  fill?: boolean;
  locale?: string;
  showLabel?: string;
  hideLabel?: string;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

const GitHubActivity = ({
  className,
  days,
  tops = [],
  heading,
  describe,
  accent = DEFAULT_ACCENT,
  cellSize = DEFAULT_CELL_SIZE,
  months = DEFAULT_MONTHS,
  showMonths = false,
  label = 'Top:',
  fill = false,
  locale,
  showLabel = 'Show the list',
  hideLabel = 'Hide the list',
  defaultOpen = false,
  open: openProp,
  onOpenChange,
  style,
  ...props
}: GitHubActivityProps) => {
  const reduceMotion = useReducedMotion();
  const uid = useId();
  const [openState, setOpenState] = useState(defaultOpen);

  const open = openProp ?? openState;
  const toggle = () => {
    if (openProp === undefined) setOpenState(!open);
    onOpenChange?.(!open);
  };

  const scale = useMemo(() => toScale(accent), [accent]);
  const transition = reduceMotion ? { duration: 0 } : SPRING;
  const headerTransition = reduceMotion ? { duration: 0 } : HEADER_SPRING;
  const rowTransition = reduceMotion ? { duration: 0 } : ROW_SPRING;

  const kick = reduceMotion ? {} : { x: ROW_OFFSET, y: ROW_OFFSET };
  const listMotion = { initial: { opacity: 0, ...kick }, animate: { opacity: 1, x: 0, y: 0 }, exit: { opacity: 0, ...kick } };

  const gap = gapFor(cellSize);
  const columns = Math.min(Math.ceil(days.length / 7), weeksFor(months));
  const width = Math.max(MIN_CARD_WIDTH, columns * (cellSize + gap) - gap + CARD_PADDING);

  return (
    <div
      data-slot="github-activity"
      className={cn('relative max-w-full overflow-hidden rounded-[28px] bg-surface p-4', fill && 'w-full', tops.length > 0 && 'pb-[76px]', className)}
      style={fill ? style : { width, ...style }}
      {...props}
    >
      <p className="mb-4 px-1.5 text-base font-medium text-fg">{heading}</p>

      <ActivityGrid days={days} scale={scale} cellSize={cellSize} months={months} showMonths={showMonths} label={heading} describe={describe} locale={locale} reduceMotion={reduceMotion} />

      {tops.length > 0 && (
        <motion.div
          layout
          id={`${uid}-panel`}
          data-slot="github-activity-panel"
          data-state={open ? 'open' : 'closed'}
          className={cn('absolute inset-x-3 bottom-3 overflow-hidden bg-[color-mix(in_srgb,color-mix(in_srgb,var(--ab-fg)_7%,var(--ab-surface))_92%,transparent)] backdrop-blur-xl', open && 'top-3')}
          style={{ borderRadius: 18 }}
          transition={transition}
        >
          <motion.div layout="position" transition={headerTransition} className="flex items-center justify-between gap-3 px-4 py-3">
            <span className="truncate text-sm text-fg">{label}</span>

            <div className="flex items-center gap-3">
              {!open && (
                <div className="flex items-center">
                  {tops.slice(0, STACK_LIMIT).map((top, index) => (
                    <Avatar key={index} top={top} layoutId={`${uid}-${index}`} transition={transition} className="-ml-2 first:ml-0" />
                  ))}
                </div>
              )}

              <button
                type="button"
                onClick={toggle}
                aria-expanded={open}
                aria-controls={`${uid}-panel`}
                aria-label={open ? hideLabel : showLabel}
                className="grid size-7 shrink-0 place-items-center rounded-full"
              >
                <Chevron open={open} transition={transition} />
              </button>
            </div>
          </motion.div>

          <AnimatePresence initial={false} mode="popLayout">
            {open && (
              <motion.ul key="list" layout="position" {...listMotion} transition={rowTransition} className="px-0.5 pb-1">
                {tops.map((top, index) => (
                  <li key={index}>
                    <TopRow top={top} layoutId={`${uid}-${index}`} transition={transition} />
                  </li>
                ))}
              </motion.ul>
            )}
          </AnimatePresence>
        </motion.div>
      )}
    </div>
  );
};

export { GitHubActivity };
export default GitHubActivity;
