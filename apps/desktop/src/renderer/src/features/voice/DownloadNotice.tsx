// While the speech models download and voice mode isn't showing it: a quiet line above the composer with how far it is,
// and Cancel. The computer fetches them in the background by itself (VoiceService.prefetch), and that says nothing:
// the line shows only once someone asked for voice in this run (the mic, voice mode: `askedForVoice`), until the
// download is over (2026-11-17, the owner's call).
import { useEffect, useSyncExternalStore } from 'react';
import { motion } from 'motion/react';
import { Download } from '../../components/ui/icons';
import { Button, Icon } from '../../components/ui';
import { call } from '../../lib/actions';
import { NOTICE_LINE } from '../chat/NoticeCard';
import { setState, useStore } from '../../lib/store';
import { downloadProgress, percent } from './models';

let asked = false;
const listeners = new Set<() => void>();
const subscribe = (on: () => void) => { listeners.add(on); return () => { listeners.delete(on); }; };

/** someone pressed the mic or voice while the models aren't here yet: the download is theirs to see now */
export function askedForVoice(): void {
  if (asked) return;
  asked = true;
  for (const on of listeners) on();
}

export function useVoiceDownload(): number | null {
  const wanted = useSyncExternalStore(subscribe, () => asked);
  const progress = useStore((s) => (s.voice ? downloadProgress(s.voice.models) : null));
  // the download over: the next background one is quiet again
  useEffect(() => {
    if (progress !== null || !asked) return;
    asked = false;
    for (const on of listeners) on();
  }, [progress]);
  return wanted ? progress : null;
}

export function VoiceDownloadNotice({ progress }: { progress: number }) {
  const cancel = async () => {
    const down = useStore.getState().voice?.models.filter((m) => m.phase === 'downloading') ?? [];
    for (const m of down) {
      const st = await call('voice.models.cancel', { id: m.id }, { errorTitle: 'Couldn’t cancel the download' });
      if (st) setState({ voice: st });
    }
  };
  const text = `Downloading the speech models… ${percent(progress)}`;
  return (
    <motion.div
      role="status"
      initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 4 }}
      transition={{ duration: 0.16, ease: 'easeOut' }}
      className={NOTICE_LINE}
    >
      <Icon icon={Download} size={14} className="shrink-0 text-muted" />
      <p className="min-w-0 flex-1 truncate text-fg-2" title={text}>{text}</p>
      <span aria-hidden className="h-1 w-20 shrink-0 overflow-hidden rounded-full bg-surface-3">
        <span className="block h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: percent(progress) }} />
      </span>
      <Button size="xs" variant="ghost" onClick={() => void cancel()}>Cancel</Button>
    </motion.div>
  );
}
