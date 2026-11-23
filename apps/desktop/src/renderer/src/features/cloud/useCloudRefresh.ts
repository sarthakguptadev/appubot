import { useEffect } from 'react';
import { repairActive } from '@appubot/chat-core';
import { loadCloud, useCloud } from './cloudAccount';
import { cloudPhase } from './cloudView';

/** how often a page watching something in progress (set up, woken, fixed) asks while the window shows */
const QUICK_MS = 5_000;

/**
 * Settings' account pages read the account fresh by themselves (no Refresh button). Opening one asks the Mac for the
 * view, which reads the backend only when what it has is older than a minute (opening Billing five times in a row is
 * one read, or none); the Mac keeps it fresh on its own timer and the window's focus (`watchCloud`) otherwise. While a
 * computer is being set up, woken or fixed, the page asks every few seconds while the window shows. Reading never
 * wakes a computer.
 */
export function useCloudRefresh(): void {
  const view = useCloud((s) => s.view);
  const phase = cloudPhase(view);
  const fixing = repairActive(view?.computer?.repair) || (view?.teams ?? []).some((t) => repairActive(t.computer?.repair));
  const quick = phase === 'provisioning' || phase === 'waking' || fixing;
  useEffect(() => { void loadCloud(); }, []);
  useEffect(() => {
    if (!quick) return;
    const t = setInterval(() => { if (!document.hidden) void loadCloud(true); }, QUICK_MS);
    return () => clearInterval(t);
  }, [quick]);
}
