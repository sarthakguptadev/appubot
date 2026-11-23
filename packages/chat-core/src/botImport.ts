/**
 * Bringing bots over from another assistant (Settings › Import, 2026-11-14). None of them exports its setup, but each
 * can be asked: the person pastes `importPrompt` into the other product, it answers with its bots, memory, routines
 * and skills as one JSON document in the shape below, and `parseImport` reads that file (or the pasted answer) back.
 * Pure: the window does the creating, with the computer's ordinary calls.
 *
 * What comes in is another model's writing, so it is read strictly and never trusted: text only, every field capped,
 * a schedule kept only if it is a plain cron expression, nothing that could grant power (no agent, model, permission
 * mode, computer use or app is ever read). Routines arrive switched off.
 */
import { appendMemory, memoryTemplate } from './memory';

export const IMPORT_FORMAT = 'appubot-import';
export const IMPORT_VERSION = 1;
export const IMPORT_FILE_NAME = 'appubot-import.json';

export const IMPORT_BOTS_MAX = 20;
export const IMPORT_NAME_MAX = 40;
export const IMPORT_JOB_MAX = 300;
export const IMPORT_INSTRUCTIONS_MAX = 8000;
export const IMPORT_MEMORY_MAX = 300;
export const IMPORT_FACT_MAX = 500;
export const IMPORT_ROUTINES_MAX = 30;
export const IMPORT_SKILLS_MAX = 30;
export const IMPORT_SKILL_BODY_MAX = 20000;
/** a file larger than this isn't an answer to the prompt */
export const IMPORT_TEXT_MAX = 2_000_000;

export interface ImportSource {
  id: string;
  name: string;
  /** one line for the prompt: where that product keeps what we ask for, in its own words */
  hint: string;
}

/** Where people come from: the products that keep bots for someone, the ones most like AppuBot first. (Plain chat
 * assistants and a free-for-all "another assistant" were listed at first and taken out: they aren't bots.) */
export const IMPORT_SOURCES: ImportSource[] = [
  { id: 'grokbot', name: 'Grok Bot', hint: 'Cover every bot I have: each one’s profile, its memory, its routines and its skills. Ask the other bots or read their files on our shared computer if you need to.' },
  { id: 'dots', name: 'dots', hint: 'Cover every dot I have: what each is for, its instructions, what it remembers, its scheduled tasks and its saved skills.' },
  { id: 'muse', name: 'Muse', hint: 'Cover everything you keep for me: your instructions and personality, what you remember about me, your scheduled tasks and your saved skills.' },
  { id: 'openbot', name: 'OpenBot', hint: 'Cover every bot I have: its instructions, its memory, its routines and its skills.' },
  { id: 'mausbot', name: 'MausBot', hint: 'Cover every bot I have: its instructions, its memory, its routines and its skills.' },
  { id: 'openclaw', name: 'OpenClaw', hint: 'Cover every agent I have: its SOUL.md, AGENTS.md and USER.md as instructions, MEMORY.md and the daily memory notes as memory, its cron jobs and heartbeat tasks as routines, and its skills.' },
  { id: 'hermes', name: 'Hermes Agent', hint: 'Cover your persona and instructions, your memory and user profile, your scheduled (cron) tasks and your skills.' },
  { id: 'manus', name: 'Manus', hint: 'Cover your custom instructions, the knowledge you keep about me, my scheduled tasks and any saved playbooks.' },
];

export function importSource(id: string): ImportSource {
  return IMPORT_SOURCES.find((s) => s.id === id) ?? IMPORT_SOURCES[0]!;
}

/** The prompt to send to the other assistant: it answers with its setup as JSON in our shape. */
export function importPrompt(sourceId: string): string {
  const src = importSource(sourceId);
  const from = src.name;
  return [
    'I’m moving my setup to AppuBot. Write out everything of mine that you hold as one JSON document, so AppuBot can read it in.',
    '',
    src.hint,
    '',
    'For each bot (if there is only you, that is one bot) give:',
    '- name',
    '- job: one line saying what it is for',
    '- instructions: its standing instructions or personality, in full, word for word',
    '- memory: every lasting fact it remembers about me and my work, one short sentence each',
    '- routines: every scheduled or recurring task, with the exact prompt it runs and when it runs, as a 5-field cron expression in my local time and also in words (if you don\u2019t know the exact time, pick a sensible one and say so in the words)',
    '- skills: every saved skill, workflow or how-to, with its steps in full',
    '',
    'Rules:',
    '- Leave out passwords, API keys, tokens, card numbers and anything else secret: write "[left out]" in their place.',
    '- Don’t summarise or shorten, and don’t invent anything you don’t have. Use an empty list where there is nothing.',
    '- Answer with the JSON only, in one code block, in exactly this shape:',
    '',
    '```json',
    JSON.stringify({
      format: IMPORT_FORMAT,
      version: IMPORT_VERSION,
      from,
      bots: [{
        name: '',
        job: '',
        instructions: '',
        memory: [''],
        routines: [{ name: '', prompt: '', cron: '0 9 * * 1-5', when: 'Weekdays at 9:00' }],
        skills: [{ name: '', description: '', steps: '' }],
      }],
    }, null, 2),
    '```',
    '',
    `If it is long, save it as a file named ${IMPORT_FILE_NAME} and give me the file.`,
  ].join('\n');
}

