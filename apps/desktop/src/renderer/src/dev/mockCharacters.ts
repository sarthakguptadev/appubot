/**
 * Dev-only: custom characters for the mock gateway. The library starts with two; Generate "draws" three from a small
 * pool after a few seconds (the description picks which), Import and the rest work as on the computer.
 * `?characters=off` is a computer that predates characters (no `characters` in the snapshot, `unknown_method`),
 * `?characters=fail` makes Generate fail like an agent that isn't signed in, `?characters=worn` dresses Ledger in one,
 * `?characters=many` fills the library (the picker's rows scroll).
 */
import { CharacterSchema, newId, type Character, type CharacterDraft } from '@appubot/protocol';
import { cleanCharacterName, normalizeCharacter } from '@appubot/chat-core';
import { GatewayError } from '../lib/gateway';
import type { Handlers } from './mockHandlers';
import type { MockGateway } from './MockGateway';

type CharacterHandlers = Pick<Handlers, 'characters.list' | 'characters.generate' | 'characters.cancel' | 'characters.save' | 'characters.rename' | 'characters.delete'>;

const option = (): string | null => (typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('characters'));
export const mockCharactersOff = (): boolean => option() === 'off';
export const mockCharactersWorn = (): boolean => option() === 'worn';

/** Hand-drawn silhouettes, as an agent might send them (fitted and faced by chat-core like any). */
const POOL: { name: string; body: string; face?: { x: number; y: number; s: number } }[] = [
  { name: 'Whiskers', body: 'M24 40L18 10L40 28Q50 25 60 28L82 10L76 40C88 52 88 90 50 90C12 90 12 52 24 40Z', face: { x: 50, y: 58, s: 0.95 } },
  { name: 'Boo', body: 'M18 48C18 18 82 18 82 48L82 88L72 80L61 88L50 80L39 88L28 80L18 88Z', face: { x: 50, y: 46, s: 0.9 } },
  { name: 'Hops', body: 'M30 46C22 30 24 6 34 6C42 6 42 30 42 40Z M58 40C58 30 58 6 66 6C76 6 78 30 70 46Z M50 34C78 34 88 52 88 66C88 84 72 92 50 92C28 92 12 84 12 66C12 52 22 34 50 34Z' },
  { name: 'Inky', body: 'M20 50C20 18 80 18 80 50L80 70Q86 80 78 88Q72 80 66 88Q60 80 54 88Q50 80 46 88Q40 80 34 88Q28 80 22 88Q14 80 20 70Z', face: { x: 50, y: 48, s: 0.9 } },
  { name: 'Bruno', body: 'M14 22A12 12 0 1 1 38 22A12 12 0 1 1 14 22Z M62 22A12 12 0 1 1 86 22A12 12 0 1 1 62 22Z M50 20C72 20 88 36 88 56C88 78 72 92 50 92C28 92 12 78 12 56C12 36 28 20 50 20Z' },
  { name: 'Bolt', body: 'M46 4H54V24H46Z M22 30Q22 22 30 22H70Q78 22 78 30V80Q78 90 68 90H32Q22 90 22 80Z M8 44H24V68H8Z M76 44H92V68H76Z' },
];

function draft(i: number): CharacterDraft {
  const p = POOL[i % POOL.length]!;
  const r = normalizeCharacter({ body: p.body, face: p.face ?? null }, { orient: true });
  if (!r.ok) throw new Error(r.error);
  return { name: p.name, body: r.body, face: r.face };
}

export function mockCharacters(): Character[] | undefined {
  if (mockCharactersOff()) return undefined;
  const now = Date.now();
  const picks = option() === 'many' ? Array.from({ length: 14 }, (_, i) => i) : [0, 3];
  return picks.map((i, n) => CharacterSchema.parse({ id: `chr_mock${n}`, ...draft(i), source: 'generated', createdAt: now - (2 - n) * 86_400_000 }));
}

export function createCharacterHandlers(g: MockGateway): CharacterHandlers {
  const running = new Map<string, () => void>();
  const off = () => { if (mockCharactersOff()) throw new GatewayError('unknown_method', 'Unknown method'); };
  const list = (): Character[] => g.db.characters ?? (g.db.characters = []);
  return {
    'characters.list': () => { off(); return list(); },
    'characters.generate': (p) => {
      off();
      const key = p.requestId ?? 'one';
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => {
          running.delete(key);
          if (option() === 'fail') return reject(new GatewayError('needs_auth', 'Claude Code isn’t signed in. Sign in to it in Settings › Agents, then try again.'));
          let h = 0;
          for (const ch of p.prompt) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
          resolve({ candidates: [0, 1, 2].map((k) => draft(h + k * 2)), providerId: 'claude-code' });
        }, 3500);
        running.set(key, () => { clearTimeout(t); reject(new GatewayError('cancelled', 'Stopped.')); });
      });
    },
    'characters.cancel': (p) => {
      for (const [k, stop] of running) if (!p?.requestId || k === p.requestId) { stop(); running.delete(k); }
      return { ok: true as const };
    },
    'characters.save': (p) => {
      off();
      const r = normalizeCharacter({ body: p.body, face: p.face ?? null }, { limits: { maxChars: 12_000, maxSegments: 4000 } });
      if (!r.ok) throw new GatewayError('invalid_params', r.error);
      const c = CharacterSchema.parse({ id: newId('chr'), name: cleanCharacterName(p.name), body: r.body, face: r.face, source: p.source, createdAt: Date.now() });
      g.db.characters = [...list(), c];
      g.emit('character.updated', c);
      return c;
    },
    'characters.rename': (p) => {
      const c = list().find((x) => x.id === p.id);
      if (!c) throw new GatewayError('not_found', 'Character not found');
      const next = { ...c, name: cleanCharacterName(p.name, c.name) };
      g.db.characters = list().map((x) => (x.id === p.id ? next : x));
      g.emit('character.updated', next);
      return next;
    },
    'characters.delete': (p) => {
      g.db.characters = list().filter((x) => x.id !== p.id);
      g.emit('character.removed', { id: p.id });
      let bots = 0;
      g.db.bots = g.db.bots.map((b) => {
        if (b.characterId !== p.id) return b;
        bots++;
        const { characterId: _c, ...rest } = b;
        const next = { ...rest, updatedAt: Date.now() };
        g.emit('bot.updated', next);
        return next;
      });
      return { ok: true as const, bots };
    },
  };
}
