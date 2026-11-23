/**
 * Startup timing for apps/desktop/bench/startup.mjs: with `APPUBOT_STARTUP_TRACE=<file>` each mark is appended to that
 * file as `{name, at}` (epoch ms, comparable with the bench's own clock and the renderer's performance marks). Without
 * it every call is a no-op, so the marks stay in the shipped code at no cost.
 */
import { writeFileSync } from 'node:fs';

const file = process.env.APPUBOT_STARTUP_TRACE;
const marks: { name: string; at: number }[] = [];

export function traceMark(name: string): void {
  if (!file) return;
  marks.push({ name, at: performance.timeOrigin + performance.now() });
  try { writeFileSync(file, JSON.stringify({ pid: process.pid, marks })); } catch { /* bench only */ }
}
