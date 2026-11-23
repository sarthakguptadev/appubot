// Settings › Storage (after T3 Code's): how much room AppuBot takes on this computer (one figure, a bar split into its
// parts and a row a part: `SpaceHead`, `PartRow`), and how long it keeps chat
// files and its own logs (`settings.storage`; core `StorageService` deletes what's older, `storage.clean` at once).
import { useEffect, useState } from 'react';
import { bytes, timeAgo } from '@appubot/chat-core';
import type { Settings, StorageItem, StorageSummary } from '@appubot/protocol';
import { Button, Icon, Select, cn } from '../../../components/ui';
import { Bot, Cloud, Eraser, FolderOpen, Mic, Paperclip, ScrollText, type IconComponent } from '../../../components/ui/icons';
import { RollingText } from '../../../components/rare/AnimatedCounter';
import { call } from '../../../lib/actions';
import { remember, useRemembered } from '../../../lib/remembered';
import { SHOW_IN_FOLDER } from '../../../lib/platform';
import { useThisComputer } from '../../cloud/thisComputer';
import { useStore } from '../../../lib/store';
import { native } from '../../../lib/native';
import { KEEP_FILES_TITLE, KEEP_LOGS_TITLE, STORAGE_TITLE } from '../nav';
import { SETTINGS_ROW, SETTINGS_ROW_DESCRIPTION, SETTINGS_ROW_TITLE, SectionLoading, SettingRow, SettingsGroup, updateSettings } from './shared';

/** a part of what AppuBot keeps: the computer's own items, and what this Mac keeps of AppuBot computers */
type PartId = StorageItem['id'] | 'cloud';
interface Part { id: PartId; bytes: number; count?: number; path?: string }

/**
 * Each part's words, icon and colour. The colour belongs to the part, never to its place in the list (a part that
 * shrinks keeps its own), in a fixed order of hues stepped for each theme and checked for colour-blind separation on
 * both card surfaces; names and amounts sit beside every colour, so none is read by colour alone.
 */
const PARTS: Record<PartId, { title: string; description: string; icon: IconComponent; fill: string }> = {
  files: { title: 'Files in chats', description: 'Pictures and files you sent, files bots made for you, pages and voice messages.', icon: Paperclip, fill: 'bg-[#2a78d6] dark:bg-[#3987e5]' },
  logs: { title: 'Logs', description: 'What AppuBot noted while it ran, for when something goes wrong.', icon: ScrollText, fill: 'bg-[#eb6834] dark:bg-[#d95926]' },
  voice: { title: 'Voice models', description: 'Speech models for voice mode and dictation (remove them in Voice).', icon: Mic, fill: 'bg-[#1baf7a] dark:bg-[#199e70]' },
  agents: { title: 'Downloaded agents', description: 'Agents added from More agents (remove them in Providers).', icon: Bot, fill: 'bg-[#eda100] dark:bg-[#c98500]' },
  cloud: { title: 'AppuBot computers’ pages and files', description: 'Kept so their chats show at once. Signing out removes them.', icon: Cloud, fill: 'bg-[#e87ba4] dark:bg-[#d55181]' },
};

const FILE_DAYS = [0, 30, 90, 180, 365];
/** how much of each AppuBot computer's pages and files this Mac keeps to show them at once (`cloudCopyMb`) */
const CLOUD_COPY_MB = [250, 500, 1000, 2000, 5000];
const KEEP_CLOUD_TITLE = 'Keep of each AppuBot computer';
const mbLabel = (mb: number): string => (mb >= 1000 ? `${mb / 1000} GB` : `${mb} MB`);
const LOG_DAYS = [7, 14, 30, 90];

const daysLabel = (d: number): string => (d === 0 ? 'Forever' : d === 365 ? '1 year' : `${d} days`);

function countText(part: Part): string {
  if (part.count === undefined) return '';
  const one = part.count === 1;
  return part.id === 'files' ? `${part.count} file${one ? '' : 's'}` : part.id === 'logs' ? `${part.count} log${one ? '' : 's'}` : `${part.count} item${one ? '' : 's'}`;
}

/** a part's share of the whole, for people: "under 1%" for a sliver, never "0%" for something that is there */
function shareText(bytesOf: number, total: number): string {
  if (!total || !bytesOf) return '';
  const pct = (bytesOf / total) * 100;
  return pct < 1 ? 'under 1%' : `${Math.round(pct)}%`;
}

