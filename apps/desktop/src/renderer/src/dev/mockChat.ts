/**
 * Dev-only: scripted agent runs for the mock gateway (streaming replies, permission follow-ups).
 */
import { messagePreview, newId, type Message, type Part, type PermissionRequest } from '@appubot/protocol';
import type { MockGateway } from './MockGateway';
import { MOCK_FOLLOW_UPS } from './mockMessages';

type Timer = ReturnType<typeof setTimeout>;
type Step = [at: number, fn: () => void];
type ToolCallPart = Extract<Part, { type: 'tool_call' }>;

/** Active scripted runs, one per thread. */
export class Runs {
  private active = new Map<string, { timers: Timer[]; onCancel: () => void }>();

  start(threadId: string, steps: Step[], onCancel: () => void): void {
    this.cancel(threadId);
    const end = steps.reduce((a, [at]) => Math.max(a, at), 0);
    const timers = steps.map(([at, fn]) => setTimeout(fn, at));
    timers.push(setTimeout(() => this.active.delete(threadId), end + 1));
    this.active.set(threadId, { timers, onCancel });
  }

  isActive(threadId: string): boolean {
    return this.active.has(threadId);
  }

  /** Stop a run and run its cancel handler. Returns false if nothing was running. */
  cancel(threadId: string): boolean {
    const run = this.active.get(threadId);
    if (!run) return false;
    run.timers.forEach(clearTimeout);
    this.active.delete(threadId);
    run.onCancel();
    return true;
  }

  /** Stop a run silently (e.g. its thread was deleted). */
  drop(threadId: string): void {
    this.active.get(threadId)?.timers.forEach(clearTimeout);
    this.active.delete(threadId);
  }

  clear(): void {
    for (const run of this.active.values()) run.timers.forEach(clearTimeout);
    this.active.clear();
  }
}

/** Small timeline builder: `at(dt, fn)` schedules fn dt ms after the previous step. */
function timeline(start = 0): { steps: Step[]; at: (dt: number, fn: () => void) => void } {
  const steps: Step[] = [];
  let t = start;
  return { steps, at: (dt, fn) => { t += dt; steps.push([t, fn]); } };
}

function chunks(s: string, re: RegExp): string[] {
  return s.match(re) ?? [s];
}

function finishThread(g: MockGateway, threadId: string, messageId: string): void {
  const m = g.findMessage(threadId, messageId);
  const preview = m ? messagePreview(m) : '';
  g.patchThread(threadId, { status: 'idle', ...(preview ? { lastMessagePreview: preview } : {}) });
}

function keywordOf(text: string): string {
  const words = text.toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) ?? [];
  const stop = new Set(['please', 'could', 'would', 'about', 'there', 'their', 'with', 'from', 'that', 'this', 'what', 'have', 'make', 'into']);
  return words.filter((w) => !stop.has(w)).sort((a, b) => b.length - a.length)[0] ?? 'notes';
}

/**
 * Stream an agent reply into `threadId` over ~4s: thought → search tool call → word-by-word markdown → complete.
 */
export function simulateReply(g: MockGateway, threadId: string, messageId: string, userText: string): void {
  const kw = keywordOf(userText);
  const quoted = userText.length > 90 ? `${userText.slice(0, 89)}…` : userText;
  const thought = `The user said: “${quoted}”. Let me search the workspace for "${kw}" before answering, so I can point at the right files.`;
  const reply = `**Got it.** You asked: _“${quoted.replace(/[_*`]/g, '')}”_

Here's what I found in the workspace:

