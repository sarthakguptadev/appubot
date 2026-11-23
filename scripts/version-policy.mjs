#!/usr/bin/env node
/**
 * Stop old AppuBot versions. Every installed app reads version-policy.json from the public releases repo at launch and
 * every half hour (chat-core VERSION_POLICY_URL; the desktop in core/services/appUpdate.ts, the phone in
 * the phone app). A stopped desktop shows "Update required" over the whole window and refuses
 * everything but updating; a stopped phone app shows only its app store, and every computer refuses it at hello and
 * pairing (so phones from before they read the policy are stopped too). The file is written whole each time: a run
 * names every stop that should stand, and one with no versions lets every version work again. Writes with your own
 * `gh` login (it needs write access to the releases repo).
 *   pnpm version-policy --min 2026.1108.1
 *   pnpm version-policy --block 2026.1107.1,2026.1107.2 --message "This version can lose your bots' memory. Update now."
 *   pnpm version-policy --phone-min 2026.1108.1 --phone-message "Update the AppuBot app from the App Store."
 *   pnpm version-policy --min 2026.1108.1 --phone-block 2026.1107.1      (desktop and phone stops together)
 *   pnpm version-policy                     (lifts every stop)
 */
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';

const REPO = 'sarthakguptadev/appubot';
const { values } = parseArgs({ options: {
  min: { type: 'string' }, block: { type: 'string' }, message: { type: 'string' },
  'phone-min': { type: 'string' }, 'phone-block': { type: 'string' }, 'phone-message': { type: 'string' },
} });
const trim = (s) => (s ?? '').trim();
/** one side's rules from its three flags */
const rules = (min, block, message) => {
  const minVersion = trim(min);
  const blocked = trim(block).split(',').map(trim).filter(Boolean);
  const msg = trim(message);
  for (const v of [minVersion, ...blocked].filter(Boolean)) {
    if (!/^\d+\.\d+\.\d+$/.test(v)) {
      console.error(`Not a version: ${v} (versions look like 2026.1107.1, or 2026.10.17 before 2026-11-07)`);
      process.exit(1);
    }
  }
  return { ...(minVersion ? { minVersion } : {}), ...(blocked.length ? { blocked } : {}), ...(msg ? { message: msg } : {}) };
};
const desktop = rules(values.min, values.block, values.message);
const phone = rules(values['phone-min'], values['phone-block'], values['phone-message']);
const min = desktop.minVersion ?? '';
const blocked = desktop.blocked ?? [];
const policy = { ...desktop, ...(phone.minVersion || phone.blocked ? { phone } : {}), updatedAt: new Date().toISOString() };
const json = `${JSON.stringify(policy, null, 2)}\n`;
console.log(json.trimEnd());

const gh = (args, input) => execFileSync('gh', args, { encoding: 'utf8', input, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
let sha = '';
try {
  sha = gh(['api', `repos/${REPO}/contents/version-policy.json`, '--jq', '.sha']).trim();
} catch {
  // no policy yet
}
const body = JSON.stringify({
  message: `Version policy: oldest working ${min || 'any'}, stopped ${blocked.join(',') || 'none'}; phone oldest ${phone.minVersion || 'any'}, stopped ${phone.blocked?.join(',') || 'none'}`,
  content: Buffer.from(json).toString('base64'),
  ...(sha ? { sha } : {}),
});
gh(['api', '-X', 'PUT', `repos/${REPO}/contents/version-policy.json`, '--input', '-'], body);
console.log('Installed apps pick this up within about half an hour.');
