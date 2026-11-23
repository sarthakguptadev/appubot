/**
 * This Mac's (or PC's) name as Finder and AirDrop show it, "Sarthak’s MacBook Pro" (macOS's ComputerName, `scutil
 * --get ComputerName`), else the host name made readable (chat-core `macDisplayName`: "Sarthaks-MacBook-Pro.local" →
 * "Sarthaks MacBook Pro"), else "This Mac". It names the computer in the switcher, Settings › Account, pairing QR
 * codes, phones' lists and the health check (`CoreDeps.hostName` reads `computerName()`), and is read again every
 * `REFRESH_MS` and whenever the window asks (`appubot:computerName`, on its focus): a rename in System Settings shows up
 * without a restart, and the phones hear of it through `system.updated`.
 */
import { execFile, execFileSync } from 'node:child_process';
import { hostname } from 'node:os';
import { macDisplayName } from '@appubot/chat-core';
import { machineName } from '@appubot/protocol';

const REFRESH_MS = 10 * 60_000;
const FALLBACK = `This ${machineName(process.platform)}`;

let current = '';
const listeners = new Set<(name: string) => void>();

function fromHost(): string {
  return macDisplayName(hostname(), FALLBACK);
}

/** The name now (read once, synchronously, the first time: the core needs it at start). */
export function computerName(): string {
  if (current) return current;
  if (process.platform === 'darwin') {
    try { current = macDisplayName(execFileSync('/usr/sbin/scutil', ['--get', 'ComputerName'], { encoding: 'utf8', timeout: 2000 }), ''); } catch { /* scutil missing */ }
  }
  if (!current) current = fromHost();
  return current;
}

/** Reads the name again (without blocking) and answers it; listeners hear only a change. */
export function refreshComputerName(): Promise<string> {
  return new Promise((resolve) => {
    const done = (name: string) => {
      const next = name || fromHost();
      if (next !== current) {
        current = next;
        for (const l of listeners) l(next);
      }
      resolve(current);
    };
    if (process.platform !== 'darwin') { done(fromHost()); return; }
    execFile('/usr/sbin/scutil', ['--get', 'ComputerName'], { encoding: 'utf8', timeout: 2000 }, (err, out) => done(err ? '' : macDisplayName(out, '')));
  });
}

/** Calls `cb` with each new name; refreshes every `REFRESH_MS` while anyone listens. */
export function onComputerName(cb: (name: string) => void): () => void {
  listeners.add(cb);
  const timer = setInterval(() => void refreshComputerName(), REFRESH_MS);
  timer.unref?.();
  return () => { listeners.delete(cb); clearInterval(timer); };
}
