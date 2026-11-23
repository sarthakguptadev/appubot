/**
 * AppuBot's own updates: electron-updater reading the public GitHub releases repo that electron-builder.yml's `publish`
 * names (built into the app as `resources/app-update.yml`). The core decides when to check (core/services/appUpdate.ts);
 * a newer release downloads at once and installs on the next quit, or now through `install` (Settings › About).
 */
import { VERSION_POLICY_URL } from '@appubot/chat-core';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import { autoUpdater } from 'electron-updater';
import { POSTHOG } from '@appubot/protocol';
import type { AppUpdaterEvent, AppUpdaterHost } from '../core/services/appUpdate';
import type { Logger } from '../core/util';
import { INSTALL_GIVE_UP_MS } from '../core/services/updateRestart';
import { markQuitting, unmarkQuitting } from './window';

/**
 * Which versions still work (core/services/appUpdate.ts reads it): a file in the same public releases repo, written by
 * `pnpm version-policy` (scripts/version-policy.mjs) in the source repo.
 */
export { VERSION_POLICY_URL };

/** Usage analytics (core/services/analytics.ts): our releases only, the one build given the PostHog key (protocol `POSTHOG`). */
const POSTHOG_KEY: string | undefined = import.meta.env.MAIN_VITE_POSTHOG_KEY;
export const ANALYTICS = POSTHOG_KEY ? { key: POSTHOG_KEY, host: POSTHOG.host } : undefined;

/**
 * Undefined where the build can't update itself: not packaged, no `app-update.yml` (built without a `publish` config),
 * or electron-updater says no (Linux: neither the AppImage nor the .deb).
 */
export function createAppUpdaterHost(log: Logger): AppUpdaterHost | undefined {
  if (!app.isPackaged || !existsSync(join(process.resourcesPath, 'app-update.yml'))) return undefined;
  autoUpdater.logger = {
    info: (m: unknown) => log.info(`updater: ${String(m)}`),
    warn: (m: unknown) => log.warn(`updater: ${String(m)}`),
    error: (m: unknown) => log.warn(`updater: ${String(m)}`),
    debug: (m: unknown) => log.debug(`updater: ${String(m)}`),
  };
  if (!autoUpdater.isUpdaterActive()) return undefined;
  autoUpdater.autoDownload = true;
  // a downloaded update installs whenever AppuBot quits, if it wasn't restarted for it before
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;

  const listeners = new Set<(e: AppUpdaterEvent) => void>();
  const emit = (e: AppUpdaterEvent): void => { for (const fn of listeners) fn(e); };
  autoUpdater.on('checking-for-update', () => emit({ type: 'checking' }));
  autoUpdater.on('update-not-available', () => emit({ type: 'none' }));
  autoUpdater.on('update-available', (info) => emit({ type: 'available', version: info.version }));
  autoUpdater.on('download-progress', (p) => emit({ type: 'progress', percent: p.percent }));
  autoUpdater.on('update-downloaded', (info) => emit({ type: 'downloaded', version: info.version }));
  autoUpdater.on('error', (e) => emit({ type: 'error', message: e?.message ?? String(e) }));

  return {
    async check() {
      await autoUpdater.checkForUpdates();
    },
    install() {
      // the user asked for it: no quit prompt (index.ts before-quit), and the window closes rather than hides
      markQuitting();
      // silent: the Windows installer is the assisted one (nsis.oneClick false) and would show its pages; then reopen
      autoUpdater.quitAndInstall(true, true);
      // still running a while later: the install failed (the core won't try this version by itself again)
      const t = setTimeout(() => { unmarkQuitting(); log.warn('updater: the install did not quit AppuBot'); }, INSTALL_GIVE_UP_MS);
      t.unref?.();
    },
    onEvent(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
