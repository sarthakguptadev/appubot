// This Mac's own name as Finder and AirDrop show it ("Sarthak’s MacBook Pro"), for the computer switcher and Settings ›
// Account's computers: main reads macOS's ComputerName (electron/computerName.ts) and answers it again on every ask, so
// it is asked at start and whenever the window comes to the front (a rename in System Settings shows up then). A main
// from before the ask, or none, leaves "This Mac". Sentences keep "this Mac" (`THIS_MACHINE`).
import { create } from 'zustand';
import { macDisplayName } from '@appubot/chat-core';
import { MACHINE } from './platform';
import { native } from './native';

const FALLBACK = `This ${MACHINE}`;

const useMacNameStore = create<{ name: string }>(() => ({ name: FALLBACK }));

async function read(): Promise<void> {
  try {
    const name = await native().computerName?.();
    if (typeof name === 'string') useMacNameStore.setState({ name: macDisplayName(name, FALLBACK) });
  } catch { /* a main without the handler (the dev app before its restart): keep what we have */ }
}

let started = false;
function start(): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  void read();
  window.addEventListener('focus', () => void read());
}

/** This Mac's name now, outside React (what a cloud computer's device list calls it). */
export function macName(): string {
  start();
  return useMacNameStore.getState().name;
}

/** This Mac's name ("Sarthak’s MacBook Pro"), else "This Mac". */
export function useMacName(): string {
  start();
  return useMacNameStore((s) => s.name);
}
