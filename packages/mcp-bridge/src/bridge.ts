#!/usr/bin/env node
/**
 * AppuBot MCP bridge. Spawned by the ACP agent (per session). Env:
 *   APPUBOT_GATEWAY_URL  http://127.0.0.1:7890
 *   APPUBOT_TOKEN        per-session agent token (role 'agent')
 *   APPUBOT_THREAD_ID, APPUBOT_BOT_ID, APPUBOT_BOT_NAME, APPUBOT_COMPUTER_USE=1|0, APPUBOT_APPS=1|0, APPUBOT_CLOUD=1 (an AppuBot Cloud computer),
 *   APPUBOT_MAC_FILES=<name> (one of the user's own computers lends this one its files),
 *   APPUBOT_CONNECTORS=1 (the bot may use some custom connector's tools)
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import WebSocket from 'ws';
import { z } from 'zod';
import { GatewayClient } from '@appubot/client';
import { MEMORY_LOAD_MAX, type ComputerAction, type MethodResult } from '@appubot/protocol';
import { appsTools, botTools, computerTools, macFilesTools, userTools, vaultTools, type BatchStep } from './tools';
import { addConnectorTools } from './connectorTools';

const url = process.env.APPUBOT_GATEWAY_URL ?? 'http://127.0.0.1:7890';
const token = process.env.APPUBOT_TOKEN ?? '';
const threadId = process.env.APPUBOT_THREAD_ID ?? '';
const computerUse = (process.env.APPUBOT_COMPUTER_USE ?? '1') !== '0';
const apps = process.env.APPUBOT_APPS === '1';
const connectors = process.env.APPUBOT_CONNECTORS === '1';
/** one of the user's own computers lends this one its files: its name */
const macFiles = (process.env.APPUBOT_MAC_FILES ?? '').trim();
const log = (...a: unknown[]) => process.stderr.write(`[appubot-mcp] ${a.map(String).join(' ')}\n`);

const client = new GatewayClient({
  baseUrl: url, token,
  device: { id: `agent-${threadId || process.pid}`, name: 'AppuBot agent bridge', platform: 'cli' },
  WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
  callTimeoutMs: 11 * 60 * 1000,
  log,
});

function waitConnected(timeoutMs = 10_000): Promise<void> {
  if (client.state === 'connected') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { off(); reject(new Error('Could not reach the AppuBot gateway at ' + url)); }, timeoutMs);
    const off = client.onState((s, err) => {
      if (s === 'connected') { clearTimeout(t); off(); resolve(); }
      if (s === 'unauthorized') { clearTimeout(t); off(); reject(new Error('Gateway rejected the agent token: ' + err)); }
    });
  });
}

