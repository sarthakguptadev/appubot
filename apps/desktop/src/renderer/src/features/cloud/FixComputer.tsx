import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { CloudBackup, CloudComputer, CloudRepair, CloudRepairKind } from '@appubot/protocol';
import {
  FIX_DESCRIPTION, FIX_TITLE, REPAIR_KINDS, REPAIR_OPTIONS, RESET_CONFIRM_WORD, backupLabel, defaultResetBackup, resetWarning, upToDateText,
  fixOffer, repairCard, updateLine,
} from '@appubot/chat-core';
import { AlertTriangle, Check, CheckCircle2, RefreshCw, RotateCcw, Wrench, XCircle, type IconComponent } from '../../components/ui/icons';
import { Button, Dialog, Field, Icon, Input, SETTINGS_ROW, SETTINGS_ROW_DESCRIPTION, SETTINGS_ROW_TITLE, Spinner, cn } from '../../components/ui';
import { useNow } from '../../lib/hooks';
import { SettingRow, SettingsGroup } from '../settings/sections/shared';
import { busyKey, fixStart, loadBackups, repairComputer, useCloud } from './cloudAccount';

/*
 * Fix your computer (plan §6.9, D34): Update, Recover and Reset for the person's AppuBot computer (a team's for its
 * admins), each with what it keeps and one note, a confirmation (Reset: pick a saved copy and type "reset"), and
 * the repair's progress and result as the backend reports it (`computer.repair`, read every few seconds while it runs).
 * A computer on the newest version shows "Up to date · version N" in Update's place.
 */

const KIND_ICON: Record<CloudRepairKind, IconComponent> = { update: RefreshCw, recover: Wrench, reset: RotateCcw };

/** The section: a running or recent repair's card, then the three actions (for whoever may fix it). */
export function FixComputerGroup({ computer, team, admin = true, title = FIX_TITLE, inline }: {
  computer: CloudComputer | undefined; team?: string; admin?: boolean; title?: string;
  /** just the rows, for a card of the caller's (Settings › Account's Manage) */
  inline?: boolean;
}) {
  const [open, setOpen] = useState<CloudRepairKind | null>(() => { const k = !team ? fixStart.kind : undefined; if (k) fixStart.kind = undefined; return k ?? null; });
  const offer = fixOffer(computer, admin);
  if (!offer.show) return null;
  const version = computer?.computer?.version;
  const rows: ReactNode = (
    <>
      {offer.repair ? <RepairProgress repair={offer.repair} /> : null}
      {offer.canFix ? REPAIR_KINDS.map((kind) => {
        const opt = REPAIR_OPTIONS[kind];
        return (
          <SettingRow key={kind} title={opt.title} description={kind === 'update' ? updateLine(offer, version) : `${opt.summary} ${opt.when}`}>
            {kind === 'update' && offer.upToDate
              ? <span className="text-copy text-muted tabular-nums">{upToDateText(version)}</span>
              : <Button size="sm" variant={opt.danger ? 'danger' : 'outline'} icon={KIND_ICON[kind]} disabled={offer.running} onClick={() => setOpen(kind)}>{opt.title}…</Button>}
          </SettingRow>
        );
      }) : null}
      {offer.note && (offer.running || !offer.canFix) ? <p className={cn(SETTINGS_ROW, 'py-2.5 text-note leading-4 text-muted')}>{offer.note}</p> : null}
      <RepairDialog kind={open} team={team} version={version} onClose={() => setOpen(null)} />
    </>
  );
  return inline ? rows : <SettingsGroup title={title} description={FIX_DESCRIPTION}>{rows}</SettingsGroup>;
}

