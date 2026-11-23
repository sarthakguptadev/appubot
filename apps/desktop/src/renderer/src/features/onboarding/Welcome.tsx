import { useEffect, useState, type ReactNode } from 'react';
import { motion } from 'motion/react';
import type { BotShape } from '@appubot/protocol';
import { ArrowRight } from '../../components/ui/icons';
import { BotAvatar, Button } from '../../components/ui';
import { MACHINE } from '../../lib/platform';
import { useStore } from '../../lib/store';
import { EASE_OUT } from '../../lib/motion';


/** the crew around AppuBot's own bot: a few of the looks a bot can have, smaller and further out */
const CREW: { shape: BotShape; color: string; size: number; x: number; lift: number }[] = [
  { shape: 'drop', color: '#16C47A', size: 46, x: -178, lift: 0 },
  { shape: 'squircle', color: '#2E8EFF', size: 68, x: -112, lift: 0 },
  { shape: 'hex', color: '#9A68FF', size: 68, x: 112, lift: 0 },
  { shape: 'cloud', color: '#FFA826', size: 46, x: 178, lift: 0 },
];

/** a bot standing on the floor, with its soft shadow; pops up after `delay` */
function Standing({ children, size, x, lift = 0, delay }: { children: ReactNode; size: number; x: number; lift?: number; delay: number }) {
  return (
    <motion.div
      className="absolute bottom-0 left-1/2 flex flex-col items-center"
      style={{ x: x - size / 2, marginBottom: lift }}
      initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.7, delay, ease: EASE_OUT }}
    >
      {children}
      <span className="mt-1 h-[6px] rounded-[50%] bg-[radial-gradient(closest-side,rgba(0,0,0,.16),transparent)] dark:bg-[radial-gradient(closest-side,rgba(0,0,0,.6),transparent)]" style={{ width: size * 0.78 }} />
    </motion.div>
  );
}

const reveal = (delay: number) => ({
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.6, delay, ease: EASE_OUT },
});

/**
 * The first screen: AppuBot's bot and its crew, alive, "Meet AppuBot", one line and Get started. Nothing to skip to:
 * the next screen is the one choice setup asks for (where the bots work), and every step after has its own way past.
 */
export function Welcome({ onNext }: { onNext: () => void }) {
  const appu = useStore((s) => s.bots[0]);
  // the bot cheers once it has landed
  const [cheer, setCheer] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => setCheer(1), 900);
    return () => clearTimeout(t);
  }, []);
  return (
    <div className="flex min-h-0 flex-1 overflow-y-auto px-10">
      <div className="m-auto flex w-full max-w-[640px] flex-col items-center py-8 text-center">
        <div className="relative h-[160px] w-[440px] max-w-full">
          {CREW.map((c, i) => (
            <Standing key={c.shape} size={c.size} x={c.x} lift={c.lift} delay={0.25 + 0.08 * Math.abs(i - 1.5)}>
              <BotAvatar shape={c.shape} color={c.color} size={c.size} />
            </Standing>
          ))}
          <Standing size={132} x={0} delay={0.05}>
            <BotAvatar bot={appu} color={appu ? undefined : '#FF7A1F'} size={132} cheerKey={cheer} />
          </Standing>
        </div>
        <motion.h1 {...reveal(0.35)} className="mt-9 font-display text-[46px] leading-[1.05] font-medium tracking-display text-fg">
          Meet AppuBot
        </motion.h1>
        <motion.p {...reveal(0.45)} className="mt-3 text-title leading-relaxed text-fg-2">
          Give a bot a job. It gets it done on a computer of its own, or on your {MACHINE}.
        </motion.p>
        <motion.div {...reveal(0.55)} className="mt-10 flex flex-col items-center gap-3">
          <Button size="xl" variant="primary" iconRight={ArrowRight} onClick={onNext} className="min-w-[180px]" autoFocus>Get started</Button>
        </motion.div>
      </div>
    </div>
  );
}
