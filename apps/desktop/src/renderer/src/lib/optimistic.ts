// Optimistic actions (after the phone app's): renaming, pinning or deleting a chat or a bot,
// reacting, answering an approval, switches in Settings and the like show the moment they're made, and stay put over
// what the computer reports while the request is in flight (chat-core `EntityOverlay`: an event sent before it got the
// change can't flip it back). The computer's answer settles it; a refusal puts back what it last said, with a small
// error. The pickers have their own, ordered layer (lib/choices.ts) and settings switches go through it
// (`updateSettings`).
//
// The overlay is laid over the store whenever the computer's word lands there: every event (events.ts `applyEvent`),
// the hello, and lists read by calls (`upsertThreads`).
import type { EventName, Message, MethodName, MethodParams, MethodResult, Snapshot } from '@appubot/protocol';
import { EntityOverlay, applyRestore, applySettled } from '@appubot/chat-core';
import { toastCallError } from './actions';
import { onActiveComputer, rpc } from './gateway';
import { getState, setAfterServerWrite, setState, ui, type AppState } from './store';

/** The store's lists an action can change. */
export type Coll = 'threads' | 'bots' | 'routines' | 'channels' | 'devices' | 'characters' | 'providers' | 'pendingPermissions';
const COLLS: Coll[] = ['threads', 'bots', 'routines', 'channels', 'devices', 'characters', 'providers', 'pendingPermissions'];
/** a reaction overlay's collection (by message id; `reactionThread` says which chat holds it) */
const REACTIONS = 'reactions';
type Reactions = NonNullable<Message['reactions']>;

export type Change =
  | { kind: 'patch'; coll: Coll; id: string; fields: Record<string, unknown> }
  | { kind: 'remove'; coll: Coll; id: string }
  | { kind: 'reactions'; threadId: string; messageId: string; reactions: Reactions };

export const overlay = new EntityOverlay();
const reactionThread = new Map<string, string>();

type Entity = { id: string };
const listOf = (s: AppState, coll: Coll): Entity[] => s[coll] as Entity[];

/** Lay what's still pending over the store (only what it changes). */
export function layOverStore(): void {
  if (!overlay.pending) return;
  setState((s) => {
    const out: Partial<AppState> = {};
    for (const coll of COLLS) {
      const list = listOf(s, coll);
      const shown = overlay.lay(coll, list);
      if (shown !== list) (out as Record<string, unknown>)[coll] = shown;
    }
    let convo = s.convo;
    for (const [messageId, threadId] of reactionThread) {
      const c = convo[threadId];
      const m = c?.byId[messageId];
      if (!c || !m) continue;
      const reactions = overlay.value<Reactions | undefined>(REACTIONS, messageId, 'reactions', m.reactions);
      if (reactions === m.reactions) continue;
      convo = { ...convo, [threadId]: { ...c, byId: { ...c.byId, [messageId]: { ...m, reactions } } } };
    }
    if (convo !== s.convo) out.convo = convo;
    return out;
  });
  ui.syncSelection();
}

/** What the computer just said about entities: the truth under anything still overlaid. */
export function noteServerEvent(event: EventName | 'hello', payload: unknown): void {
  if (!overlay.pending) return;
  const p = payload as Record<string, unknown>;
  const one = (coll: Coll) => overlay.noteServer(coll, p as unknown as Entity);
  const gone = (coll: Coll) => overlay.noteGone(coll, String(p.id));
  switch (event) {
    case 'hello': {
      const snap = payload as Snapshot;
      for (const coll of COLLS) {
        const list = (snap as unknown as Record<string, Entity[] | undefined>)[coll];
        for (const e of list ?? []) overlay.noteServer(coll, e);
      }
      return;
    }
    case 'thread.updated': return one('threads');
    case 'bot.updated': return one('bots');
    case 'routine.updated': return one('routines');
    case 'channel.updated': return one('channels');
    case 'device.updated': return one('devices');
    case 'character.updated': return one('characters');
    case 'provider.updated': return one('providers');
    case 'providers.updated': for (const e of payload as Entity[]) overlay.noteServer('providers', e); return;
    case 'permission.requested': return one('pendingPermissions');
    case 'thread.deleted': return gone('threads');
    case 'bot.deleted': return gone('bots');
    case 'routine.deleted': return gone('routines');
    case 'channel.removed': return gone('channels');
    case 'device.deleted': return gone('devices');
    case 'character.removed': return gone('characters');
    case 'permission.resolved': return gone('pendingPermissions');
    case 'message.reactions': overlay.noteServer(REACTIONS, { id: String(p.messageId), reactions: p.reactions ?? [] } as Entity); return;
    default:
  }
}

