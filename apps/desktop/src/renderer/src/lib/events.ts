import { applyDelta, groupChatOf, groupChats, messagePreview, setPart, type EventName, type EventPayload, type Message, type Part, type Snapshot } from '@appubot/protocol';
import { FRAME_RING, arriveMessage, byId, dropThreads, getState, groupThreadOf, hydrate, isChannelThread, isGroupThread, pushToast, seenOnScreen, setState, threadOnScreen, toastHere, ui, updateMessage, upsertBy, upsertThread } from './store';
import { absorbSent, isLocalId } from './outbox';
import { layOverStore, noteServerEvent } from './optimistic';
import { openThread } from './actions';
import { settingsFromServer } from './choices';
import { endsNothingNewRun } from '@appubot/chat-core';

type P<E extends EventName> = EventPayload<E>;

function stub(threadId: string, messageId: string): () => Message {
  const now = Date.now();
  return () => ({ id: messageId, threadId, role: 'agent', parts: [], status: 'streaming', via: 'desktop', createdAt: now, updatedAt: now });
}

/**
 * A reply's first word (a delta, a part, a question) for a message not here yet: it comes in through `arriveMessage`,
 * so it takes the working row placed under a message sent from here instead of opening a second one.
 */
function ensureReply(threadId: string, messageId: string): void {
  const c = getState().convo[threadId];
  if (c && !c.byId[messageId]) arriveMessage(threadId, stub(threadId, messageId)());
}

function patchThreadPreview(threadId: string, msg: Message | undefined): void {
  if (!msg) return;
  const preview = messagePreview(msg);
  if (!preview) return;
  setState((s) => ({ threads: s.threads.map((t) => (t.id === threadId ? { ...t, lastMessagePreview: preview, updatedAt: Math.max(t.updatedAt, msg.updatedAt) } : t)) }));
}

/**
 * Single reducer for every gateway event (wired through client.onAny).
 * `hello` carries the snapshot (emitted by GatewayClient after a successful connect).
 */
export function applyEvent(event: EventName | 'hello', payload: unknown): void {
  // changes made here and still on their way stay shown over what the computer says meanwhile (lib/optimistic.ts)
  noteServerEvent(event, payload);
  applyServerEvent(event, payload);
  layOverStore();
}

