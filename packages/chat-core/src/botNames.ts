/**
 * The random names a new bot starts with (the New bot dialog, both apps). The Templates tab that once sat beside them
 * was taken out on 2026-11-18 at the owner's word ("rm templates").
 */
const taken = (names: Iterable<string>): Set<string> => new Set([...names].map((n) => n.trim().toLowerCase()));

/** Short, friendly names a new bot may start with (none reads as a job). */
export const BOT_NAMES: readonly string[] = [
  'Pip', 'Juno', 'Milo', 'Nova', 'Kiwi', 'Mochi', 'Pebble', 'Sprout', 'Ziggy', 'Biscuit', 'Tofu', 'Olive', 'Remy', 'Luna',
  'Otto', 'Fig', 'Basil', 'Clover', 'Dot', 'Echo', 'Fizz', 'Gizmo', 'Hazel', 'Iggy', 'Jinx', 'Koko', 'Lumi', 'Maple',
  'Nimbus', 'Orbit', 'Peanut', 'Quill', 'Rocket', 'Sage', 'Tink', 'Waffle', 'Yuki', 'Zest', 'Bean', 'Cosmo', 'Pixel', 'Sunny',
];

/** A random name from `BOT_NAMES` no bot here has yet (`not`: one to avoid, the name shown now, so a reroll changes it). */
export function randomBotName(names: Iterable<string>, not?: string, rnd: () => number = Math.random): string {
  const used = taken(names);
  if (not) used.add(not.trim().toLowerCase());
  const free = BOT_NAMES.filter((n) => !used.has(n.toLowerCase()));
  if (free.length) return free[Math.floor(rnd() * free.length)]!;
  const base = BOT_NAMES[Math.floor(rnd() * BOT_NAMES.length)]!;
  for (let i = 2; ; i++) if (!used.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`;
}