/**
 * How much AppuBot keeps, as one figure and one bar split into its parts, the biggest first. The bar is the whole
 * (8px, round ends, a 2px gap of the card between parts, a sliver still wide enough to see); it grows in once.
 * Pointing at a part, in the bar or in its row, dims the others.
 */
function SpaceHead({ parts, total, where, cleanedAt, freedBytes, hot, onHot }: {
  parts: Part[]; total: number; where: string; cleanedAt?: number; freedBytes?: number; hot: PartId | null; onHot: (id: PartId | null) => void;
}) {
  const [grown, setGrown] = useState(false);
  useEffect(() => { const f = requestAnimationFrame(() => setGrown(true)); return () => cancelAnimationFrame(f); }, []);
  const shown = parts.filter((p) => p.bytes > 0);
  const [amount = '0', unit = 'B'] = (bytes(total) || '0 B').split(' ');
  const label = shown.map((p) => `${PARTS[p.id].title}: ${bytes(p.bytes)}, ${shareText(p.bytes, total)}`).join('; ');
  return (
    <div className={cn(SETTINGS_ROW, 'flex flex-col gap-3.5 pt-4 pb-4')}>
      <div className="flex items-end justify-between gap-6">
        <div className="min-w-0">
          {/* the figure rolls when a clean-up changes it; its unit stands beside it (rolled as one text the space between went) */}
          <div className="flex items-baseline gap-1.5 text-heading leading-none font-semibold tracking-ui text-fg tabular-nums">
            <RollingText text={amount} />
            {unit ? <span className="text-title font-medium text-fg-2">{unit}</span> : null}
          </div>
          <p className="mt-1.5 text-ui text-muted">on {where}. Your bots’ own folders aren’t counted.</p>
        </div>
        {cleanedAt ? (
          <p className="shrink-0 text-note text-muted">
            Cleaned {timeAgo(cleanedAt) === 'now' ? 'just now' : `${timeAgo(cleanedAt)} ago`}{freedBytes ? ` · freed ${bytes(freedBytes)}` : ''}
          </p>
        ) : null}
      </div>
      <div role="img" aria-label={label || 'Nothing kept yet'} className="flex h-2 w-full gap-[2px]" onMouseLeave={() => onHot(null)}>
        {shown.length ? shown.map((p) => (
          <span
            key={p.id}
            onMouseEnter={() => onHot(p.id)}
            className={cn('h-full min-w-1 rounded-full transition-[flex-grow,opacity] duration-700 ease-rare motion-reduce:transition-none', PARTS[p.id].fill, hot && hot !== p.id && 'opacity-30')}
            style={{ flexGrow: grown ? p.bytes : 0, flexBasis: 0 }}
          />
        )) : <span className="h-full w-full rounded-full bg-[color-mix(in_srgb,var(--ab-fg)_8%,transparent)]" />}
      </div>
    </div>
  );
}

/** One part: its colour and icon, what it is, how much, its share, and where it is on this computer. */
function PartRow({ part, total, hot, onHot }: { part: Part; total: number; hot: PartId | null; onHot: (id: PartId | null) => void }) {
  // a remote computer's folders can't be shown in this Mac's Finder
  const { remote } = useThisComputer();
  const { title, description, icon, fill } = PARTS[part.id];
  const second = [countText(part), shareText(part.bytes, total)].filter(Boolean).join(' · ');
  return (
    <div
      onMouseEnter={() => onHot(part.id)} onMouseLeave={() => onHot(null)}
      className={cn(SETTINGS_ROW, 'flex items-center gap-3.5 transition-opacity duration-200', hot && hot !== part.id && 'opacity-45')}
    >
      {/* the part's colour as a tile behind its icon: the same colour as its stretch of the bar */}
      <span className={cn('squircle grid size-8 shrink-0 place-items-center rounded-control text-white', fill)}>
        <Icon icon={icon} size={16} />
      </span>
      <div className="min-w-0 flex-1 space-y-0.5">
        <h3 className={SETTINGS_ROW_TITLE}>{title}</h3>
        <p className={SETTINGS_ROW_DESCRIPTION}>{description}</p>
      </div>
      <div className="flex shrink-0 flex-col items-end">
        <span className="text-copy font-medium text-fg tabular-nums">{bytes(part.bytes) || '0 B'}</span>
        {second ? <span className="text-note text-muted tabular-nums">{second}</span> : null}
      </div>
      {remote || !part.path || part.id === 'cloud' ? null : (
        <Button size="xs" variant="ghost" icon={FolderOpen} className="text-muted" onClick={() => void native().showInFolder(part.path!)}>{SHOW_IN_FOLDER}</Button>
      )}
    </div>
  );
}