export interface ImportRoutine { name: string; prompt: string; schedule: string; when: string }
export interface ImportSkill { name: string; description: string; body: string }
export interface ImportBot {
  name: string;
  job: string;
  instructions: string;
  memory: string[];
  routines: ImportRoutine[];
  skills: ImportSkill[];
}
export interface ImportFile {
  /** the product it says it came from ('' when it didn't say) */
  from: string;
  bots: ImportBot[];
  /** what was left out or cut, in plain words, for the person to read before importing */
  notes: string[];
}

/** Why a file couldn't be read, in words for the person. */
export class ImportError extends Error {}

const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
/** a value as one tidy line */
const line = (v: unknown, max: number): string => str(v).replace(/\s+/g, ' ').trim().slice(0, max);
/** a value as text, its line ends kept */
const text = (v: unknown, max: number): string => str(v).replace(/\r\n?/g, '\n').trim().slice(0, max);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
/** the first of several keys an assistant might have used */
const pick = (o: Record<string, unknown>, ...keys: string[]): unknown => {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k];
  return undefined;
};

/** A plain 5-field cron expression (numbers, `*`, `,`, `-`, `/` only): nothing else is taken as a schedule. */
export function plainCron(v: unknown): string {
  const s = str(v).trim().replace(/\s+/g, ' ');
  const fields = s.split(' ');
  if (fields.length !== 5) return '';
  return fields.every((f) => /^(\*|\d{1,2})([-,/](\*|\d{1,2}))*$/.test(f) || /^\*\/\d{1,2}$/.test(f)) ? s : '';
}

/** The JSON inside an answer: the whole text, else its first code block, else from its first `{` to its last `}`. */
function jsonIn(raw: string): unknown {
  const tries: string[] = [raw.trim()];
  for (const m of raw.matchAll(/```(?:json|JSON)?\s*\n([\s\S]*?)```/g)) tries.push((m[1] ?? '').trim());
  const a = raw.indexOf('{'), b = raw.lastIndexOf('}');
  if (a >= 0 && b > a) tries.push(raw.slice(a, b + 1));
  const c = raw.indexOf('['), d = raw.lastIndexOf(']');
  if (c >= 0 && d > c) tries.push(raw.slice(c, d + 1));
  for (const t of tries) {
    if (!t) continue;
    try { return JSON.parse(t) as unknown; } catch { /* the next shape */ }
  }
  throw new ImportError('This doesn’t look like an answer to the import prompt: there is no JSON in it. Send the prompt again and choose the file it gives you.');
}

