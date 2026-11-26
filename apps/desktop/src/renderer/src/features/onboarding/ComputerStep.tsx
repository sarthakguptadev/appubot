import { motion } from 'motion/react';
import { CLOUD_ONBOARDING, SETUP_COMPUTER, setupFrom, setupTrialTerms, trialCta, withMachine } from '@appubot/chat-core';
import { ChevronRight, Clock, Cloud, Laptop, Monitor, type IconComponent } from '../../components/ui/icons';
import { Button, Icon } from '../../components/ui';
import { MACHINE } from '../../lib/platform';
import { ProviderLogo } from '../providers/providerLogos';
import type { CloudStage } from './setupFlow';
import { StepShell } from './StepShell';
import { EASE_OUT } from '../../lib/motion';

/** each give's picture: Claude's own mark for the allowance, since its name is what convinces */
const GIVE_ICONS: Partial<Record<(typeof CLOUD_ONBOARDING.points)[number]['id'], IconComponent>> = { always: Clock, screen: Monitor };

/** what the card's button does and says, from where the person stands with a cloud computer */
function cardAction(stage: CloudStage, trialDays: number, cheapest?: string): { label: string; terms: string } {
  switch (stage.kind) {
    case 'ready': return { label: `Open ${stage.name}`, terms: 'It is ready, and your bots are there.' };
    case 'making': return { label: 'See how it is going', terms: 'Your cloud computer is being set up.' };
    case 'held': return { label: 'See what it needs', terms: stage.label };
    default: {
      const from = cheapest ? ` ${setupFrom(trialDays, cheapest)}.` : '';
      return { label: trialDays > 0 ? trialCta(trialDays) : CLOUD_ONBOARDING.cta, terms: `${setupTrialTerms(trialDays)}${from}` };
    }
  }
}

/**
 * Setup's second screen: where the bots work. One main action, the cloud computer (a card in the accent with
 * "Recommended", what it gives and the screen's only filled button), and this computer as a quiet link under it: how
 * a subscription app lays such a choice out, and how the phone app's Home does. Someone who has a cloud computer
 * already gets it as the card's button; signed out, "I already have a cloud computer" signs in.
 */
export function ComputerStep({ stage, trialDays, cheapest, onCloud, onOwn, onHave, onBack }: {
  stage: CloudStage;
  trialDays: number;
  /** the cheapest plan's monthly price, once the catalog has come */
  cheapest?: string;
  onCloud: () => void;
  onOwn: () => void;
  /** signed out: sign in to find the computer they have */
  onHave?: () => void;
  onBack: () => void;
}) {
  const c = SETUP_COMPUTER;
  const action = cardAction(stage, trialDays, cheapest);
  return (
    <StepShell title={c.title} body={c.body} width="md" onBack={onBack}>
      <div className="mx-auto flex w-full max-w-[660px] flex-col items-center">
        <motion.div
          initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.55, ease: EASE_OUT }}
          className="relative w-full rounded-[24px] border-[1.5px] border-accent bg-accent-soft p-5 [@media(max-height:720px)]:p-4"
        >
          {/* a tag on the card's top edge, so the title keeps its line */}
          <span className="ab-pill squircle absolute -top-3 right-5 flex h-6 items-center rounded-[7px] bg-accent px-3 text-note font-medium text-white">{c.cloud.tag}</span>
          <div className="flex items-center gap-3.5">
            <span className="ab-pill flex size-[46px] shrink-0 items-center justify-center rounded-[14px] bg-accent text-white"><Icon icon={Cloud} size={24} /></span>
            <div className="min-w-0">
              <h2 className="text-[17px] leading-snug font-semibold text-fg">{c.cloud.title}</h2>
              <p className="text-copy leading-snug text-fg-2">{c.cloud.line}</p>
            </div>
          </div>
          <ul className="mt-5 grid gap-3.5 min-[700px]:grid-cols-3 [@media(max-height:720px)]:mt-4">
            {CLOUD_ONBOARDING.points.map((p) => {
              const icon = GIVE_ICONS[p.id];
              return (
                <li key={p.id} className="flex gap-3 min-[700px]:flex-col min-[700px]:gap-2.5">
                  <span className="ab-pill flex size-9 shrink-0 items-center justify-center rounded-[11px] bg-content">
                    {icon ? <Icon icon={icon} size={18} className="text-accent" /> : <ProviderLogo id="claude-code" size={18} />}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-copy font-medium text-fg">{p.title}</span>
                    <span className="mt-0.5 block text-note leading-snug text-fg-2">{withMachine(p.line, MACHINE)}</span>
                  </span>
                </li>
              );
            })}
          </ul>
          <Button variant="accent" size="xl" className="mt-5 h-11 w-full justify-center text-lead font-semibold [@media(max-height:720px)]:mt-4" onClick={onCloud} autoFocus>
            {action.label}
          </Button>
          <p className="mt-2.5 text-center text-ui text-muted">{action.terms}</p>
        </motion.div>

        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.5, delay: 0.2 }} className="mt-4 flex flex-col items-center gap-0.5">
          <button
            type="button" onClick={onOwn}
            className="ab-press ab-pill squircle no-drag flex h-10 items-center gap-2 rounded-control-lg px-4 text-copy font-medium text-fg-2 hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_var(--ab-ring)]"
          >
            <Icon icon={Laptop} size={17} />
            {withMachine(c.own, MACHINE)}
            <Icon icon={ChevronRight} size={15} className="text-muted" />
          </button>
          {onHave ? (
            <button type="button" onClick={onHave} className="ab-pill squircle no-drag rounded-control-sm px-3 py-1.5 text-ui text-muted transition-colors hover:text-fg focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_var(--ab-ring)]">
              {c.have}
            </button>
          ) : null}
        </motion.div>
      </div>
    </StepShell>
  );
}
