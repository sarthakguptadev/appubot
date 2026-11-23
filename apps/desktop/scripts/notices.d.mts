import type { Plugin } from 'vite';

/** Notes the packages a build bundled; with `write`, writes THIRD_PARTY_NOTICES.txt when it's done (scripts/notices.mjs). */
export function noticesPlugin(target: 'main' | 'preload' | 'renderer', options?: { write?: boolean }): Plugin;
export function packageDirOf(id: string): string | null;
export function writeNotices(): { packages: number; bytes: number };