type ToolResult = { content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[]; isError?: boolean };
const text = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }] });
const err = (e: unknown): ToolResult => ({ content: [{ type: 'text', text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true });

async function act(action: ComputerAction, withShot = true): Promise<ToolResult> {
  await waitConnected();
  const r = await client.call('computer.act', { action, threadId: threadId || undefined });
  const out: ToolResult = { content: [] };
  if (r.text) out.content.push({ type: 'text', text: r.text });
  if (withShot && r.frame) out.content.push({ type: 'image', data: r.frame.data, mimeType: r.frame.mimeType });
  if (!r.ok) out.isError = true;
  if (out.content.length === 0) out.content.push({ type: 'text', text: r.ok ? 'ok' : 'failed' });
  return out;
}

const server = new McpServer({ name: 'appubot', version: '0.1.0' });

/** A step of computer_batch as the gateway's action. */
function stepAction(st: BatchStep, pid: number | undefined, windowId: number | undefined): ComputerAction {
  const at = { pid, windowId, x: st.x, y: st.y, element: st.element, label: st.label, front: st.front };
  switch (st.do) {
    case 'click': return { type: 'click', ...at, detail: st.modifiers?.length ? JSON.stringify({ modifiers: st.modifiers }) : undefined };
    case 'double_click': return { type: 'double_click', ...at };
    case 'right_click': return { type: 'right_click', ...at };
    case 'type': return { type: 'type', text: st.text ?? '', pid, windowId, element: st.element, label: st.label, front: st.front };
    case 'key': return { type: 'key', key: st.key ?? '', pid, windowId, front: st.front };
    case 'scroll': return { type: 'scroll', ...at, detail: JSON.stringify({ direction: st.direction ?? 'down', amount: st.amount ?? 5 }) };
    case 'drag': return { type: 'drag', pid, windowId, x: st.x, y: st.y, toX: st.to_x, toY: st.to_y };
    case 'wait': return { type: 'wait', pid, windowId, detail: String(st.ms ?? 1000) };
    case 'open_app': return { type: 'open_app', app: st.app, detail: JSON.stringify({}) };
  }
}

async function batch(a: { pid?: number; window_id?: number; steps: BatchStep[]; look: 'window' | 'picture' | 'none' }): Promise<ToolResult> {
  await waitConnected();
  const steps = a.steps.map((st) => stepAction(st, st.do === 'open_app' ? undefined : a.pid, st.do === 'open_app' ? undefined : a.window_id));
  const r = await client.call('computer.batch', { steps, look: a.look, threadId: threadId || undefined });
  const out: ToolResult = { content: [{ type: 'text', text: r.text || (r.ok ? 'ok' : 'failed') }] };
  if (r.frame) out.content.push({ type: 'image', data: r.frame.data, mimeType: r.frame.mimeType });
  if (!r.ok) out.isError = true;
  return out;
}

if (computerUse) {
  const T = computerTools;
  // Claude Code would hide these behind its tool search (one more model turn before the first action): load them
  const meta = { 'anthropic/alwaysLoad': true };
  // pointer tools: a label, an element of the latest snapshot or a point of the window picture (where the bot's cursor is drawn)
  const tgt = (a: { pid: number; window_id: number; x?: number; y?: number; element?: string; label?: string }) => ({ pid: a.pid, windowId: a.window_id, x: a.x, y: a.y, element: a.element, label: a.label });
  server.registerTool('computer_batch', { description: T.computer_batch.description, inputSchema: T.computer_batch.input.shape, _meta: meta }, async (a) => batch(a).catch(err));
  server.registerTool('computer_open_app', { description: T.computer_open_app.description, inputSchema: T.computer_open_app.input.shape, _meta: meta }, async (a) => act({ type: 'open_app', app: a.name ?? a.bundle_id, detail: JSON.stringify({ bundle_id: a.bundle_id, url: a.url }) }).catch(err));
  server.registerTool('computer_window', { description: T.computer_window.description, inputSchema: T.computer_window.input.shape, _meta: meta }, async (a) => act({ type: 'window', pid: a.pid, windowId: a.window_id, detail: JSON.stringify({ max_elements: a.max_elements }) }).catch(err));
  server.registerTool('computer_click', { description: T.computer_click.description, inputSchema: T.computer_click.input.shape, _meta: meta }, async (a) => act({ type: a.count === 2 ? 'double_click' : a.button === 'right' ? 'right_click' : 'click', ...tgt(a), front: a.front, detail: JSON.stringify({ button: a.button, count: a.count, modifiers: a.modifiers }) }).catch(err));
  server.registerTool('computer_type', { description: T.computer_type.description, inputSchema: T.computer_type.input.shape, _meta: meta }, async (a) => act({ type: 'type', text: a.text, pid: a.pid, windowId: a.window_id, element: a.element, label: a.label, front: a.front }).catch(err));
  server.registerTool('computer_key', { description: T.computer_key.description, inputSchema: T.computer_key.input.shape, _meta: meta }, async (a) => act({ type: 'key', key: [...a.modifiers, a.key].join('+'), pid: a.pid, windowId: a.window_id, front: a.front }).catch(err));
  server.registerTool('computer_scroll', { description: T.computer_scroll.description, inputSchema: T.computer_scroll.input.shape, _meta: meta }, async (a) => act({ type: 'scroll', ...tgt(a), front: a.front, detail: JSON.stringify({ direction: a.direction, amount: a.amount }) }).catch(err));
  server.registerTool('computer_drag', { description: T.computer_drag.description, inputSchema: T.computer_drag.input.shape }, async (a) => act({ type: 'drag', pid: a.pid, windowId: a.window_id, x: a.from_x, y: a.from_y, toX: a.to_x, toY: a.to_y, detail: String(a.duration_ms) }).catch(err));
  server.registerTool('computer_wait', { description: T.computer_wait.description, inputSchema: T.computer_wait.input.shape }, async (a) => act({ type: 'wait', pid: a.pid, windowId: a.window_id, detail: String(a.ms) }).catch(err));
  server.registerTool('computer_screenshot', { description: T.computer_screenshot.description, inputSchema: T.computer_screenshot.input.shape }, async (a) => act({ type: 'screenshot', detail: a.max_width ? String(a.max_width) : undefined }).catch(err));
  server.registerTool('computer_list_windows', { description: T.computer_list_windows.description, inputSchema: T.computer_list_windows.input.shape, _meta: meta }, async (a) => act({ type: 'other', detail: JSON.stringify({ cmd: 'list_windows', pid: a.pid }) }, false).catch(err));
  server.registerTool('computer_list_apps', { description: T.computer_list_apps.description, inputSchema: T.computer_list_apps.input.shape }, async (a) => act({ type: 'other', detail: JSON.stringify({ cmd: 'list_apps', running_only: a.running_only }) }, false).catch(err));
  server.registerTool('computer_clipboard_read', { description: T.computer_clipboard_read.description, inputSchema: T.computer_clipboard_read.input.shape }, async () => act({ type: 'clipboard', detail: JSON.stringify({ op: 'read' }) }, false).catch(err));
  server.registerTool('computer_clipboard_write', { description: T.computer_clipboard_write.description, inputSchema: T.computer_clipboard_write.input.shape }, async (a) => act({ type: 'clipboard', text: a.text, detail: JSON.stringify({ op: 'write' }) }, false).catch(err));
}

const U = userTools;
server.registerTool('send_file', { description: U.send_file.description, inputSchema: U.send_file.input.shape }, async (a) => {
  try { await waitConnected(); const f = await client.call('agent.sendFile', { path: a.path, caption: a.caption }); return text(`Sent ${f.name} (${f.size} bytes) to the user.`); } catch (e) { return err(e); }
});
server.registerTool('show_page', { description: U.show_page.description, inputSchema: U.show_page.input.shape }, async (a) => {
  try { await waitConnected(); const r = await client.call('agent.showPage', a); return text(`Shown in the chat (${r.bytes} bytes).`); } catch (e) { return err(e); }
});
server.registerTool('start_goal', { description: U.start_goal.description, inputSchema: U.start_goal.input.shape, _meta: { 'anthropic/alwaysLoad': true } }, async ({ objective, max_turns, hours }) => {
  try {
    await waitConnected();
    const { goal } = await client.call('agent.goal.start', { objective, ...(max_turns ? { maxTurns: max_turns } : {}), ...(hours ? { hours } : {}) });
    return text(`The user allowed the goal: "${goal.objective}", up to ${goal.maxTurns} turns. Start on it now; after this turn AppuBot sends you on to the next step until you call finish_goal.`);
  } catch (e) { return err(e); }
});
server.registerTool('finish_goal', { description: U.finish_goal.description, inputSchema: U.finish_goal.input.shape, _meta: { 'anthropic/alwaysLoad': true } }, async ({ status, note }) => {
  try {
    await waitConnected();
    const { goal } = await client.call('agent.goal.finish', { status, note: note ?? '' });
    return text(goal.status === 'done' ? `Goal done after ${goal.turns + 1} turns. Tell the user what you did, briefly.` : 'Goal on hold: the user is told you need them. Say what you need in your reply too.');
  } catch (e) { return err(e); }
});
server.registerTool('send_message', { description: U.send_message.description, inputSchema: U.send_message.input.shape, _meta: { 'anthropic/alwaysLoad': true } }, async (a) => {
  try {
    await waitConnected();
    await client.call('agent.say', a);
    return text('Sent.');
  } catch (e) { return err(e); }
});
// voice: heard and spoken on this computer; loaded up front, since a voice message calls for them unprompted
const secs = (ms: number) => `${Math.max(1, Math.round(ms / 1000))}s`;
server.registerTool('transcribe_audio', { description: U.transcribe_audio.description, inputSchema: U.transcribe_audio.input.shape, _meta: { 'anthropic/alwaysLoad': true } }, async (a) => {
  try {
    await waitConnected();
    const r = await client.call('agent.transcribe', { path: a.path, ...(a.language ? { language: a.language } : {}) });
    return text(r.text ? `Heard (${secs(r.durationMs)}):\n\n${r.text}` : `No words in it (${secs(r.durationMs)} of sound).`);
  } catch (e) { return err(e); }
});
server.registerTool('send_voice', { description: U.send_voice.description, inputSchema: U.send_voice.input.shape, _meta: { 'anthropic/alwaysLoad': true } }, async (a) => {
  try {
    await waitConnected();
    const r = await client.call('agent.speak', { text: a.text, ...(a.caption ? { caption: a.caption } : {}), ...(a.language ? { language: a.language } : {}) });
    return text(`Sent a ${secs(r.durationMs)} voice message.`);
  } catch (e) { return err(e); }
});

server.registerTool('notify_user', { description: U.notify_user.description, inputSchema: U.notify_user.input.shape }, async (a) => {
  try { await waitConnected(); await client.call('agent.notify', a); return text('Notification sent.'); } catch (e) { return err(e); }
});
server.registerTool('ask_user', { description: U.ask_user.description, inputSchema: U.ask_user.input.shape }, async (a) => {
  try { await waitConnected(); const r = await client.call('agent.ask', { question: a.question, options: a.options }); return text(r.answer === null ? 'The user did not answer in time. Proceed with your best judgement or stop and explain.' : `User answered: ${r.answer}`); } catch (e) { return err(e); }
});
server.registerTool('ask_form', { description: U.ask_form.description, inputSchema: U.ask_form.input.shape }, async (a) => {
  try {
    await waitConnected();
    const r = await client.call('agent.askForm', { question: a.question, fields: a.fields.map((f) => ({ ...f, options: f.options ?? [] })), ...(a.submit ? { submit: a.submit } : {}) });
    if (r.declined) return text('The user declined the form. Don\'t ask again unless they bring it up; go on without it or ask what they would like instead.');
    if (r.answer !== undefined) return text(`The user answered in words instead of on the form: ${r.answer}`);
    if (!r.values) return text('The user did not fill in the form in time. Proceed with your best judgement or stop and explain.');
    const lines = a.fields.map((f) => `- ${f.label} (${f.id}): ${r.values![f.id] === undefined ? '(left empty)' : JSON.stringify(r.values![f.id])}`);
    return text(`The user sent the form:\n${lines.join('\n')}`);
  } catch (e) { return err(e); }
});
server.registerTool('telegram_request', { description: U.telegram_request.description, inputSchema: U.telegram_request.input.shape }, async (a) => {
  try {
    await waitConnected();
    const r = await client.call('agent.telegram.request', a.reason ? { reason: a.reason } : {});
    if (r.declined) return text('The user declined connecting Telegram. Don\'t ask again unless they bring it up.');
    if (!r.channel) return text('The user did not connect a Telegram bot in time. Go on without it, or ask what they would like instead.');
    const c = r.channel;
    const how = c.botUsername ? `Open t.me/${c.botUsername}` : 'Open the Telegram bot';
    return text(`${r.already ? 'A Telegram bot is already connected to you' : 'Connected'}${c.botUsername ? `: @${c.botUsername}` : ''}${c.status === 'running' ? '' : ` (status: ${c.status}${c.error ? `, ${c.error}` : ''})`}. ${c.pairingCode ? `Tell the user: ${how} in Telegram and send it "/pair ${c.pairingCode}" to be let in; then they can write to you from there.` : `Tell the user to ${how.toLowerCase()} in Telegram.`}`);
  } catch (e) { return err(e); }
});
server.registerTool('apps_request', { description: U.apps_request.description, inputSchema: U.apps_request.input.shape }, async (a) => {
  try {
    await waitConnected();
    const r = await client.call('agent.apps.request', { slug: a.slug, ...(a.reason ? { reason: a.reason } : {}) });
    if (r.connected && r.on) return text(`${r.name} is connected and on for you. ${r.note ?? ''}`.trim());
    if (r.declined) return text(`The user declined connecting ${r.name}. Don\'t ask again unless they bring it up; go on without it or ask what they would like instead.`);
    if (r.answer !== undefined) return text(`The user answered in words instead of on the card: ${r.answer}`);
    return text(`${r.name} is ${r.connected ? 'connected but still off for you' : 'not connected'}: the user didn't finish in time. Go on without it, or ask what they would like instead.`);
  } catch (e) { return err(e); }
});
// memory tools are small and used unprompted: loaded up front (no tool-search turn first), like the computer tools
const always = { 'anthropic/alwaysLoad': true };
const kb = (chars: number) => `${(chars / 1024).toFixed(1)} KB`;
server.registerTool('remember', { description: U.remember.description, inputSchema: U.remember.input.shape, _meta: always }, async (a) => {
  try {
    await waitConnected();
    const r = await client.call('agent.remember', a);
    const size = r.chars > MEMORY_LOAD_MAX ? ` Your memory is ${kb(r.chars)}, more than the ${kb(MEMORY_LOAD_MAX)} a new thread loads: merge or drop old entries (update_memory, forget).` : '';
    return text(`${r.added ? 'Saved to your memory.' : 'Your memory already says that.'}${size}`);
  } catch (e) { return err(e); }
});
server.registerTool('update_memory', { description: U.update_memory.description, inputSchema: U.update_memory.input.shape, _meta: always }, async (a) => {
  try {
    await waitConnected();
    const r = await client.call('agent.memory.update', a);
    return text(r.added ? `Changed "${r.removed}" to "${r.added}".` : `Removed "${r.removed}".`);
  } catch (e) { return err(e); }
});
server.registerTool('forget', { description: U.forget.description, inputSchema: U.forget.input.shape, _meta: always }, async (a) => {
  try {
    await waitConnected();
    const r = await client.call('agent.memory.forget', a);
    return text(`Removed ${r.removed.length} entr${r.removed.length === 1 ? 'y' : 'ies'}:\n${r.removed.join('\n')}`);
  } catch (e) { return err(e); }
});
server.registerTool('read_memory', { description: U.read_memory.description, inputSchema: U.read_memory.input.shape }, async () => {
  try { await waitConnected(); const r = await client.call('agent.memory.read', {}); return text(`${r.path} (${kb(r.chars)}):\n\n${r.memory}`); } catch (e) { return err(e); }
});
server.registerTool('save_skill', { description: U.save_skill.description, inputSchema: U.save_skill.input.shape }, async (a) => {
  try { await waitConnected(); const s = await client.call('agent.saveSkill', a); return text(`Skill "${s.name}" saved at ${s.path}.`); } catch (e) { return err(e); }
});

// the user's Vault: secrets are typed by AppuBot (vault_fill) or kept in a private file (vault_key), never shown
const V = vaultTools;
const vaultLine = (i: MethodResult<'agent.vault.list'>['items'][number]): string => {
  const c = i.contact;
  const facts = i.kind === 'login' ? [i.site && `site ${i.site}`, i.username && `username ${i.username}`, i.secrets.includes('password') && 'password saved']
    : i.kind === 'card' ? [i.brand, i.hint && `ending ${i.hint}`, i.expiry && `expires ${i.expiry}`, i.cardholder && `cardholder ${i.cardholder}`, i.secrets.includes('cvc') && 'security code saved']
    : i.kind === 'apiKey' ? [i.envName && `variable ${i.envName}`, i.hint && `ends …${i.hint}`]
    : c ? Object.entries(c).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`) : [];
  const kind = { login: 'Login', card: 'Card', contact: 'Contact info', apiKey: 'API key' }[i.kind];
  return `- ${kind} “${i.name}” (id ${i.id}): ${facts.filter(Boolean).join(', ') || 'nothing else saved'}${i.notes ? `\n  Notes: ${i.notes}` : ''}`;
};
server.registerTool('vault_list', { description: V.vault_list.description, inputSchema: V.vault_list.input.shape, _meta: always }, async (a) => {
  try {
    await waitConnected();
    const { items } = await client.call('agent.vault.list', a.kind ? { kind: a.kind } : {});
    return text(items.length ? items.map(vaultLine).join('\n') : 'The Vault has nothing saved yet. The user adds items in Settings › Vault.');
  } catch (e) { return err(e); }
});
if (computerUse) {
  server.registerTool('vault_fill', { description: V.vault_fill.description, inputSchema: V.vault_fill.input.shape, _meta: always }, async ({ window_id, ...a }) => {
    try {
      await waitConnected();
      const r = await client.call('agent.vault.fill', { ...a, windowId: window_id });
      return r.ok ? text(r.text) : { ...text(r.text), isError: true };
    } catch (e) { return err(e); }
  });
}
server.registerTool('vault_request', { description: V.vault_request.description, inputSchema: V.vault_request.input.shape, _meta: always }, async ({ env_name, ...a }) => {
  try {
    await waitConnected();
    const r = await client.call('agent.vault.request', { ...a, ...(env_name ? { envName: env_name } : {}) });
    if (r.declined) return text('The user declined to add it. Don\'t ask them to type it into the chat; go on without it or explain what you can\'t do.');
    if (!r.item) return text('The user did not fill in the card in time. Don\'t ask them to type it into the chat; stop and explain what you need.');
    const how = r.picked ? 'The user picked one they saved before' : 'The user saved it to the Vault';
    const use = r.item.kind === 'apiKey' ? 'Get it with vault_key.' : r.item.kind === 'contact' ? 'Its fields are above; vault_fill types them too.' : computerUse ? 'Type its secrets with vault_fill.' : 'vault_fill types its secrets once computer use is on for you.';
    return text(`${how} (this chat may use it without asking again):\n${vaultLine(r.item)}\n${use}`);
  } catch (e) { return err(e); }
});
server.registerTool('vault_key', { description: V.vault_key.description, inputSchema: V.vault_key.input.shape }, async (a) => {
  try {
    await waitConnected();
    const r = await client.call('agent.vault.key', a);
    return text(`${r.envName} is in ${r.path}. Load it there, e.g. \`set -a; . '${r.path}'; set +a\` before the command that needs it. Don't print it.`);
  } catch (e) { return err(e); }
});

