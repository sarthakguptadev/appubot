/**
 * Dev-only hooks for the renderer bench (apps/desktop/bench/renderer.mjs), on the mock gateway with `?bench=1`:
 * `window.__appubotBench` streams a long reply into the chat on screen the way the gateway delivers one (deltas
 * coalesced every ~30ms), and hands the bench the store and the UI actions it drives.
 */
import { newId, type Message } from '@appubot/protocol';
import { getState, mergeConversation, setState, ui } from '../lib/store';
import { rpc } from '../lib/gateway';
import { openBot, openThread } from '../lib/actions';
import { benchReplyTokens } from './benchThread';
import type { MockGateway } from './MockGateway';

export interface BenchStream { tokens?: number; tps?: number; batchMs?: number }

export function installBench(g: MockGateway): void {
  const api = {
    getState, setState, ui, openBot, openThread, rpc, mergeConversation,
    /** Streams `tokens` pieces at `tps` per second in `batchMs` batches into the thread on screen; resolves when done. */
    stream({ tokens = 1200, tps = 100, batchMs = 30 }: BenchStream = {}): Promise<{ messageId: string; ms: number }> {
      const threadId = getState().selectedThreadId;
      if (!threadId) return Promise.reject(new Error('no thread on screen'));
      const pieces = benchReplyTokens(tokens);
      const messageId = newId('msg');
      const t0 = performance.now();
      const now = Date.now();
      const m: Message = { id: messageId, threadId, role: 'agent', parts: [], status: 'streaming', via: 'desktop', createdAt: now, updatedAt: now };
      g.patchThread(threadId, { status: 'running' });
      g.addMessage(m);
      const per = Math.max(1, Math.round((tps * batchMs) / 1000));
      return new Promise((resolve) => {
        let i = 0;
        const tick = () => {
          if (i >= pieces.length) {
            g.completeMessage(threadId, messageId, 'complete', 'end_turn');
            g.patchThread(threadId, { status: 'idle' });
            setTimeout(() => resolve({ messageId, ms: performance.now() - t0 }), 50);
            return;
          }
          g.delta(threadId, messageId, 0, 'text', pieces.slice(i, i + per).join(''));
          i += per;
          setTimeout(tick, batchMs);
        };
        setTimeout(tick, batchMs);
      });
    },
  };
  (window as unknown as { __appubotBench: typeof api }).__appubotBench = api;
}
