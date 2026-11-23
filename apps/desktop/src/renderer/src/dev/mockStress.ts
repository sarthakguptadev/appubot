/**
 * Dev-only: `?stress=long` stretches the seed (very long names, many routines, skills, devices and channels) and
 * `?stress=empty` empties the lists, so the audit can see how Settings, the panels and the editors hold up.
 */
import type { Snapshot } from '@appubot/protocol';

const LONG = 'Extraordinarily Long Bot Name That Keeps Going Well Past Any Sensible Width';

export function stressSnapshot(s: Snapshot): Snapshot {
  const q = new URLSearchParams(typeof location === 'undefined' ? '' : location.search);
  const mode = q.get('stress');
  if (mode === 'empty') return { ...s, routines: [], skills: [], devices: [], channels: [] };
  if (mode !== 'long') return s;
  const [first, ...rest] = s.bots;
  const bots = first ? [{ ...first, name: LONG, job: `${LONG}: the job line runs on and on so that it wraps or truncates somewhere sensible` }, ...rest] : s.bots;
  const botId = first?.id ?? '';
  const routines = Array.from({ length: 14 }, (_, i) => ({
    ...s.routines[0]!, id: `rt_long_${i}`, botId,
    name: i === 0 ? `${LONG} routine that summarises everything every single morning` : `Routine number ${i + 1}`,
    enabled: i % 3 !== 0,
  }));
  const skills = Array.from({ length: 16 }, (_, i) => ({
    ...s.skills[i % s.skills.length]!, botId,
    name: i === 0 ? 'a-very-long-skill-name-that-goes-on-and-on-without-any-spaces-to-break-it' : `skill-${i + 1}`,
    description: i === 0 ? `${LONG}. ${LONG}. ${LONG}.` : s.skills[i % s.skills.length]!.description,
  }));
  const devices = [
    { ...s.devices[0]!, name: `${LONG} iPhone 17 Pro Max` },
    ...Array.from({ length: 8 }, (_, i) => ({ ...s.devices[1]!, id: `dev_long_${i}`, name: `Test phone ${i + 1}` })),
  ];
  const providers = s.providers.map((p) => (p.id === 'cursor' ? { ...p, auth: { ...p.auth!, account: 'someone.with.a.really.long.email.address@an-equally-long-company-domain.example.com' } } : p));
  return { ...s, bots, routines, skills, devices, providers };
}
