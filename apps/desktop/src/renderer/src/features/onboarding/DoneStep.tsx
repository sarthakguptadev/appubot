import { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { SETUP_LATER, cloudPromoCta, withMachine } from '@appubot/chat-core';
import { ArrowRight, CalendarClock, Cloud, FolderSearch, MousePointerClick, type IconComponent } from '../../components/ui/icons';
import { BotAvatar, Button, Icon, Spinner, cn } from '../../components/ui';
import { sendMessage } from '../../lib/actions';
import { COMPUTER_USE, MACHINE, PLATFORM } from '../../lib/platform';
import { ui, useStore } from '../../lib/store';
import { StepShell } from './StepShell';

const SHEETS = PLATFORM === 'darwin' ? 'Numbers' : PLATFORM === 'win32' ? 'Excel' : 'LibreOffice Calc';

/** what to try first: one that reads files, one in an app (computer use), one on a schedule */
const TRY: { icon: IconComponent; title: string; prompt: string }[] = [
  { icon: FolderSearch, title: 'Tidy my Downloads', prompt: 'Look through my Downloads and tell me what I could safely delete.' },
  ...(COMPUTER_USE ? [{ icon: MousePointerClick, title: `Make a budget in ${SHEETS}`, prompt: `Open ${SHEETS} and make me a simple monthly budget I can fill in.` }] : []),
  { icon: CalendarClock, title: 'A morning briefing', prompt: 'Every weekday at 9am, send me the top five tech stories.' },
];

/**
 * The end: the first bot cheers, three things to try (one click sends it to that bot and opens the app on its chat) and
 * Start chatting, which finishes setup so the bot says hello by itself (the computer greets on `onboarded`). For
 * someone with no cloud computer, one quiet line under the three offers it once more (`onCloud`: on to the plans).
 */
export function DoneStep({ onBack, onFinish, finishing, onCloud, trialDays = 0 }: {
  onBack: () => void;
  onFinish: () => Promise<boolean>;
  finishing: boolean;
  onCloud?: () => void;
  trialDays?: number;
}) {
  const bot = useStore((s) => s.bots[0]);
  const [sending, setSending] = useState<string | null>(null);
  const [cheer, setCheer] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => setCheer(1), 450);
    return () => clearTimeout(t);
  }, []);

  // a prompt goes first, so the bot answers it rather than greeting (it only greets an empty chat)
  const tryIt = async (prompt: string) => {
    if (!bot || sending) return;
    setSending(prompt);
    ui.selectBot(bot.id);
    const sent = await sendMessage(bot.id, null, prompt);
    if (!sent || !(await onFinish())) setSending(null);
  };

  return (
    <StepShell
      title="You’re all set"
      body={bot ? <>{bot.name} is ready. Try one of these, or just say hi.</> : 'Try one of these, or just say hi.'}
      hero={
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, ease: [0.25, 1, 0.5, 1] }} className="mb-7">
          <BotAvatar bot={bot} color={bot ? undefined : '#FF7A1F'} size={96} cheerKey={cheer} />
        </motion.div>
      }
      onBack={onBack}
      actions={
        <Button size="lg" variant="primary" iconRight={ArrowRight} loading={finishing && !sending} disabled={!!sending} onClick={() => { if (bot) ui.selectBot(bot.id); void onFinish(); }} autoFocus>
          {bot ? `Say hi to ${bot.name}` : 'Start'}
        </Button>
      }
    >
      <div className={cn('grid w-full gap-3', TRY.length === 3 ? 'min-[760px]:grid-cols-3' : 'min-[760px]:grid-cols-2')}>
        {TRY.map((t, i) => (
          <motion.button
            key={t.title} type="button" disabled={!bot || !!sending} onClick={() => void tryIt(t.prompt)}
            initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, delay: 0.15 + 0.07 * i, ease: [0.25, 1, 0.5, 1] }}
            className={cn(
              'glass-raised squircle group flex flex-col rounded-[18px] p-4 text-left transition-colors duration-150 hover:bg-surface-2 disabled:pointer-events-none',
              sending && sending !== t.prompt && 'opacity-50',
            )}
          >
            <span className="flex w-full items-center justify-between">
              <span className="flex size-8 items-center justify-center rounded-[10px] bg-accent-soft text-accent"><Icon icon={t.icon} size={16} /></span>
              {sending === t.prompt ? <Spinner size={14} className="text-muted" /> : <Icon icon={ArrowRight} size={15} className="text-muted opacity-0 transition-[opacity,translate] duration-150 group-hover:translate-x-0.5 group-hover:opacity-100" />}
            </span>
            <span className="mt-3 text-copy font-medium text-fg">{t.title}</span>
            <span className="mt-1 line-clamp-2 text-note leading-snug text-muted">“{t.prompt}”</span>
          </motion.button>
        ))}
      </div>
      {onCloud ? (
        <motion.button
          type="button" onClick={onCloud} disabled={!!sending}
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.5, delay: 0.45 }}
          className="ab-pill squircle group mx-auto mt-5 flex max-w-full items-center gap-2.5 rounded-control px-3.5 py-2 text-left text-ui text-muted transition-colors hover:bg-surface-2 hover:text-fg disabled:pointer-events-none"
        >
          <Icon icon={Cloud} size={16} className="shrink-0 text-accent" />
          <span className="min-w-0">{withMachine(SETUP_LATER.line, MACHINE)}</span>
          <span className="shrink-0 font-medium text-accent">{cloudPromoCta(trialDays)}</span>
          <Icon icon={ArrowRight} size={14} className="shrink-0 text-accent transition-[translate] duration-150 group-hover:translate-x-0.5" />
        </motion.button>
      ) : null}
    </StepShell>
  );
}