function applyServerEvent(event: EventName | 'hello', payload: unknown): void {
  switch (event) {
    case 'hello':
      hydrate(payload as Snapshot);
      // settings picks still on their way stay on top (lib/choices.ts)
      settingsFromServer((payload as Snapshot).settings);
      return;

    /* ---------- bots ---------- */
    case 'bot.updated': {
      const bot = payload as P<'bot.updated'>;
      setState((s) => ({ bots: upsertBy(s.bots, bot, byId), selectedBotId: s.selectedBotId ?? bot.id }));
      return;
    }
    case 'character.updated': {
      const c = payload as P<'character.updated'>;
      setState((s) => ({ characters: upsertBy(s.characters, c, byId), charactersSupported: true }));
      return;
    }
    case 'character.removed': {
      const { id } = payload as P<'character.removed'>;
      setState((s) => ({ characters: s.characters.filter((c) => c.id !== id) }));
      return;
    }
    case 'bot.deleted': {
      const { id } = payload as P<'bot.deleted'>;
      dropThreads(getState().threads.filter((t) => t.botId === id).map((t) => t.id));
      setState((s) => {
        const bots = s.bots.filter((b) => b.id !== id);
        const lostSelection = s.selectedBotId === id;
        const threadPick = { ...s.threadPick };
        delete threadPick[id];
        return {
          bots, threadPick,
          skills: s.skills.filter((k) => k.botId !== id),
          routines: s.routines.filter((r) => r.botId !== id),
          selectedBotId: lostSelection ? (bots[0]?.id ?? null) : s.selectedBotId,
        };
      });
      ui.syncSelection();
      return;
    }

    /* ---------- threads ---------- */
    case 'thread.updated': {
      upsertThread(payload as P<'thread.updated'>);
      ui.syncSelection();
      return;
    }
    case 'thread.deleted': {
      const { id } = payload as P<'thread.deleted'>;
      // the thread on screen goes back to the bot's current one
      dropThreads([id]);
      ui.syncSelection();
      return;
    }

    /* ---------- messages ---------- */
    case 'message.created': {
      const m = payload as P<'message.created'>;
      // a message sent from here: its copy gives way (same row) and nothing more goes out for it; the bot's reply takes
      // the working row under it (lib/outbox.ts)
      if (m.role === 'user' && m.clientId && isLocalId(m.clientId)) absorbSent(m.clientId);
      arriveMessage(m.threadId, m);
      // (a routine's prompt never is the preview: its reply is, unless that had nothing to say)
      if (m.role === 'user' && m.via !== 'routine') patchThreadPreview(m.threadId, m);
      return;
    }
    case 'message.delta': {
      const d = payload as P<'message.delta'>;
      ensureReply(d.threadId, d.messageId);
      updateMessage(d.threadId, d.messageId, (m) => {
        const existing = m.parts[d.partIndex];
        if (existing) m.parts[d.partIndex] = { ...existing } as Part; // never mutate the previous snapshot's part
        applyDelta(m, d.partIndex, d.partType, d.delta);
        if (m.status !== 'streaming') m.status = 'streaming';
      }, stub(d.threadId, d.messageId));
      return;
    }
    case 'message.part': {
      const d = payload as P<'message.part'>;
      ensureReply(d.threadId, d.messageId);
      updateMessage(d.threadId, d.messageId, (m) => { setPart(m, d.partIndex, d.part); }, stub(d.threadId, d.messageId));
      return;
    }
    case 'message.reactions': {
      const d = payload as P<'message.reactions'>;
      updateMessage(d.threadId, d.messageId, (m) => { m.reactions = d.reactions; });
      return;
    }
    case 'message.completed': {
      const d = payload as P<'message.completed'>;
      updateMessage(d.threadId, d.messageId, (m) => {
        m.status = d.status;
        m.stopReason = d.stopReason;
        m.error = d.error;
        m.updatedAt = Date.now();
      });
      const s = getState();
      // a routine's run with nothing to say ("✓") folds away in the chat: not the preview, not unread (the computer says
      // so; one from before `nothingNew` is read here from what the chat holds)
      const conv = s.convo[d.threadId];
      const nothingNew = d.status === 'complete' && (d.nothingNew ?? (!!conv && endsNothingNewRun(conv.ids.map((id) => conv.byId[id]!).filter(Boolean), d.messageId)));
      if (!nothingNew) patchThreadPreview(d.threadId, conv?.byId[d.messageId]);
      // a reply you haven't looked at yet: a dot on the thread and its bot (Telegram chats are read in Telegram)
      const seen = threadOnScreen(s, d.threadId) && document.hasFocus();
      const known = s.threads.some((t) => t.id === d.threadId);
      if (known && !isChannelThread(s, d.threadId) && !isGroupThread(s, d.threadId) && d.status !== 'cancelled' && !seen && !nothingNew) ui.markUnread(d.threadId);
      if (d.status === 'error' && !seenOnScreen(s, d.threadId) && toastHere(s)) {
        pushToast({ title: 'A run failed', body: d.error ?? 'The agent stopped with an error.', level: 'error', threadId: d.threadId });
      }
      return;
    }
    case 'question.asked': {
      const q = payload as P<'question.asked'>;
      ensureReply(q.threadId, q.messageId);
      updateMessage(q.threadId, q.messageId, (m) => {
        if (!m.parts.some((p) => p.type === 'question' && p.questionId === q.questionId)) {
          m.parts.push({ type: 'question', questionId: q.questionId, question: q.question, options: q.options });
        }
      }, stub(q.threadId, q.messageId));
      if (!seenOnScreen(getState(), q.threadId) && toastHere(getState())) {
        // a member's question in a group opens the room, never its hidden thread
        const room = groupThreadOf(getState(), q.threadId);
        pushToast({ title: 'Question for you', body: q.question, level: 'info', ...(room ? { groupId: room.groupId, groupChatId: room.chatId } : { threadId: q.threadId }) });
      }
      return;
    }

    /* ---------- permissions ---------- */
    case 'permission.requested': {
      const p = payload as P<'permission.requested'>;
      setState((s) => ({ pendingPermissions: upsertBy(s.pendingPermissions, p, byId) }));
      if (!seenOnScreen(getState(), p.threadId) && toastHere(getState())) {
        const room = groupThreadOf(getState(), p.threadId);
        pushToast({ title: 'Approval needed', body: p.title, level: 'warning', ...(room ? { groupId: room.groupId, groupChatId: room.chatId } : { threadId: p.threadId }) });
      }
      return;
    }
    case 'permission.resolved': {
      const { id } = payload as P<'permission.resolved'>;
      setState((s) => ({ pendingPermissions: s.pendingPermissions.filter((p) => p.id !== id) }));
      return;
    }

    /* ---------- computer ---------- */
    // live view's pictures go to a phone watching the screen; this window is on that screen already
    case 'computer.live':
    case 'computer.liveVideo':
    case 'computer.liveState':
      return;
    case 'computer.status':
      setState({ computer: payload as P<'computer.status'> });
      return;
    case 'computer.frame': {
      const f = payload as P<'computer.frame'>;
      setState((s) => ({
        frame: f,
        actionFrames: f.action || f.threadId ? [...s.actionFrames.filter((x) => x.id !== f.id), f].slice(-FRAME_RING) : s.actionFrames,
      }));
      return;
    }
    case 'computer.action': {
      const a = payload as P<'computer.action'>;
      setState((s) => ({ lastAction: a, actions: [...s.actions, a].slice(-FRAME_RING) }));
      return;
    }

    /* ---------- providers ---------- */
    case 'provider.updated': {
      const p = payload as P<'provider.updated'>;
      setState((s) => ({ providers: upsertBy(s.providers, p, byId) }));
      return;
    }
    case 'providers.updated':
      setState({ providers: payload as P<'providers.updated'> });
      return;
    case 'providers.limits':
      setState({ limits: payload as P<'providers.limits'>, limitsSupported: true });
      return;

    /* ---------- skills & teach ---------- */
    case 'skill.updated': {
      const k = payload as P<'skill.updated'>;
      setState((s) => ({ skills: upsertBy(s.skills, k, (x) => `${x.botId ?? ''}/${x.name}`) }));
      return;
    }
    case 'skill.deleted': {
      const d = payload as P<'skill.deleted'>;
      setState((s) => ({ skills: s.skills.filter((k) => !(k.name === d.name && (k.botId ?? '') === d.botId)) }));
      return;
    }
    case 'teach.updated': {
      const t = payload as P<'teach.updated'>;
      const prev = getState().teach;
      setState({ teach: t.status === 'cancelled' ? null : t });
      if (t.status === 'done' && prev?.status !== 'done') {
        pushToast({ title: 'Skill saved', body: t.skillName ? `“${t.skillName}” is ready to use.` : 'Your bot learned a new task.', level: 'success', threadId: t.threadId });
        if (t.threadId) void openThread(t.threadId);
        setTimeout(() => { if (getState().teach?.id === t.id) setState({ teach: null }); }, 4000);
      } else if (t.status === 'error') {
        pushToast({ title: 'Teaching failed', body: t.error ?? 'Could not learn this task.', level: 'error' });
      }
      return;
    }

    /* ---------- routines, channels ---------- */
    case 'routine.updated': {
      const r = payload as P<'routine.updated'>;
      setState((s) => ({ routines: upsertBy(s.routines, r, byId) }));
      return;
    }
    case 'routine.deleted': {
      const { id } = payload as P<'routine.deleted'>;
      setState((s) => ({ routines: s.routines.filter((r) => r.id !== id) }));
      return;
    }
    case 'group.updated': {
      const g = payload as P<'group.updated'>;
      setState((s) => ({ groups: upsertBy(s.groups, g, byId), groupsSupported: true }));
      return;
    }
    case 'group.removed': {
      const { id } = payload as P<'group.removed'>;
      setState((s) => {
        const gone = s.groups.find((g) => g.id === id);
        const keys = gone ? groupChats(gone).map((c) => c.id) : [id];
        const groupMessages = { ...s.groupMessages }; const groupLoaded = { ...s.groupLoaded };
        for (const k of keys) { delete groupMessages[k]; delete groupLoaded[k]; }
        return { groups: s.groups.filter((g) => g.id !== id), groupMessages, groupLoaded, ...(s.selectedGroupId === id ? { selectedGroupId: null } : {}) };
      });
      return;
    }
    case 'group.message': {
      const m = payload as P<'group.message'>;
      setState((s) => {
        const key = groupChatOf(m);
        const list = s.groupMessages[key] ?? [];
        // a message sent from here: its copy (same clientId) gives way
        const rest = list.filter((x) => x.id !== m.id && !(m.clientId && x.clientId === m.clientId));
        return { groupMessages: { ...s.groupMessages, [key]: [...rest, m].sort((a, b) => a.createdAt - b.createdAt) } };
      });
      // (its toast, when one is due, comes from the computer's own notice: the `notification` event)
      return;
    }
    case 'channel.updated': {
      const c = payload as P<'channel.updated'>;
      setState((s) => ({ channels: upsertBy(s.channels, c, (x) => x.id) }));
      return;
    }
    case 'channel.removed': {
      const { id } = payload as P<'channel.removed'>;
      setState((s) => ({ channels: s.channels.filter((c) => c.id !== id) }));
      return;
    }
    case 'apps.updated':
      setState({ apps: payload as P<'apps.updated'> });
      return;

    /* ---------- devices & pairing ---------- */
    case 'device.updated': {
      const d = payload as P<'device.updated'>;
      setState((s) => ({ devices: upsertBy(s.devices, d, byId) }));
      return;
    }
    case 'device.deleted': {
      const { id } = payload as P<'device.deleted'>;
      setState((s) => ({ devices: s.devices.filter((d) => d.id !== id) }));
      return;
    }
    case 'pairing.updated':
      setState({ pairing: payload as P<'pairing.updated'> });
      return;
    case 'connect.status':
      // AppuBot Connect's state also rides system.updated; this keeps the Devices row fresh between those
      setState((s) => (s.system ? { system: { ...s.system, connect: payload as P<'connect.status'> } } : {}));
      return;

    /* ---------- files, settings, system ---------- */
    case 'file.created': {
      const f = payload as P<'file.created'>;
      setState((s) => ({ files: [f, ...s.files.filter((x) => x.id !== f.id)].slice(0, 100) }));
      return;
    }
    case 'settings.updated':
      settingsFromServer(payload as P<'settings.updated'>);
      return;
    case 'system.updated':
      setState({ system: payload as P<'system.updated'> });
      return;
    case 'voice.status':
      setState({ voice: payload as P<'voice.status'> });
      return;
    case 'notification': {
      const n = payload as P<'notification'>;
      // main sends a notice here only while the app is in front, or when its OS notification couldn't go out. A
      // question or an approval has its own toast (above) then, unless that one stayed away for an OS notification
      // that failed
      // A notice about the thread on screen (a reply that just finished there) needs none
      const s = getState();
      if (n.threadId && seenOnScreen(s, n.threadId) && document.hasFocus()) return;
      if (n.kind && toastHere(s)) return;
      // a group's notice (a member's report, its goal done or stuck): the room on screen needs none
      if (n.groupId && s.selectedGroupId === n.groupId && s.settingsSection === null && !s.appsOpen) return;
      pushToast({ id: n.id, title: n.title, body: n.body, level: n.level, threadId: n.threadId, ...(n.groupId ? { groupId: n.groupId } : {}) });
      return;
    }
    /* ---------- AppuBot Cloud: the Mac's account (features/cloud keeps it; main raises the notices) ---------- */
    case 'cloudAccount.updated':
    case 'cloudAccount.notice':
      return;
    /* a sign-in run on this computer for a device elsewhere: its dialog follows it (features/cloud/CloudAgentLogin) */
    case 'provider.login':
      return;

    default: {
      const exhaustive: never = event;
      void exhaustive;
    }
  }
}
