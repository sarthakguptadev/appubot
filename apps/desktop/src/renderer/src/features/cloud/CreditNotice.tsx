/**
 * The included Claude credit (a limited-time launch bonus) in the chat: no meter (usage is
 * only in Settings › Cloud), just a short notice above the composer once AppuBot AI can't spend it (the month's credit
 * is used up, or the bonus has ended for everyone), with the one thing that helps: the user's own account, signed in
 * from Settings › Agents. It reads what the cloud computer itself says (`SystemInfo.cloud.credit`, fresh every
 * heartbeat), never the token.
 */
import { creditNotice, isAppubotAi } from '@appubot/chat-core';
import { Sparkles } from '../../components/ui/icons';
import { Button } from '../../components/ui';
import { NoticeCard } from '../chat/NoticeCard';
import { useNow } from '../../lib/hooks';
import { ui, useStore } from '../../lib/store';

/** the credit as the connected computer reports it, when the chat's agent spends it */
export function useCredit(providerId: string | undefined) {
  const credit = useStore((s) => s.system?.cloud?.credit);
  return isAppubotAi(providerId) && credit ? credit : undefined;
}

/** the chat shows this (ThreadView) while its agent is AppuBot AI and the credit can't be spent (used up, or the bonus ended) */
export function useCreditExhausted(providerId: string | undefined): boolean {
  const credit = useCredit(providerId);
  return !!credit?.exhausted || !!credit?.ended;
}

export function CreditNotice({ providerId }: { providerId: string | undefined }) {
  const credit = useCredit(providerId);
  const now = useNow();
  if (!credit || !(credit.exhausted || credit.ended)) return null;
  const { title, detail } = creditNotice(credit, now);
  return (
    <NoticeCard tone="attention" icon={Sparkles} title={title} detail={detail}>
      <Button size="sm" variant="primary" onClick={() => ui.openSettings('providers')}>Use your own account</Button>
    </NoticeCard>
  );
}
