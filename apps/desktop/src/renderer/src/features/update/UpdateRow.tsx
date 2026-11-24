/**
 * The sidebar's word on AppuBot's own update (2026-11-18, the owner's "when an update is available and downloading,
 * show it here"), a small card over Settings and Connect apps, in their fill:
 * - downloading: a ring filling round a down arrow, "Downloading update" and the version, the percent at the right;
 * - ready: an accent tile, "Update ready" and the version, and a Restart button that restarts into it (asking first
 *   while bots work, as About does).
 * Nothing shows while AppuBot only looks for one (60 s after launch, then every 4 hours, in the background), when it is
 * up to date, or when a look failed (Settings › About says so). It is this app's own update, so it shows whichever
 * computer is on screen (`useAppUpdate` reads this Mac's).
 */
import { ArrowDown, RefreshCw } from '../../components/ui/icons';
import { Button, Icon } from '../../components/ui';
import { useAppUpdate } from '../../lib/thisMac';
import { restartToUpdate } from './restartToUpdate';

const CARD = 'flex min-w-0 items-center gap-3 rounded-card bg-surface-2 py-2.5 pr-2.5 pl-3';
const RING = 28;
const STROKE = 2.5;

/** a ring that fills with the download, the arrow inside it */
function ProgressRing({ percent }: { percent: number }) {
  const r = (RING - STROKE) / 2;
  const length = 2 * Math.PI * r;
  return (
    <span className="relative grid size-7 shrink-0 place-items-center text-fg-2">
      <svg aria-hidden width={RING} height={RING} viewBox={`0 0 ${RING} ${RING}`} className="absolute inset-0 -rotate-90">
        <circle cx={RING / 2} cy={RING / 2} r={r} fill="none" stroke="currentColor" strokeOpacity={0.14} strokeWidth={STROKE} />
        <circle
          cx={RING / 2} cy={RING / 2} r={r} fill="none" stroke="var(--ab-accent)" strokeWidth={STROKE} strokeLinecap="round"
          strokeDasharray={length} strokeDashoffset={length * (1 - percent / 100)}
          className="transition-[stroke-dashoffset] duration-500 ease-out"
        />
      </svg>
      <Icon icon={ArrowDown} size={13} />
    </span>
  );
}

function Words({ title, version }: { title: string; version?: string }) {
  return (
    <span className="flex min-w-0 flex-1 flex-col leading-tight">
      <span className="truncate text-ui font-semibold tracking-ui text-fg">{title}</span>
      {version ? <span className="truncate text-note tabular-nums text-muted">AppuBot {version}</span> : null}
    </span>
  );
}

export function UpdateRow() {
  const update = useAppUpdate();
  if (update?.state === 'downloading') {
    const percent = Math.max(0, Math.min(100, Math.round(update.percent ?? 0)));
    return (
      <div className="shrink-0 px-2 pt-1.5">
        <div role="status" aria-label={`Downloading AppuBot ${update.version ?? ''}, ${percent}%`} className={CARD}>
          <ProgressRing percent={percent} />
          <Words title="Downloading update" version={update.version} />
          <span className="shrink-0 pr-1.5 text-note font-medium tabular-nums text-muted">{percent}%</span>
        </div>
      </div>
    );
  }
  if (update?.state === 'ready') {
    return (
      <div className="shrink-0 px-2 pt-1.5">
        <div className={CARD}>
          <span className="grid size-7 shrink-0 place-items-center rounded-full bg-accent/15 text-accent">
            <Icon icon={RefreshCw} size={14} />
          </span>
          <Words title="Update ready" version={update.version} />
          <Button size="xs" variant="primary" onClick={() => void restartToUpdate(update.version)}>Restart</Button>
        </div>
      </div>
    );
  }
  return null;
}
