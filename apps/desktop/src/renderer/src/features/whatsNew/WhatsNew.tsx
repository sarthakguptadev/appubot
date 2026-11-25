/**
 * What's new (after Synara's `whatsNew/`): after an update the sidebar shows a card for the release's notes once;
 * pressing it opens them, ✕ or closing them counts as seen. The first time the app is loaded, in front and free of other
 * screens after an update, the dialog opens by itself (`useWhatsNewAutoOpen`; the card stays as the fallback).
 * The dialog also lists every release ("All updates"),
 * as does Settings › What's new. What was seen is the app version kept in localStorage; onboarding records the
 * version a new install starts on, so only updates are announced.
 */
import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { create } from 'zustand';
import { WHATS_NEW_OPEN_DELAY_MS, notesFor, releaseDate, releasesNewestFirst, whatsNewOpensNow, whatsNewToShow, type ReleaseNotes } from '@appubot/chat-core';
import { ArrowLeft, ArrowRight, ChevronRight, X } from '../../components/ui/icons';
import { Button, Dialog, Icon, Logo, cn, useDialogOpen } from '../../components/ui';
import { macSystemOf, useStore } from '../../lib/store';
import { native } from '../../lib/native';
import { SettingsCard, SettingsEmptyState } from '../settings/sections/shared';
import { RELEASES } from './releases';

const SEEN_KEY = 'appubot.whatsNewSeen';
const ALL = releasesNewestFirst(RELEASES);
/** the mock shows the newest notes as just installed: `?whatsnew=1` (or `auto`) opens them by itself as after an
 *  update, `?whatsnew=card` leaves only the sidebar card */
const PREVIEW_MODE = import.meta.env.DEV && typeof location !== 'undefined' ? new URLSearchParams(location.search).get('whatsnew') : null;
const PREVIEW = PREVIEW_MODE === '1' || PREVIEW_MODE === 'auto' || PREVIEW_MODE === 'card';
const AUTO_OPEN = PREVIEW_MODE !== 'card';
const installed = (): string => (PREVIEW ? ALL[0]?.version ?? '' : native().version);

function readSeen(): string | null {
  if (PREVIEW) return null;
  try { return localStorage.getItem(SEEN_KEY); } catch { return null; }
}

type View = { kind: 'release'; version: string } | { kind: 'all'; open?: string };

interface WhatsNewState {
  /** the notes the sidebar card announces (decided once per launch) */
  card: ReleaseNotes | undefined;
  view: View | null;
}

const useWhatsNew = create<WhatsNewState>()(() => ({ card: whatsNewToShow(RELEASES, installed(), readSeen()), view: null }));

/** Counts this version's notes as seen and hides the card (onboarding calls it too: a new install isn't told what's new). */
export function markWhatsNewSeen(): void {
  try { localStorage.setItem(SEEN_KEY, installed()); } catch { /* storage off: it shows again next launch */ }
  useWhatsNew.setState({ card: undefined });
}

/** The command palette's "What's new": this version's notes (every release if none). */
export function openWhatsNew(): void {
  const v = notesFor(RELEASES, installed())?.version;
  useWhatsNew.setState({ view: v ? { kind: 'release', version: v } : { kind: 'all' } });
}

