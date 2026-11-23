import { useState } from 'react';
import { motion } from 'motion/react';
import { ArrowRight } from '../../components/ui/icons';
import { BotAvatar, Button } from '../../components/ui';
import { X_HANDLE, X_URL } from '../../lib/links';
import { native } from '../../lib/native';
import { StepShell } from './StepShell';

/** X's mark */
function XMark({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden>
      <path fill="currentColor" d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

/**
 * First run only: AppuBot's X account as its profile card, Follow on X (opens it in the browser), Maybe later. Having
 * opened it, the button becomes Continue.
 */
export function FollowStep({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const [opened, setOpened] = useState(false);
  const follow = () => {
    void native().openExternal(X_URL);
    setOpened(true);
  };
  return (
    <StepShell
      title="Follow along on X"
      body="New features and tips, as they ship."
      width="sm"
      onBack={onBack}
      actions={opened
        ? <Button size="lg" variant="primary" iconRight={ArrowRight} onClick={onNext}>Continue</Button>
        : (
          <>
            <Button size="lg" variant="ghost" onClick={onNext}>Maybe later</Button>
            <Button size="lg" variant="primary" onClick={follow} autoFocus><XMark size={14} />Follow on X</Button>
          </>
        )}
    >
      <div className="glass-raised squircle mx-auto w-full max-w-[400px] overflow-hidden rounded-[22px]">
        <div className="relative h-[104px] overflow-hidden bg-[#f6852a]">
          {/* the banner: AppuBot's warm sky */}
          <div className="absolute inset-0 bg-[radial-gradient(120%_140%_at_15%_0%,#ffb053_0%,#f9730c_45%,transparent_75%),radial-gradient(120%_120%_at_100%_100%,#a5bbfc_0%,#f4f7ff00_70%)]" />
        </div>
        <div className="relative px-5 pb-5">
          <div className="-mt-9 flex items-end justify-between">
            <span className="flex size-[76px] items-center justify-center rounded-full bg-[#141414] ring-4 ring-[var(--ab-surface)]">
              <BotAvatar color="#FF7A1F" size={52} happy still />
            </span>
            <button
              type="button" onClick={follow}
              className="ab-press ab-pill squircle mb-1 h-9 rounded-control bg-fg px-4 text-copy font-semibold tracking-ui text-bg hover:opacity-90"
            >
              Follow
            </button>
          </div>
          <div className="mt-3 text-[17px] font-bold text-fg">AppuBot</div>
          <div className="text-copy text-muted">{X_HANDLE}</div>
          <p className="mt-2.5 text-copy leading-snug text-fg-2">Bots that do real work on your computer. News, tips and what’s next.</p>
        </div>
      </div>
      {opened ? (
        <motion.p
          className="mt-4 text-center text-copy text-muted"
          initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}
        >
          Thanks! See you there.
        </motion.p>
      ) : null}
    </StepShell>
  );
}