function settleInStore(seq: number, ok: boolean): void {
  const { patches, restores } = overlay.settle(seq, ok);
  if (!patches.length && !restores.length) return;
  setState((s) => {
    const out: Record<string, unknown> = {};
    const cur = (coll: Coll) => (out[coll] ?? listOf(s, coll)) as Entity[];
    let convo = s.convo;
    for (const p of patches) {
      if (p.coll === REACTIONS) {
        const threadId = reactionThread.get(p.id);
        const c = threadId ? convo[threadId] : undefined;
        const m = c?.byId[p.id];
        if (threadId && c && m) convo = { ...convo, [threadId]: { ...c, byId: { ...c.byId, [p.id]: { ...m, reactions: p.fields.reactions as Reactions } } } };
        continue;
      }
      out[p.coll] = applySettled(cur(p.coll as Coll), p);
    }
    for (const r of restores) out[r.coll] = applyRestore(cur(r.coll as Coll), r);
    if (convo !== s.convo) out.convo = convo;
    return out as Partial<AppState>;
  });
  // reactions no longer overlaid stop being tracked
  for (const [messageId] of reactionThread) if (!overlay.has(REACTIONS, messageId)) reactionThread.delete(messageId);
  layOverStore();
}

/** Show `changes` now; returns the change's number for `settleChange`. */
export function showChanges(changes: Change[]): number {
  const seq = overlay.begin();
  const s = getState();
  for (const ch of changes) {
    if (ch.kind === 'patch') {
      overlay.patch(seq, ch.coll, ch.id, ch.fields, listOf(s, ch.coll).find((e) => e.id === ch.id));
    } else if (ch.kind === 'remove') {
      const list = listOf(s, ch.coll);
      const index = list.findIndex((e) => e.id === ch.id);
      if (index >= 0) overlay.remove(seq, ch.coll, ch.id, list[index]!, index);
    } else {
      const msg = s.convo[ch.threadId]?.byId[ch.messageId];
      reactionThread.set(ch.messageId, ch.threadId);
      overlay.patch(seq, REACTIONS, ch.messageId, { reactions: ch.reactions }, { reactions: msg?.reactions ?? [] });
    }
  }
  layOverStore();
  return seq;
}

/**
 * The request behind change `seq` finished: `ok`, with `server` the computer's own copy of what it answered (written
 * into the store first, under anything else still pending), or refused (back to what the computer last said).
 */
export function settleChange(seq: number, ok: boolean, server?: { coll: Coll; entity: Entity }): void {
  if (ok && server) {
    overlay.noteServer(server.coll, server.entity);
    setState((s) => {
      const list = listOf(s, server.coll);
      return list.some((e) => e.id === server.entity.id) ? { [server.coll]: list.map((e) => (e.id === server.entity.id ? server.entity : e)) } as Partial<AppState> : {};
    });
  }
  settleInStore(seq, ok);
}

/**
 * Make a change at once and send it; a refusal puts it back and shows `errorTitle`. Resolves to the computer's answer,
 * or undefined when refused.
 */
export async function optimistic<R>(
  changes: Change[], send: () => Promise<R>,
  opts: { errorTitle: string; answered?: (r: R) => { coll: Coll; entity: Entity } | undefined },
): Promise<R | undefined> {
  const seq = showChanges(changes);
  try {
    const r = await send();
    settleChange(seq, true, opts.answered?.(r));
    return r;
  } catch (e) {
    settleChange(seq, false);
    toastCallError(e, opts.errorTitle);
    return undefined;
  }
}

/** `optimistic` for one gateway call to the computer on screen. */
export function optimisticCall<M extends MethodName>(
  method: M, params: MethodParams<M>, changes: Change[],
  opts: { errorTitle: string; answered?: (r: MethodResult<M>) => { coll: Coll; entity: Entity } | undefined },
): Promise<MethodResult<M> | undefined> {
  return optimistic(changes, () => rpc(method, params), opts);
}

// what is pending belongs to the computer it was made on: another one on screen starts clean
onActiveComputer(() => { overlay.clear(); reactionThread.clear(); });
// lists read by calls (a `threads.list` page, `threads.start`) keep what's pending shown on top
setAfterServerWrite(layOverStore);

/** For tests: forget everything. */
export function resetOverlay(): void {
  overlay.clear();
  reactionThread.clear();
}