/** Shown and focused: false while the window is hidden (a relaunch after an update, a login start) or behind others. */
export function useInFront(): boolean {
  const read = () => document.visibilityState === 'visible' && document.hasFocus();
  const [front, setFront] = useState(read);
  useEffect(() => {
    const update = () => setFront(read());
    update();
    window.addEventListener('focus', update);
    window.addEventListener('blur', update);
    document.addEventListener('visibilitychange', update);
    return () => {
      window.removeEventListener('focus', update);
      window.removeEventListener('blur', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, []);
  return front;
}

let autoOpened = false;

/**
 * After an update, opens this version's notes by itself (the dialog the sidebar card opens) once the app is loaded,
 * in front and free of other screens for `WHATS_NEW_OPEN_DELAY_MS` (chat-core `whatsNewOpensNow`). At most once
 * per launch; closing it marks the version seen like the card's, so it never comes back for this version.
 */
export function useWhatsNewAutoOpen(): void {
  const pending = useWhatsNew((s) => !!s.card) && AUTO_OPEN;
  const onboarded = useStore((s) => s.settings?.onboarded ?? false);
  const loaded = useStore((s) => s.hydrated && s.conn === 'connected');
  const inFront = useInFront();
  const dialog = useDialogOpen();
  const covered = useStore((s) => s.settingsSection !== null || s.quitPrompt !== null || s.modal !== null || s.voiceMode !== null || !!macSystemOf(s)?.update?.required);
  const ownOpen = useWhatsNew((s) => s.view !== null);
  const now = whatsNewOpensNow({ pending, onboarded, loaded, inFront, covered: covered || dialog || ownOpen });
  useEffect(() => {
    if (!now || autoOpened) return;
    const t = window.setTimeout(() => {
      const card = useWhatsNew.getState().card;
      if (!card || autoOpened) return;
      autoOpened = true;
      useWhatsNew.setState({ view: { kind: 'release', version: card.version } });
    }, WHATS_NEW_OPEN_DELAY_MS);
    return () => window.clearTimeout(t);
  }, [now]);
}

export function WhatsNewCard() {
  const card = useWhatsNew((s) => s.card);
  const lead = card?.features[0];
  return (
    <AnimatePresence initial={false}>
      {card && lead ? (
        <motion.div
          key={card.version}
          initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }}
          transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
          className="shrink-0 px-2 pt-1.5"
        >
          <div className="group relative">
            <button
              type="button"
              onClick={() => useWhatsNew.setState({ view: { kind: 'release', version: card.version } })}
              aria-label={`What’s new: ${lead.title}`}
              className="no-drag flex w-full flex-col rounded-[14px] bg-[color-mix(in_srgb,var(--ab-fg)_3.5%,transparent)] px-3 pt-2.5 pb-3 pr-9 text-left shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--ab-fg)_7%,transparent)] transition-colors duration-150 hover:bg-[color-mix(in_srgb,var(--ab-fg)_6%,transparent)] focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_var(--ab-bg),0_0_0_4px_var(--ab-ring)]"
            >
              <span className="flex items-center gap-1.5 text-note leading-[18px] font-semibold text-[color-mix(in_srgb,var(--ab-fg)_46%,transparent)]">
                <Logo size={14} />
                New in AppuBot
              </span>
              <span className="mt-1 text-ui leading-[18px] font-semibold tracking-ui text-fg">{lead.title}</span>
              <span className="mt-0.5 line-clamp-2 text-[12.5px] leading-[17px] text-[color-mix(in_srgb,var(--ab-fg)_52%,transparent)]">{lead.description}</span>
              <span className="mt-2 flex items-center gap-1 text-[12.5px] leading-[17px] font-medium text-fg">
                See what’s new
                <Icon icon={ArrowRight} size={13} className="text-fg-2 transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-fg" />
              </span>
            </button>
            <Button variant="ghost" size="icon-xs" icon={X} aria-label="Dismiss what’s new" onClick={markWhatsNewSeen} className="absolute top-2 right-2" />
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

function Features({ notes }: { notes: ReleaseNotes }) {
  return (
    <ul className="flex flex-col gap-4">
      {notes.features.map((f) => (
        <li key={f.id} className="flex flex-col gap-0.5">
          <h3 className="text-copy leading-snug font-medium text-fg">{f.title}</h3>
          <p className="text-copy leading-relaxed text-fg-2">{f.description}</p>
        </li>
      ))}
    </ul>
  );
}

function ReleaseRow({ notes, defaultOpen, divider }: { notes: ReleaseNotes; defaultOpen: boolean; divider: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <li className={cn(divider && 'hairline-b')}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2.5 rounded-control py-2.5 text-left focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_var(--ab-ring)]"
      >
        <Icon icon={ChevronRight} size={14} className={cn('shrink-0 text-muted transition-transform duration-200', open && 'rotate-90')} />
        <span className="text-copy font-medium text-fg">{releaseDate(notes.version)}</span>
        <span className="min-w-0 flex-1 truncate text-copy text-muted">{notes.features[0]?.title}</span>
        <span className="shrink-0 text-note text-muted tabular-nums">{notes.features.length} {notes.features.length === 1 ? 'update' : 'updates'}</span>
      </button>
      {open ? <div className="pt-1 pb-4 pl-6"><Features notes={notes} /></div> : null}
    </li>
  );
}

/** Every release as Settings › What's new draws it (a card of folding rows), here and in the dialog; `open` starts open. */
function ReleaseList({ open }: { open?: string }) {
  return (
    <SettingsCard>
      <ul className="flex flex-col px-3">
        {ALL.map((n, i) => <ReleaseRow key={n.version} notes={n} divider={i < ALL.length - 1} defaultOpen={n.version === open} />)}
      </ul>
    </SettingsCard>
  );
}

/** The release's notes, or every release; closing it counts the card's release as seen. */
export function WhatsNewDialog() {
  const view = useWhatsNew((s) => s.view);
  // keeps its content while it animates out
  const last = useRef(view);
  if (view) last.current = view;
  const shown = last.current;
  const release = shown?.kind === 'release' ? ALL.find((n) => n.version === shown.version) : undefined;

  const close = () => {
    if (useWhatsNew.getState().card) markWhatsNewSeen();
    useWhatsNew.setState({ view: null });
  };

  return (
    <Dialog
      open={!!view}
      onClose={close}
      size="md"
      title={release ? 'What’s new' : 'All updates'}
      description={release ? `${releaseDate(release.version)} · version ${release.version}` : 'Every release, newest first.'}
      bodyClassName="max-h-[min(60vh,520px)]"
      footer={
        release ? (
          <>
            {ALL.length > 1 ? (
              <Button variant="ghost" iconRight={ArrowRight} className="mr-auto" onClick={() => useWhatsNew.setState({ view: { kind: 'all', open: release.version } })}>
                All updates
              </Button>
            ) : null}
            <Button variant="primary" data-autofocus onClick={close}>Got it</Button>
          </>
        ) : (
          <>
            {useWhatsNew.getState().card ? (
              <Button variant="ghost" icon={ArrowLeft} className="mr-auto" onClick={() => { const c = useWhatsNew.getState().card; if (c) useWhatsNew.setState({ view: { kind: 'release', version: c.version } }); }}>
                Back
              </Button>
            ) : null}
            <Button variant="primary" data-autofocus onClick={close}>Close</Button>
          </>
        )
      }
    >
      {release ? (
        <Features notes={release} />
      ) : (
        <ReleaseList open={shown?.kind === 'all' ? shown.open : undefined} />
      )}
    </Dialog>
  );
}

/** Settings › What's new: every release, the installed one open. */
export function WhatsNewSection() {
  const current = notesFor(RELEASES, installed())?.version ?? ALL[0]?.version;
  if (!ALL.length) return <SettingsEmptyState>No release notes yet.</SettingsEmptyState>;
  return <ReleaseList open={current} />;
}
