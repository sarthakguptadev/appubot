/**
 * Agent profiles already on this Mac (`providers.profiles`): config folders of Claude Code or Codex other than the
 * default one, which can be added as agents of their own (ProvidersService.addProfile). Two kinds:
 * - Synara's: each Claude provider instance in `~/.synara/userdata/settings.json` (`providerInstances`, driver
 *   `claudeAgent`) keeps its config in `provider-homes/claude/instance-<hex of its id>/.claude`, which is the
 *   CLAUDE_CONFIG_DIR it runs with, so the same folder is signed in for AppuBot too (Claude keys its Keychain item by
 *   the folder's path). Instance folders without a settings entry are found as well, named after their id.
 * - `~/.claude-<name>` / `~/.codex-<name>` folders holding a config (the usual way to keep a second account).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { FoundProfile } from '@appubot/protocol';

const isDir = (p: string): boolean => {
  try { return statSync(p).isDirectory(); } catch { return false; }
};
const list = (p: string): string[] => {
  try { return readdirSync(p); } catch { return []; }
};

/** Synara names an instance's folder after its id, hex-encoded. */
const fromHex = (hex: string): string | undefined => {
  if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) return undefined;
  const s = Buffer.from(hex, 'hex').toString('utf8');
  return /^[\w.-]+$/.test(s) ? s : undefined;
};
const toHex = (s: string): string => Buffer.from(s, 'utf8').toString('hex');

/** A Claude config folder: what `claude` leaves in one it has run with. */
const claudeHome = (p: string): boolean => ['.claude.json', 'settings.json', 'projects', '.credentials.json'].some((f) => existsSync(join(p, f)));
const codexHome = (p: string): boolean => ['auth.json', 'config.toml', 'sessions'].some((f) => existsSync(join(p, f)));

function synaraProfiles(synaraDir: string): FoundProfile[] {
  const homes = join(synaraDir, 'provider-homes', 'claude');
  if (!isDir(homes)) return [];
  let instances: Record<string, { driver?: string; displayName?: string }> = {};
  try {
    const settings = JSON.parse(readFileSync(join(synaraDir, 'settings.json'), 'utf8')) as { settings?: { providerInstances?: typeof instances } };
    instances = settings.settings?.providerInstances ?? {};
  } catch { /* no settings: names come from the folders */ }
  const out: FoundProfile[] = [];
  const seen = new Set<string>();
  const add = (id: string, name: string) => {
    const home = join(homes, `instance-${toHex(id)}`, '.claude');
    if (seen.has(home) || !isDir(home) || !claudeHome(home)) return;
    seen.add(home);
    out.push({ of: 'claude-code', name, home, source: 'synara' });
  };
  for (const [id, inst] of Object.entries(instances)) {
    if (inst?.driver === 'claudeAgent') add(id, inst.displayName?.trim() || id);
  }
  for (const dir of list(homes).sort()) {
    const id = dir.startsWith('instance-') ? fromHex(dir.slice('instance-'.length)) : undefined;
    if (id) add(id, id);
  }
  return out;
}

function folderProfiles(home: string): FoundProfile[] {
  const out: FoundProfile[] = [];
  for (const dir of list(home).sort()) {
    const m = dir.match(/^\.(claude|codex)[-_.](.+)$/);
    if (!m) continue;
    const path = join(home, dir);
    if (!isDir(path)) continue;
    const of = m[1] === 'claude' ? 'claude-code' : 'codex';
    if (of === 'claude-code' ? !claudeHome(path) : !codexHome(path)) continue;
    out.push({ of, name: m[2]!, home: path, source: 'folder' });
  }
  return out;
}

/** Every profile folder found under `home` (the user's home folder) and Synara's data folder. */
export function findProfiles(home: string, synaraDir = join(home, '.synara', 'userdata')): FoundProfile[] {
  return [...synaraProfiles(synaraDir), ...folderProfiles(home)];
}

/** A profile name as a provider id's slug: "Work account" -> "work-account". */
export function profileSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'profile';
}
