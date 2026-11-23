/** Skills: <workspace>/.claude/skills/<name>/SKILL.md with YAML frontmatter (name, description). */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { slugify, type Bot, type Skill } from '@appubot/protocol';
import type { CoreCtx } from '../context';
import { notFound, RpcError } from '../util';
import { writeFileAtomic } from '../store';

const TAUGHT_MARKER = '.appubot-taught';

export function skillSlug(name: string): string {
  const s = slugify(name).slice(0, 64);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(s)) throw new RpcError('invalid_params', `Invalid skill name: ${name}`);
  return s;
}

function yamlString(s: string): string {
  return JSON.stringify(s.replace(/\s+/g, ' ').trim());
}

export function parseSkillMd(raw: string): { name?: string; description: string; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!m) return { description: '', body: raw };
  const fm: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    let v = kv[2]!.trim();
    if (v.startsWith('"') && v.endsWith('"')) { try { v = JSON.parse(v) as string; } catch { v = v.slice(1, -1); } }
    else if (v.startsWith("'") && v.endsWith("'")) v = v.slice(1, -1).replace(/''/g, "'");
    fm[kv[1]!] = v;
  }
  return { name: fm.name, description: fm.description ?? '', body: m[2] ?? '' };
}

export function renderSkillMd(name: string, description: string, body: string): string {
  const clean = parseSkillMd(body); // tolerate a body that already has frontmatter
  return `---\nname: ${name}\ndescription: ${yamlString(description || clean.description || name)}\n---\n\n${clean.body.trim()}\n`;
}

export class SkillsService {
  constructor(private ctx: CoreCtx) {}

  private dir(bot: Bot): string { return join(bot.workspace, '.claude', 'skills'); }

  private read(bot: Bot, name: string, withBody: boolean): Skill | undefined {
    const dir = join(this.dir(bot), name);
    const file = join(dir, 'SKILL.md');
    if (!existsSync(file)) return undefined;
    const raw = readFileSync(file, 'utf8');
    const p = parseSkillMd(raw);
    return {
      name, description: p.description, path: file,
      source: existsSync(join(dir, TAUGHT_MARKER)) ? 'taught' : 'user',
      botId: bot.id, updatedAt: Math.round(statSync(file).mtimeMs),
      ...(withBody ? { body: p.body.trim() } : {}),
    };
  }

  list(botId?: string): Skill[] {
    const bots = botId ? [this.ctx.s.bots.require(botId)] : this.ctx.s.bots.list();
    const out: Skill[] = [];
    for (const bot of bots) {
      const d = this.dir(bot);
      if (!existsSync(d)) continue;
      for (const name of readdirSync(d)) {
        try { const s = this.read(bot, name, false); if (s) out.push(s); } catch { /* ignore broken skill */ }
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(botId: string, name: string): Skill {
    const s = this.read(this.ctx.s.bots.require(botId), skillSlug(name), true);
    if (!s) throw notFound('Skill', name);
    return s;
  }

  save(botId: string, name: string, description: string, body: string, source: 'taught' | 'user' = 'user'): Skill {
    const bot = this.ctx.s.bots.require(botId);
    const slug = skillSlug(name);
    const dir = join(this.dir(bot), slug);
    mkdirSync(dir, { recursive: true });
    writeFileAtomic(join(dir, 'SKILL.md'), renderSkillMd(slug, description, body));
    if (source === 'taught') writeFileSync(join(dir, TAUGHT_MARKER), new Date().toISOString());
    const s = this.read(bot, slug, true)!;
    this.ctx.bus.emit('skill.updated', s);
    return s;
  }

  delete(botId: string, name: string): { ok: true } {
    const bot = this.ctx.s.bots.require(botId);
    const slug = skillSlug(name);
    const dir = join(this.dir(bot), slug);
    if (!existsSync(dir)) throw notFound('Skill', name);
    rmSync(dir, { recursive: true, force: true });
    this.ctx.bus.emit('skill.deleted', { botId, name: slug });
    return { ok: true };
  }
}