- \`make_invoice.py\` already handles PDF generation
- Client details live in \`clients/*.json\`
- The most recent match for **${kw}** is in \`notes/clients.md\`

Want me to go ahead and take care of it?`;
  const toolCallId = newId('tc');
  const created = (): Message => {
    const now = Date.now();
    return { id: messageId, threadId, role: 'agent', parts: [], status: 'streaming', via: 'desktop', createdAt: now, updatedAt: now };
  };
  const tool = (status: ToolCallPart['status'], extra: Partial<ToolCallPart> = {}): ToolCallPart => ({
    type: 'tool_call', toolCallId, title: `Search workspace for "${kw}"`, kind: 'search', status, content: [], locations: [],
    rawInput: { pattern: kw, path: '.' }, ...extra,
  });

  const { steps, at } = timeline();
  let toolStart = 0;
  at(300, () => g.addMessage(created()));
  for (const c of chunks(thought, /\S+\s*/g).reduce<string[]>((acc, w, i) => {
    if (i % 4 === 0) acc.push(w); else acc[acc.length - 1] += w;
    return acc;
  }, [])) at(90, () => g.delta(threadId, messageId, 0, 'thought', c));
  at(200, () => { toolStart = Date.now(); g.setMessagePart(threadId, messageId, 1, tool('pending', { startedAt: toolStart })); });
  at(300, () => g.setMessagePart(threadId, messageId, 1, tool('in_progress', { startedAt: toolStart })));
  at(800, () => g.setMessagePart(threadId, messageId, 1, tool('completed', {
    startedAt: toolStart, endedAt: Date.now(),
    content: [{ type: 'text', text: `Found 3 matches for "${kw}":\n- notes/clients.md:14\n- make_invoice.py:52\n- clients/acme.json:2` }],
    locations: [{ path: 'notes/clients.md', line: 14 }, { path: 'make_invoice.py', line: 52 }],
  })));
  at(150, () => undefined);
  for (const w of chunks(reply, /\S+\s*/g)) at(40, () => g.delta(threadId, messageId, 2, 'text', w));
  at(120, () => {
    g.completeMessage(threadId, messageId, 'complete', 'end_turn', g.opts.followUps ? MOCK_FOLLOW_UPS.slice(0, g.opts.followUps) : undefined);
    finishThread(g, threadId, messageId);
  });

  g.runs.start(threadId, steps, () => {
    if (!g.findMessage(threadId, messageId)) g.addMessage(created());
    const m = g.findMessage(threadId, messageId);
    const idx = m?.parts.findIndex((p) => p.type === 'tool_call' && p.status !== 'completed') ?? -1;
    if (idx >= 0) g.setMessagePart(threadId, messageId, idx, tool('failed', { startedAt: toolStart, endedAt: Date.now() }));
    g.completeMessage(threadId, messageId, 'cancelled', 'cancelled');
    finishThread(g, threadId, messageId);
  });
}

/** After the user answers a permission request, finish the tool call it was blocking. */
export function resumeAfterPermission(g: MockGateway, perm: PermissionRequest, allowed: boolean): void {
  const list = g.messages[perm.threadId] ?? [];
  const msg = [...list].reverse().find((m) => m.role === 'agent' && m.parts.some((p) => p.type === 'tool_call' && p.toolCallId === perm.toolCallId));
  if (!msg) {
    g.later(() => g.patchThread(perm.threadId, { status: 'idle' }), 800);
    return;
  }
  const threadId = perm.threadId;
  const messageId = msg.id;
  const idx = msg.parts.findIndex((p) => p.type === 'tool_call' && p.toolCallId === perm.toolCallId);
  const base = msg.parts[idx];
  if (!base || base.type !== 'tool_call') return;
  const startedAt = Date.now();
  const command = typeof perm.rawInput === 'object' && perm.rawInput !== null && 'command' in perm.rawInput ? String(perm.rawInput.command) : perm.title;

  const { steps, at } = timeline();
  if (allowed) {
    const output = `$ ${command}\n\n> invoice-templates@1.4.0 build\n> node scripts/build.mjs\n\n✓ classic.html\n✓ classic-gst.html\n✓ minimal.html\n✓ modern.html\n✓ receipt.html\n✓ credit-note.html\n\nBuilt 6 templates in 1.9s`;
    at(300, () => g.setMessagePart(threadId, messageId, idx, { ...base, status: 'in_progress', startedAt, content: [{ type: 'terminal', terminalId: 'term_build', output: `$ ${command}\n`, exitCode: null }] }));
    at(1800, () => g.setMessagePart(threadId, messageId, idx, { ...base, status: 'completed', startedAt, endedAt: Date.now(), content: [{ type: 'terminal', terminalId: 'term_build', output, exitCode: 0 }] }));
    const words = chunks('\n\nAll **6 templates** rebuilt - the GST line now appears on every invoice layout. Next time I generate an invoice it will use the new build.', /\S+\s*|\s+/g);
    const textIdx = msg.parts.length;
    for (const w of words) at(40, () => g.delta(threadId, messageId, textIdx, 'text', w));
  } else {
    at(250, () => g.setMessagePart(threadId, messageId, idx, { ...base, status: 'failed', startedAt, endedAt: Date.now(), content: [{ type: 'text', text: 'Rejected by you.' }] }));
    const words = chunks('No problem - I left the `build/` folder alone. I can rebuild just the GST template instead if you prefer.', /\S+\s*/g);
    const textIdx = msg.parts.length;
    for (const w of words) at(40, () => g.delta(threadId, messageId, textIdx, 'text', w));
  }
  at(150, () => {
    g.completeMessage(threadId, messageId, 'complete', 'end_turn');
    finishThread(g, threadId, messageId);
  });
  g.runs.start(threadId, steps, () => {
    g.completeMessage(threadId, messageId, 'cancelled', 'cancelled');
    finishThread(g, threadId, messageId);
  });
}