export function StorageSection() {
  const settings = useStore((s) => s.settings);
  const [cleaning, setCleaning] = useState(false);
  // the part pointed at, in the bar or its row: the others dim
  const [hot, setHot] = useState<PartId | null>(null);
  // the last measure shows at once (lib/remembered.ts, per computer), measured again behind it
  const { data: summary, reload: load } = useRemembered<StorageSummary>('storage', () =>
    call('storage.summary', {}, { errorTitle: 'Couldn’t measure storage', timeoutMs: 60_000 }));

  const storage: Settings['storage'] | undefined = settings?.storage;
  const set = (patch: Partial<Settings['storage']>) => {
    if (!storage) return;
    // a shorter keep deletes at once (core), so the sizes are measured again after it
    void updateSettings({ storage: { ...storage, ...patch } }).then(() => setTimeout(() => void load(), 1500));
  };
  const clean = async () => {
    setCleaning(true);
    const res = await call('storage.clean', {}, { errorTitle: 'Couldn’t clean up', timeoutMs: 120_000 });
    setCleaning(false);
    if (res) remember('storage', res);
  };

  const computer = useThisComputer();
  if (!summary || !storage) return <SectionLoading />;
  // every part, the biggest first: the bar and the rows under it in one order
  const parts: Part[] = [...summary.items, ...(summary.cloudCopies ? [{ id: 'cloud' as const, ...summary.cloudCopies }] : [])].sort((x, y) => y.bytes - x.bytes);
  const total = parts.reduce((n, i) => n + i.bytes, 0);
  return (
    <div className="space-y-6">
      <SettingsGroup
        title={STORAGE_TITLE}
        action={<Button size="xs" variant="secondary" icon={Eraser} loading={cleaning} onClick={() => void clean()}>Clean up now</Button>}
      >
        <SpaceHead parts={parts} total={total} where={computer.name} cleanedAt={summary.cleanedAt} freedBytes={summary.freedBytes} hot={hot} onHot={setHot} />
        {parts.map((part) => <PartRow key={part.id} part={part} total={total} hot={hot} onHot={setHot} />)}
      </SettingsGroup>
      <SettingsGroup title="Keep">
        <SettingRow
          title={KEEP_FILES_TITLE}
          description="Older ones are deleted: their chats show them as no longer there. Copies in your bots’ inbox folders stay."
        >
          <Select aria-label={KEEP_FILES_TITLE} fit value={storage.filesDays} onChange={(e) => set({ filesDays: Number(e.target.value) })}>
            {FILE_DAYS.map((d) => <option key={d} value={d}>{daysLabel(d)}</option>)}
          </Select>
        </SettingRow>
        <SettingRow title={KEEP_LOGS_TITLE} description="AppuBot’s own log files, one a day.">
          <Select aria-label={KEEP_LOGS_TITLE} fit value={storage.logsDays} onChange={(e) => set({ logsDays: Number(e.target.value) })}>
            {LOG_DAYS.map((d) => <option key={d} value={d}>{daysLabel(d)}</option>)}
          </Select>
        </SettingRow>
        {/* what this Mac keeps of AppuBot computers: only this Mac has such copies (a core from before has no setting) */}
        {!computer.remote && storage.cloudCopyMb !== undefined ? (
          <SettingRow
            title={KEEP_CLOUD_TITLE}
            description="Pages and files a bot showed on your AppuBot computer, kept here so its chats show them at once, even while it sleeps. The least recently shown go first."
          >
            <Select aria-label={KEEP_CLOUD_TITLE} fit value={storage.cloudCopyMb} onChange={(e) => set({ cloudCopyMb: Number(e.target.value) })}>
              {[...new Set([...CLOUD_COPY_MB, storage.cloudCopyMb])].sort((a, b) => a - b).map((mb) => <option key={mb} value={mb}>{mbLabel(mb)}</option>)}
            </Select>
          </SettingRow>
        ) : null}
      </SettingsGroup>
    </div>
  );
}