function readBot(v: unknown, at: number, notes: string[]): ImportBot | null {
  const o = obj(v);
  if (!o) return null;
  const name = line(pick(o, 'name', 'title'), IMPORT_NAME_MAX);
  if (!name) { notes.push(`Bot ${at + 1} has no name, so it was left out.`); return null; }
  const fullInstructions = text(pick(o, 'instructions', 'system_prompt', 'systemPrompt', 'prompt', 'personality', 'persona'), IMPORT_INSTRUCTIONS_MAX + 1);
  if (fullInstructions.length > IMPORT_INSTRUCTIONS_MAX) notes.push(`${name}: its instructions were longer than ${IMPORT_INSTRUCTIONS_MAX.toLocaleString('en-US')} characters and were cut there.`);

  const rawMemory = pick(o, 'memory', 'memories', 'facts');
  const facts = (typeof rawMemory === 'string' ? rawMemory.split('\n') : list(rawMemory))
    .map((f) => line(obj(f) ? pick(obj(f)!, 'text', 'fact', 'content') : f, IMPORT_FACT_MAX).replace(/^[-*•]\s+/, ''))
    .filter((f) => f && f !== '[left out]');
  const memory = [...new Set(facts)];
  if (memory.length > IMPORT_MEMORY_MAX) notes.push(`${name}: only the first ${IMPORT_MEMORY_MAX} of ${memory.length} memories were kept.`);

  const routines: ImportRoutine[] = [];
  for (const r of list(pick(o, 'routines', 'schedules', 'scheduled_tasks', 'tasks', 'cron'))) {
    const ro = obj(r);
    if (!ro) continue;
    const prompt = text(pick(ro, 'prompt', 'task', 'instructions', 'description'), 4000);
    const rname = line(pick(ro, 'name', 'title'), 80) || prompt.split('\n')[0]!.slice(0, 60);
    if (!prompt) continue;
    const schedule = plainCron(pick(ro, 'cron', 'schedule'));
    const when = line(pick(ro, 'when', 'schedule_words', 'frequency'), 120);
    if (!schedule) { notes.push(`${name}: the routine “${rname}” has no schedule AppuBot could read${when ? ` (“${when}”)` : ''}, so it was left out. You can add it by hand.`); continue; }
    routines.push({ name: rname, prompt, schedule, when });
  }
  if (routines.length > IMPORT_ROUTINES_MAX) notes.push(`${name}: only the first ${IMPORT_ROUTINES_MAX} routines were kept.`);

  const skills: ImportSkill[] = [];
  for (const s of list(pick(o, 'skills', 'workflows', 'playbooks'))) {
    const so = obj(s);
    if (!so) continue;
    const sname = line(pick(so, 'name', 'title'), 64);
    const body = text(pick(so, 'steps', 'body', 'instructions', 'content'), IMPORT_SKILL_BODY_MAX);
    if (!sname || !body) continue;
    skills.push({ name: sname, description: line(pick(so, 'description', 'summary'), 300), body });
  }
  if (skills.length > IMPORT_SKILLS_MAX) notes.push(`${name}: only the first ${IMPORT_SKILLS_MAX} skills were kept.`);

  return {
    name,
    job: line(pick(o, 'job', 'role', 'description', 'purpose'), IMPORT_JOB_MAX),
    instructions: fullInstructions.slice(0, IMPORT_INSTRUCTIONS_MAX),
    memory: memory.slice(0, IMPORT_MEMORY_MAX),
    routines: routines.slice(0, IMPORT_ROUTINES_MAX),
    skills: skills.slice(0, IMPORT_SKILLS_MAX),
  };
}

/** Reads an answer to the import prompt (a file's text, or the answer pasted whole). Throws `ImportError` in plain words. */
export function parseImport(raw: string): ImportFile {
  if (!raw.trim()) throw new ImportError('The file is empty.');
  if (raw.length > IMPORT_TEXT_MAX) throw new ImportError('That file is too large to be an answer to the import prompt.');
  const data = jsonIn(raw);
  const top = obj(data);
  // the document, a bare list of bots, or one bot on its own
  const rawBots = Array.isArray(data) ? data : top ? (Array.isArray(top.bots) ? top.bots : Array.isArray(top.agents) ? top.agents : top.name ? [top] : []) : [];
  const notes: string[] = [];
  const bots: ImportBot[] = [];
  rawBots.forEach((b, i) => {
    if (bots.length >= IMPORT_BOTS_MAX) return;
    const bot = readBot(b, i, notes);
    if (bot) bots.push(bot);
  });
  if (rawBots.length > IMPORT_BOTS_MAX) notes.push(`Only the first ${IMPORT_BOTS_MAX} of ${rawBots.length} bots were read.`);
  if (!bots.length) throw new ImportError('There are no bots in this file. Send the prompt again and choose the file it gives you.');
  return { from: top ? line(top.from, 60) : '', bots, notes };
}

/** A name for an imported bot that no bot here has yet: "Ada", else "Ada (imported)", "Ada (imported 2)"… */
export function importName(name: string, taken: string[]): string {
  const has = (n: string) => taken.some((t) => t.trim().toLowerCase() === n.toLowerCase());
  if (!has(name)) return name;
  for (let i = 1; i < 50; i++) {
    const n = `${name} (${i === 1 ? 'imported' : `imported ${i}`})`;
    if (!has(n)) return n;
  }
  return `${name} (imported ${Date.now() % 1000})`;
}

/** The imported facts as a MEMORY.md of our own (dated entries, repeats dropped); '' when there are none. */
export function importMemoryText(botName: string, facts: string[], day: string): string {
  if (!facts.length) return '';
  let memory = memoryTemplate(botName);
  for (const f of facts) memory = appendMemory(memory, f, day).memory;
  return memory;
}

/** What a bot brings, in a few words: "12 memories · 2 routines · 1 skill" ('' for nothing but its setup). */
export function importSummary(bot: ImportBot): string {
  const n = (count: number, one: string, many: string) => (count ? `${count} ${count === 1 ? one : many}` : '');
  return [n(bot.memory.length, 'memory', 'memories'), n(bot.routines.length, 'routine', 'routines'), n(bot.skills.length, 'skill', 'skills')].filter(Boolean).join(' · ');
}