// files on the user's own computer, lent to this one's bots: read-only but for the folders switched to take changes, checked there
if (macFiles) {
  const M = macFilesTools(macFiles);
  type MacEntry = NonNullable<MethodResult<'agent.mac.list'>['entries']>[number];
  const size = (n: number | undefined) => (n === undefined ? '' : n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
  const entryLine = (e: MacEntry) => `- ${e.dir ? '[folder] ' : ''}${e.path}${e.dir ? '' : `  (${[size(e.size), e.modified ? new Date(e.modified).toISOString().slice(0, 10) : ''].filter(Boolean).join(', ')})`}`;
  server.registerTool('mac_files_list', { description: M.mac_files_list.description, inputSchema: M.mac_files_list.input.shape, _meta: always }, async (a) => {
    try {
      await waitConnected();
      const r = await client.call('agent.mac.list', a.path ? { path: a.path } : {});
      if (r.folders) return text(r.folders.length ? `The folders ${r.mac} lends you:\n${r.folders.map((f) => `- ${f.path}${f.writable ? '  (takes your changes: mac_files_put may save files here)' : '  (read-only)'}`).join('\n')}\nList one with its path.` : `${r.mac} is linked but lends no folders yet. The user picks them in AppuBot → Settings › Transfer › Files on your computer, on that computer.`);
      const entries = r.entries ?? [];
      return text(`${r.path ?? a.path} on ${r.mac}:\n${entries.length ? entries.map(entryLine).join('\n') : '(empty)'}${r.truncated ? '\n(More than this: the list is cut. Use mac_files_find for a name.)' : ''}`);
    } catch (e) { return err(e); }
  });
  server.registerTool('mac_files_find', { description: M.mac_files_find.description, inputSchema: M.mac_files_find.input.shape }, async (a) => {
    try {
      await waitConnected();
      const r = await client.call('agent.mac.find', { query: a.query, ...(a.path ? { path: a.path } : {}) });
      return text(r.entries.length ? `Found on ${r.mac}:\n${r.entries.map(entryLine).join('\n')}${r.truncated ? '\n(There may be more: the search stopped early. Narrow it with a folder or a longer name.)' : ''}` : `Nothing on ${r.mac} has “${a.query}” in its name${a.path ? ` under ${a.path}` : ' in the lent folders'}${r.truncated ? ' (the search stopped early: try a folder)' : ''}.`);
    } catch (e) { return err(e); }
  });
  server.registerTool('mac_files_get', { description: M.mac_files_get.description, inputSchema: M.mac_files_get.input.shape }, async (a) => {
    try {
      await waitConnected();
      const r = await client.call('agent.mac.fetch', { path: a.path });
      return text(`${r.name} (${size(r.bytes)}) is here now: ${r.path}`);
    } catch (e) { return err(e); }
  });
  server.registerTool('mac_files_put', { description: M.mac_files_put.description, inputSchema: M.mac_files_put.input.shape }, async (a) => {
    try {
      if ((a.from === undefined) === (a.text === undefined)) return err(new Error('Give either from (a file in your folder) or text, not both.'));
      await waitConnected();
      const r = await client.call('agent.mac.put', { path: a.path, ...(a.from !== undefined ? { from: a.from } : { text: a.text! }) });
      const old = r.replaced ? (r.oldVersion === 'trash' ? ` It replaced the file that was there, whose old version is in the Trash on ${r.mac}.` : ` It replaced the file that was there; AppuBot on ${r.mac} kept the old version.`) : '';
      return text(`Saved ${r.path} on ${r.mac} (${size(r.bytes)}).${old}`);
    } catch (e) { return err(e); }
  });
}

// the user's connected apps: AppuBot runs them through their Composio account, only this bot's apps
if (apps) {
  const A = appsTools;
  server.registerTool('apps_search', { description: A.apps_search.description, inputSchema: A.apps_search.input.shape, _meta: always }, async (a) => {
    try { await waitConnected(); return text((await client.call('agent.apps.search', a)).text); } catch (e) { return err(e); }
  });
  server.registerTool('apps_tool_schemas', { description: A.apps_tool_schemas.description, inputSchema: A.apps_tool_schemas.input.shape }, async (a) => {
    try { await waitConnected(); return text((await client.call('agent.apps.schemas', a)).text); } catch (e) { return err(e); }
  });
  server.registerTool('apps_execute', { description: A.apps_execute.description, inputSchema: A.apps_execute.input.shape, _meta: always }, async (a) => {
    try {
      await waitConnected();
      const r = await client.call('agent.apps.execute', a);
      return r.isError ? { ...text(r.text), isError: true } : text(r.text);
    } catch (e) { return err(e); }
  });
}

const B = botTools;
const json = (v: unknown) => JSON.stringify(v, null, 2);
server.registerTool('list_bots', { description: B.list_bots.description, inputSchema: B.list_bots.input.shape }, async () => {
  try { await waitConnected(); return text(json(await client.call('agent.bots.list', {}))); } catch (e) { return err(e); }
});
server.registerTool('get_bot', { description: B.get_bot.description, inputSchema: B.get_bot.input.shape }, async (a) => {
  try { await waitConnected(); return text(json(await client.call('agent.bots.get', { id: a.bot_id }))); } catch (e) { return err(e); }
});
server.registerTool('update_bot', { description: B.update_bot.description, inputSchema: B.update_bot.input.shape }, async ({ bot_id, agent_id, model_id, mode_id, computer_use, apps_on, apps_off, character_id, ...fields }) => {
  try {
    await waitConnected();
    const patch = Object.fromEntries(Object.entries({
      ...fields, providerId: agent_id, modelId: model_id, modeId: mode_id, computerUse: computer_use, appsTurnOn: apps_on, appsTurnOff: apps_off, characterId: character_id,
    }).filter(([, v]) => v !== undefined));
    if (!Object.keys(patch).length) return err(new Error('Nothing to change: send at least one field'));
    const r = await client.call('agent.bots.update', { id: bot_id, patch });
    const note = r.isYou
      ? 'Saved. Your CLAUDE.md now has this setup; your agent reloads it at the start of your next turn.'
      : `Saved. ${r.bot.name} picks this up at the start of its next turn.`;
    return text(`${note}\n\n${json(r)}`);
  } catch (e) { return err(e); }
});
server.registerTool('create_bot', { description: B.create_bot.description, inputSchema: B.create_bot.input.shape }, async ({ agent_id, computer_use, ...fields }) => {
  try {
    await waitConnected();
    const r = await client.call('agent.bots.create', { ...fields, ...(agent_id ? { providerId: agent_id } : {}), ...(computer_use !== undefined ? { computerUse: computer_use } : {}) });
    return text(`Made ${r.bot.name}. It is in the sidebar, ready for the user.\n\n${json(r)}`);
  } catch (e) { return err(e); }
});
server.registerTool('react', { description: B.react.description, inputSchema: B.react.input.shape }, async ({ emoji, message_id }) => {
  try {
    await waitConnected();
    await client.call('agent.react', { emoji, ...(message_id ? { messageId: message_id } : {}) });
    return text(emoji ? `Reacted ${emoji}.` : 'Reaction removed.');
  } catch (e) { return err(e); }
});
const routineLine = (r: { id: string; name: string; when: string; schedule: string; enabled: boolean; deliverTo: string; nextRunAt?: number }) =>
  `- ${r.name} (id ${r.id}): ${r.when} [${r.schedule}], ${r.enabled ? 'on' : 'off'}, results: ${r.deliverTo === 'thread' ? 'kept in the chat' : 'notify'}${r.nextRunAt ? `, next ${new Date(r.nextRunAt).toLocaleString()}` : ''}`;
server.registerTool('message_bot', { description: B.message_bot.description, inputSchema: B.message_bot.input.shape, _meta: always }, async ({ bot, text: t, wait }) => {
  try {
    await waitConnected();
    const r = await client.call('agent.bots.message', { bot, text: t, ...(wait === undefined ? {} : { wait }) });
    if (r.reply === null) return text(r.timedOut ? `${r.bot.name} is still working on it (no reply within the wait). Its answer stays in its chat; the user can read it there.` : `Sent to ${r.bot.name}. Its reply stays in its chat.`);
    return text(`${r.bot.name} replied:\n${r.reply}`);
  } catch (e) { return err(e); }
});
server.registerTool('message_bots', { description: B.message_bots.description, inputSchema: B.message_bots.input.shape }, async ({ text: t, bot_ids, wait }) => {
  try {
    await waitConnected();
    const r = await client.call('agent.bots.broadcast', { text: t, ...(bot_ids ? { botIds: bot_ids } : {}), ...(wait === undefined ? {} : { wait }) });
    return text(r.replies.map((x) => `## ${x.bot.name}\n${x.reply ?? (x.timedOut ? '(still working: no reply within the wait)' : '(sent)')}`).join('\n\n'));
  } catch (e) { return err(e); }
});
server.registerTool('list_groups', { description: B.list_groups.description, inputSchema: B.list_groups.input.shape }, async () => {
  try {
    await waitConnected();
    const list = await client.call('agent.groups.list', {});
    return text(list.length ? list.map((g) => `${g.name} (${g.id}): ${g.members.map((m) => m.name + (g.lead === m.name ? ' (lead)' : '')).join(', ')}${g.lastMessagePreview ? ` · last: ${g.lastMessagePreview}` : ''}`).join('\n') : 'No groups yet. The user makes them in AppuBot, or ask with create_group.');
  } catch (e) { return err(e); }
});
server.registerTool('post_to_group', { description: B.post_to_group.description, inputSchema: B.post_to_group.input.shape }, async ({ group, text: t }) => {
  try {
    await waitConnected();
    const m = await client.call('agent.groups.post', { group, text: t });
    return text(`Posted to the group${m.mentions.length ? ` (to ${m.mentions.length} bot${m.mentions.length === 1 ? '' : 's'} named)` : ''}. Replies show in the group; you aren't told of them here.`);
  } catch (e) { return err(e); }
});
server.registerTool('create_group', { description: B.create_group.description, inputSchema: B.create_group.input.shape }, async ({ name, bot_ids, lead_id }) => {
  try {
    await waitConnected();
    const g = await client.call('agent.groups.create', { name, botIds: bot_ids, ...(lead_id ? { leadId: lead_id } : {}) });
    return text(`Made the group ${g.name} (${g.id}) with ${g.botIds.length} bot${g.botIds.length === 1 ? '' : 's'}.`);
  } catch (e) { return err(e); }
});
server.registerTool('list_routines', { description: B.list_routines.description, inputSchema: B.list_routines.input.shape }, async ({ bot_id }) => {
  try {
    await waitConnected();
    const list = await client.call('agent.routines.list', bot_id ? { botId: bot_id } : {});
    return text(list.length ? list.map(routineLine).join('\n') : 'No routines yet.');
  } catch (e) { return err(e); }
});
server.registerTool('create_routine', { description: B.create_routine.description, inputSchema: B.create_routine.input.shape }, async ({ bot_id, deliver_to, ...fields }) => {
  try {
    await waitConnected();
    const r = await client.call('agent.routines.create', { ...fields, ...(bot_id ? { botId: bot_id } : {}), ...(deliver_to ? { deliverTo: deliver_to } : {}) });
    return text(`Set up:\n${routineLine(r)}`);
  } catch (e) { return err(e); }
});
server.registerTool('update_routine', { description: B.update_routine.description, inputSchema: B.update_routine.input.shape }, async ({ routine_id, deliver_to, ...patch }) => {
  try {
    await waitConnected();
    const r = await client.call('agent.routines.update', { id: routine_id, patch: { ...patch, ...(deliver_to ? { deliverTo: deliver_to } : {}) } });
    return text(`Updated:\n${routineLine(r)}`);
  } catch (e) { return err(e); }
});
server.registerTool('delete_routine', { description: B.delete_routine.description, inputSchema: B.delete_routine.input.shape }, async ({ routine_id }) => {
  try {
    await waitConnected();
    await client.call('agent.routines.delete', { id: routine_id });
    return text('Removed.');
  } catch (e) { return err(e); }
});
server.registerTool('read_bot_history', { description: B.read_bot_history.description, inputSchema: B.read_bot_history.input.shape }, async (a) => {
  try {
    await waitConnected();
    const m = a.before ? /^(\d+)\|(user|agent)\|(.+)$/.exec(a.before) : null;
    if (a.before && !m) return err(new Error('Unknown cursor: pass `before` exactly as the previous result gave it'));
    const before = m ? { createdAt: Number(m[1]), role: m[2] as 'user' | 'agent', id: m[3]! } : undefined;
    const [bot, page] = await Promise.all([
      client.call('agent.bots.get', { id: a.bot_id }),
      client.call('agent.bots.history', { id: a.bot_id, before, limit: a.limit }),
    ]);
    return text(renderHistory(bot.bot.name, page, !!before));
  } catch (e) { return err(e); }
});

/** A page of a bot's chat as a transcript (oldest first), with the cursor to read further back. */
function renderHistory(botName: string, page: MethodResult<'agent.bots.history'>, earlier: boolean): string {
  if (!page.messages.length) return `${botName}'s threads have no ${earlier ? 'earlier ' : ''}messages.`;
  const who = (m: MethodResult<'agent.bots.history'>['messages'][number]) =>
    m.role === 'agent' ? botName : m.via === 'routine' ? 'Routine' : m.via === 'mobile' ? 'User (phone)' : 'User';
  const lines = page.messages.filter((m) => m.text.trim()).map((m) => `[${new Date(m.createdAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}] ${who(m)}: ${m.text}`);
  const first = page.messages[0]!;
  const more = page.hasMore
    ? `Earlier messages: call read_bot_history again with before: "${first.createdAt}|${first.role}|${first.id}"`
    : 'This is the start of its history.';
  return `${botName}'s threads as one history, oldest first:\n\n${lines.join('\n\n')}\n\n${more}`;
}

async function main() {
  client.connect();
  // listed before the agent asks for the tools; without the gateway the bridge still starts, with its own tools only
  if (connectors) {
    try {
      await waitConnected();
      const { tools } = await client.call('agent.connectors.tools', {});
      addConnectorTools(server, tools, async (name, args) => { await waitConnected(); return client.call('agent.connectors.call', { name, arguments: args }); });
      log('connector tools', tools.length);
    } catch (e) { log('connector tools unavailable', e instanceof Error ? e.message : String(e)); }
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('ready', url, 'computerUse=' + computerUse, 'apps=' + apps);
  const bye = () => { client.close(); process.exit(0); };
  process.on('SIGINT', bye); process.on('SIGTERM', bye);
  process.stdin.on('end', bye);
}
main().catch((e) => { log('fatal', e); process.exit(1); });
// keep zod import used for bundlers
void z;
