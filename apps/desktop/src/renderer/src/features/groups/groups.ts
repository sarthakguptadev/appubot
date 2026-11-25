// Groups of bots (protocol groups.ts): reading a room, posting to it (shown at once as a copy until the computer's
// message arrives: lib/events.ts swaps it by clientId), making and changing groups. The computer tells who is working
// (`Group.working`) and what the bots say (`group.message`).
import { currentGroupChat, groupChats, type Group, type GroupMessage, type MethodParams } from '@appubot/protocol';
import { rpc } from '../../lib/gateway';
import { toastCallError } from '../../lib/actions';
import { byId, getState, setState, ui, upsertBy } from '../../lib/store';

let seq = 0;

/**
 * A group thread's newest messages, once per thread (and again after a reconnect: `groupLoaded` is cleared on
 * hydrate). `groupMessages`/`groupLoaded` are keyed by the thread's id (the group's own for its first thread).
 */
export async function loadGroup(groupId: string, chatId: string): Promise<void> {
  const s = getState();
  if (s.groupLoaded[chatId]) return;
  try {
    // a computer from before group threads has only the first, whose id is the group's: it takes no chatId
    const r = await rpc('groups.history', { id: groupId, ...(chatId !== groupId ? { chatId } : {}), limit: 200 });
    setState((st) => {
      const locals = (st.groupMessages[chatId] ?? []).filter((m) => m.id.startsWith('local:') && !r.messages.some((x) => x.clientId && x.clientId === m.clientId));
      return { groupMessages: { ...st.groupMessages, [chatId]: [...r.messages, ...locals] }, groupLoaded: { ...st.groupLoaded, [chatId]: true } };
    });
  } catch (e) { toastCallError(e, 'Couldn’t read the group'); }
}

/** Post to one of the group's threads: shown at once, sent behind. */
export async function sendGroupMessage(groupId: string, chatId: string, text: string): Promise<void> {
  const t = text.trim();
  if (!t) return;
  const clientId = `local:g${Date.now().toString(36)}${(seq++).toString(36)}`;
  const at = chatId !== groupId ? { chatId } : {};
  const copy: GroupMessage = { id: clientId, groupId, ...at, from: { kind: 'user' }, text: t, mentions: [], hop: 0, clientId, createdAt: Date.now() };
  setState((s) => ({ groupMessages: { ...s.groupMessages, [chatId]: [...(s.groupMessages[chatId] ?? []), copy] } }));
  try {
    const m = await rpc('groups.send', { id: groupId, ...at, text: t, clientId });
    setState((s) => ({ groupMessages: { ...s.groupMessages, [chatId]: (s.groupMessages[chatId] ?? []).map((x) => (x.id === clientId ? m : x)).filter((x, i, a) => a.findIndex((y) => y.id === x.id) === i) } }));
  } catch (e) {
    setState((s) => ({ groupMessages: { ...s.groupMessages, [chatId]: (s.groupMessages[chatId] ?? []).filter((x) => x.id !== clientId) } }));
    toastCallError(e, 'Not sent');
  }
}

/** A new thread in the group (the computer reuses an empty current one); every member starts it afresh. */
export async function newGroupChat(groupId: string): Promise<void> {
  try {
    const g = await rpc('groups.newChat', { id: groupId });
    setState((s) => ({ groups: upsertBy(s.groups, g, byId) }));
  } catch (e) { toastCallError(e, 'Couldn’t start a new thread'); }
}

/** Open one of the group's threads: at once here, then on the computer (a bot's post goes to the current one). */
export async function openGroupChat(groupId: string, chatId: string): Promise<void> {
  const before = getState().groups.find((g) => g.id === groupId);
  if (!before || currentGroupChat(before).id === chatId) return;
  setState((s) => ({ groups: s.groups.map((g) => (g.id === groupId ? { ...g, chats: groupChats(g), currentChatId: chatId } : g)) }));
  try {
    const g = await rpc('groups.useChat', { id: groupId, chatId });
    setState((s) => ({ groups: upsertBy(s.groups, g, byId) }));
  } catch (e) {
    setState((s) => ({ groups: s.groups.map((g) => (g.id === groupId ? before : g)) }));
    toastCallError(e, 'Couldn’t open that thread');
  }
}

export async function stopGroup(id: string): Promise<void> {
  try { await rpc('groups.stop', { id }); } catch (e) { toastCallError(e); }
}

export async function createGroup(p: { name: string; botIds: string[]; leadId?: string }): Promise<Group | undefined> {
  try {
    const g = await rpc('groups.create', p);
    setState((s) => ({ groups: upsertBy(s.groups, g, byId) }));
    ui.selectGroup(g.id);
    return g;
  } catch (e) { toastCallError(e, 'Couldn’t make the group'); return undefined; }
}

/** Change a group; its model pick shows at once (and goes back if the computer refuses it). */
export async function updateGroup(id: string, patch: MethodParams<'groups.update'>['patch']): Promise<Group | undefined> {
  const before = getState().groups.find((g) => g.id === id);
  if (before && (patch.providerId !== undefined || patch.modelId !== undefined || patch.effort !== undefined || patch.pinned !== undefined)) {
    const next: Group = { ...before };
    if (patch.pinned !== undefined) { if (patch.pinned) next.pinned = true; else delete next.pinned; }
    if (patch.providerId === '') { delete next.providerId; delete next.modelId; delete next.effort; }
    else if (patch.providerId !== undefined) { if (patch.providerId !== before.providerId) { delete next.modelId; delete next.effort; } next.providerId = patch.providerId; }
    if (patch.modelId !== undefined) { if (patch.modelId) next.modelId = patch.modelId; else delete next.modelId; }
    if (patch.effort !== undefined) { if (patch.effort) next.effort = patch.effort; else delete next.effort; }
    setState((s) => ({ groups: s.groups.map((g) => (g.id === id ? next : g)) }));
  }
  try {
    const g = await rpc('groups.update', { id, patch });
    setState((s) => ({ groups: upsertBy(s.groups, g, byId) }));
    return g;
  } catch (e) {
    if (before) setState((s) => ({ groups: s.groups.map((g) => (g.id === id ? before : g)) }));
    toastCallError(e, 'Couldn’t change the group');
    return undefined;
  }
}

export function deleteGroup(g: Group): void {
  ui.openModal({
    kind: 'confirm', title: `Delete ${g.name}?`, body: 'The group and everything said in it go. The bots keep their own chats.', confirmLabel: 'Delete', danger: true,
    onConfirm: async () => {
      try {
        await rpc('groups.delete', { id: g.id });
        setState((s) => ({ groups: s.groups.filter((x) => x.id !== g.id), ...(s.selectedGroupId === g.id ? { selectedGroupId: null } : {}) }));
      } catch (e) { toastCallError(e, 'Couldn’t delete the group'); }
    },
  });
}
