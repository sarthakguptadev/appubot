/**
 * Claude Code setting itself up on your AppuBot computer (its first start, core `services/agentSetup.ts`): above the
 * composer of a chat on Claude (AppuBot AI included), "Setting up Claude…" while it installs (messages sent meanwhile
 * wait for it), "Claude couldn’t be set up" with Try again once it gave up. It reads what the computer itself says
 * (`SystemInfo.cloud.agentSetup`), so it shows on any computer that sets it up, and nowhere else.
 */
import { useState } from 'react';
import { agentSetupNotice } from '@appubot/chat-core';
import { Sparkles } from '../../components/ui/icons';
import { Button } from '../../components/ui';
import { NoticeCard } from '../chat/NoticeCard';
import { call } from '../../lib/actions';
import { useNow } from '../../lib/hooks';
import { useStore } from '../../lib/store';

/** the notice's words for a chat on `providerId` now (null: none), so ThreadView can slot it with the others */
export function useClaudeSetup(providerId: string | undefined) {
  const setup = useStore((s) => s.system?.cloud?.agentSetup);
  const now = useNow(1_000);
  return agentSetupNotice(setup, providerId, now);
}

export function ClaudeSetupNotice({ providerId }: { providerId: string | undefined }) {
  const notice = useClaudeSetup(providerId);
  const [trying, setTrying] = useState(false);
  if (!notice) return null;
  const retry = async () => {
    setTrying(true);
    try { await call('providers.install', { id: 'claude-code' }, { errorTitle: 'Claude couldn’t be set up', timeoutMs: 15 * 60_000 }); } finally { setTrying(false); }
  };
  return (
    <NoticeCard icon={Sparkles} spinning={notice.busy || trying} tone={notice.tone === 'attention' ? 'attention' : undefined} title={notice.title} detail={notice.detail}>
      {notice.retry ? <Button size="sm" variant="primary" loading={trying} onClick={() => void retry()}>Try again</Button> : null}
    </NoticeCard>
  );
}