/** A repair as it runs (the step and a bar) or as it ended (the result, what's left to do). */
export function RepairProgress({ repair }: { repair: CloudRepair }) {
  const now = useNow();
  const card = repairCard(repair, now);
  const pct = Math.round(card.fraction * 100);
  return (
    <div className={cn(SETTINGS_ROW, 'flex items-start gap-3')} aria-live="polite">
      <span className={cn('ab-pill squircle flex size-9 shrink-0 items-center justify-center rounded-control bg-surface-2', card.tone === 'failed' ? 'text-danger' : card.tone === 'done' ? 'text-success' : 'text-fg-2')}>
        {card.tone === 'running' ? <Spinner size={16} /> : <Icon icon={card.tone === 'done' ? CheckCircle2 : XCircle} size={18} />}
      </span>
      <div className="min-w-0 flex-1 space-y-2">
        <div className="space-y-0.5">
          <h3 className={SETTINGS_ROW_TITLE}>{card.headline}</h3>
          {card.step ? <p className={cn(SETTINGS_ROW_DESCRIPTION, 'tabular-nums')}>{card.step}</p> : null}
        </div>
        {card.tone === 'running' ? (
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={card.headline}>
            <div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${pct}%` }} />
          </div>
        ) : null}
        {card.backupLine ? <p className={SETTINGS_ROW_DESCRIPTION}>{card.backupLine}.</p> : null}
        {card.notes.map((n) => <p key={n} className={cn(SETTINGS_ROW_DESCRIPTION, 'text-warning')}>{n}</p>)}
        {card.result ? <p className={cn(SETTINGS_ROW_DESCRIPTION, card.tone === 'failed' && 'text-danger')}>{card.result}</p> : null}
        {card.after ? <p className={SETTINGS_ROW_DESCRIPTION}>{card.after}</p> : null}
      </div>
    </div>
  );
}

/** What it keeps (✓), then its one note. */
function Keeps({ kind }: { kind: CloudRepairKind }) {
  const opt = REPAIR_OPTIONS[kind];
  return (
    <div className="space-y-1.5">
      <h3 className="text-note font-medium text-muted">Kept</h3>
      <ul className="space-y-1">
        {opt.keeps.map((t) => (
          <li key={t} className="flex items-start gap-2 text-copy leading-5 text-fg-2"><Icon icon={Check} size={14} className="mt-[3px] shrink-0 text-success" />{t}</li>
        ))}
      </ul>
      <p className={cn(SETTINGS_ROW_DESCRIPTION, 'pt-1')}>{opt.note}</p>
    </div>
  );
}

/**
 * The confirmation: what it does, what it keeps and its note; Reset adds the saved copies to pick from (newest nightly
 * first) and asks for "reset" typed. One request id per opening, so pressing again after a timeout is the same repair.
 */
export function RepairDialog({ kind, team, version, onClose }: { kind: CloudRepairKind | null; team?: string; version?: number; onClose: () => void }) {
  const now = useNow();
  const busy = useCloud((s) => !!s.busy[busyKey('repair', team)]);
  const loadingCopies = useCloud((s) => !!s.busy[busyKey('backups', team)]);
  const [backups, setBackups] = useState<CloudBackup[] | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const requestId = useMemo(() => (kind ? crypto.randomUUID() : ''), [kind]);
  useEffect(() => {
    setTyped(''); setPicked(null); setBackups(null);
    if (kind !== 'reset') return;
    void loadBackups(team).then((l) => {
      const list = l?.backups ?? [];
      setBackups(list);
      setPicked(defaultResetBackup(list)?.id ?? null);
    });
  }, [kind, team]);
  if (!kind) return <Dialog open={false} onClose={onClose} />;
  const opt = REPAIR_OPTIONS[kind];
  const chosen = backups?.find((b) => b.id === picked) ?? null;
  const resetOk = kind !== 'reset' || (!!chosen && typed.trim().toLowerCase() === RESET_CONFIRM_WORD);
  const go = async () => {
    if (!resetOk) return;
    const r = await repairComputer({ kind, requestId, ...(kind === 'reset' && chosen ? { backupId: chosen.id, confirm: 'reset' as const } : {}) }, team);
    if (r) onClose();
  };
  const title = kind === 'update' ? 'Update your AppuBot computer?' : kind === 'recover' ? 'Recover your AppuBot computer?' : 'Reset your AppuBot computer?';
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={title}
      description={`${opt.summary}${kind === 'update' && version !== undefined ? ` It’s on version ${version} now.` : ''} It takes a few minutes; your bots are paused meanwhile and you can keep using this app.`}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant={opt.danger ? 'danger' : 'primary'} icon={KIND_ICON[kind]} disabled={!resetOk} loading={busy} onClick={() => void go()}>{opt.confirm}</Button>
        </>
      )}
    >
      <form className="space-y-5" onSubmit={(e) => { e.preventDefault(); void go(); }}>
        <Keeps kind={kind} />
        {kind === 'reset' ? (
          <div className="space-y-2">
            <h3 className="text-copy font-medium text-fg">Go back to</h3>
            {!backups ? (
              <div className="flex items-center gap-2 text-copy text-muted">{loadingCopies ? <Spinner size={14} /> : null}Reading your saved copies…</div>
            ) : backups.length ? (
              <div role="radiogroup" aria-label="Saved copies" className="max-h-60 divide-y divide-[var(--ab-hairline)] overflow-y-auto rounded-card border border-[var(--ab-hairline)]">
                {backups.map((b) => {
                  const l = backupLabel(b, now);
                  const on = b.id === picked;
                  return (
                    <button key={b.id} type="button" role="radio" aria-checked={on} onClick={() => setPicked(b.id)} className={cn('flex w-full items-center gap-3 px-3.5 py-2.5 text-left transition-colors hover:bg-surface-2', on && 'bg-surface-2')}>
                      <span className={cn('flex size-4 shrink-0 items-center justify-center rounded-full border', on ? 'border-accent bg-accent text-white' : 'border-fg/30')}>{on ? <Icon icon={Check} size={10} /> : null}</span>
                      <span className="min-w-0 flex-1 text-copy text-fg tabular-nums">{l.title}</span>
                      <span className="shrink-0 text-note text-muted">{l.detail}</span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <p className={SETTINGS_ROW_DESCRIPTION}>There’s no saved copy yet: the first one is made tonight.</p>
            )}
            {chosen ? (
              <p className="flex items-start gap-2 text-copy leading-5 text-warning"><Icon icon={AlertTriangle} size={14} className="mt-[3px] shrink-0" />{resetWarning(chosen, now)}</p>
            ) : null}
            {chosen ? (
              <Field label={<>Type <span className="font-mono">{RESET_CONFIRM_WORD}</span> to confirm</>}>
                <Input value={typed} onChange={(e) => setTyped(e.target.value)} spellCheck={false} autoComplete="off" placeholder={RESET_CONFIRM_WORD} aria-label="Type reset to confirm" />
              </Field>
            ) : null}
          </div>
        ) : null}
      </form>
    </Dialog>
  );
}
