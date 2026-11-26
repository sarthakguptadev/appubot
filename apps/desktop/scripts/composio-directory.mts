/**
 * Builds the apps directory shipped with the app (src/main/core/services/composioDirectory.json) from Composio's
 * platform API with the maker's own key. Run by hand when the list should change, then commit the file: releases ship
 * it as it is and never fetch it.
 *   pnpm -C apps/desktop apps-directory
 * The key (ak_…, dashboard.composio.dev → Platform → API Keys) is kept in the login Keychain, never in the repo:
 *   security add-generic-password -U -a "$USER" -s appubot-composio-api-key -w
 * (it asks for the key). COMPOSIO_API_KEY overrides it for one run.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { composioApi } from '../src/main/core/services/composioApi';
import { buildDirectory } from '../src/main/core/services/composioDirectory';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '../src/main/core/services/composioDirectory.json');

export const KEYCHAIN_SERVICE = 'appubot-composio-api-key';

function keychainKey(): string | undefined {
  if (process.platform !== 'darwin') return undefined;
  try {
    return execFileSync('/usr/bin/security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

const key = process.env.COMPOSIO_API_KEY?.trim() || keychainKey();
if (!key) {
  console.error(`No Composio key. Save one (ak_…, dashboard.composio.dev → Platform → API Keys) in the Keychain once:
  security add-generic-password -U -a "$USER" -s ${KEYCHAIN_SERVICE} -w`);
  process.exit(1);
}
const dir = await buildDirectory(composioApi(key));
if (dir.toolkits.length < 50) {
  console.error(`Composio listed only ${dir.toolkits.length} apps; keeping the current directory.`);
  process.exit(1);
}
writeFileSync(out, `${JSON.stringify(dir)}\n`);
console.log(`${dir.toolkits.length} apps in ${dir.categories.length} categories → ${out}`);
