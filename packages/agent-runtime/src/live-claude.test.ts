import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAgentRuntime, type TurnOp } from './index';

const LIVE = process.env.APPUBOT_LIVE === '1';

describe.skipIf(!LIVE)('live claude-code provider', () => {
  it('answers pong', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'appubot-live-'));
    const ops: TurnOp[] = [];
    const logs: string[] = [];
    const runtime = createAgentRuntime({
      hooks: {
        requestPermission: async (ask) => ask.options.find((o) => o.kind === 'reject_once')?.optionId ?? null,
        onTurnOp: (_sid, op) => ops.push(op),
        onSessionState: () => {},
        log: (level, msg) => logs.push(`${level}: ${msg}`),
      },
    });
    try {
      const [status] = await runtime.detectProviders(['claude-code']);
      console.log('provider status:', JSON.stringify({ installed: status?.installed, version: status?.version, resolvedCommand: status?.resolvedCommand, args: status?.args }));
      const t0 = Date.now();
      const info = await runtime.createSession({ providerId: 'claude-code', cwd: dir });
      console.log(`session ${info.id} ready in ${Date.now() - t0}ms; modes=${info.modes.map((m) => m.id).join(',')} models=${info.models.map((m) => m.id).join(',')} currentModel=${info.currentModelId}`);
      const t1 = Date.now();
      const res = await runtime.prompt(info.id, [{ type: 'text', text: 'Reply with exactly the word pong and nothing else.' }]);
      const text = ops
        .filter((o): o is Extract<TurnOp, { op: 'delta' }> => o.op === 'delta' && o.partType === 'text')
        .map((o) => o.delta)
        .join('');
      console.log(`prompt done in ${Date.now() - t1}ms stopReason=${res.stopReason} usage=${JSON.stringify(res.usage)} text=${JSON.stringify(text)}`);
      console.log('op kinds:', [...new Set(ops.map((o) => o.op))].join(','));
      const [after] = await runtime.detectProviders(['claude-code']);
      console.log('authStatus after:', after?.authStatus, 'capabilities:', JSON.stringify(after?.capabilities));
      expect(res.stopReason).toBe('end_turn');
      expect(text.toLowerCase()).toContain('pong');
    } catch (err) {
      console.log('LIVE FAILURE:', err, '\nlast logs:\n' + logs.slice(-40).join('\n'));
      throw err;
    } finally {
      await runtime.shutdown();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);

  it('takes a message into the running turn (steering)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'appubot-live-'));
    const ops: TurnOp[] = [];
    const logs: string[] = [];
    const runtime = createAgentRuntime({
      hooks: {
        // only a harmless sleep is asked for here
        requestPermission: async (ask) => ask.options.find((o) => o.kind === 'allow_once')?.optionId ?? null,
        onTurnOp: (_sid, op) => ops.push(op),
        onSessionState: () => {},
        log: (level, msg) => logs.push(`${level}: ${msg}`),
      },
    });
    try {
      const info = await runtime.createSession({ providerId: 'claude-code', cwd: dir });
      const running = runtime.prompt(info.id, [{ type: 'text', text: 'Run the shell command `sleep 6` with your Bash tool, then reply with the single word DONE.' }]);
      // once it is busy with the tool, a second message
      const t0 = Date.now();
      while (!ops.some((o) => o.op === 'part' && o.part.type === 'tool_call') && Date.now() - t0 < 60_000) await new Promise((r) => setTimeout(r, 200));
      const before = ops.length;
      const taken = await runtime.steer(info.id, [{ type: 'text', text: 'Also: end your reply with the word BANANA.' }]);
      const res = await running;
      const after = ops.slice(before)
        .filter((o): o is Extract<TurnOp, { op: 'delta' }> => o.op === 'delta' && o.partType === 'text')
        .map((o) => o.delta)
        .join('');
      console.log(`steer taken=${taken} stopReason=${res.stopReason} text after=${JSON.stringify(after)}`);
      expect(taken).toBe(true);
      expect(res.stopReason).toBe('end_turn');
      expect(after.toUpperCase()).toContain('BANANA');
      // with nothing running it hands the message back
      expect(await runtime.steer(info.id, [{ type: 'text', text: 'hello' }])).toBe(false);
    } catch (err) {
      console.log('LIVE FAILURE:', err, '\nlast logs:\n' + logs.slice(-40).join('\n'));
      throw err;
    } finally {
      await runtime.shutdown();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 240_000);
});
