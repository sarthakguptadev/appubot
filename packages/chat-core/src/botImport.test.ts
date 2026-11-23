import { describe, expect, it } from 'vitest';
import {
  IMPORT_BOTS_MAX, IMPORT_SOURCES, ImportError, importMemoryText, importName, importPrompt, importSummary, parseImport, plainCron,
} from './botImport';

const DOC = {
  format: 'appubot-import', version: 1, from: 'Grok Bot',
  bots: [{
    name: 'Ada', job: 'Keeps the books', instructions: 'Be brief.\nAsk before paying anything.',
    memory: ['Sarthak lives in Jammu.', '- Invoices are in INR.', 'Sarthak lives in Jammu.', '[left out]'],
    routines: [
      { name: 'Morning digest', prompt: 'Summarise my inbox.', cron: '0 9 * * 1-5', when: 'Weekdays at 9:00' },
      { name: 'Vague one', prompt: 'Do the thing.', when: 'now and then' },
    ],
    skills: [{ name: 'File GST', description: 'Files the return', steps: '1. Open the portal\n2. Upload' }],
  }],
};

describe('importPrompt', () => {
  it('names the product, shows the shape and asks for no secrets', () => {
    const p = importPrompt('grokbot');
    expect(p).toContain('"from": "Grok Bot"');
    expect(p).toContain('"format": "appubot-import"');
    expect(p).toMatch(/passwords, API keys/);
    expect(p).toContain('appubot-import.json');
    // every source has a prompt of its own, and an unknown one falls back to the general one
    for (const s of IMPORT_SOURCES) expect(importPrompt(s.id)).toContain(s.hint);
    expect(importPrompt('nope')).toContain(IMPORT_SOURCES[0]!.hint);
  });
});

describe('parseImport', () => {
  it('reads the document: tidy text, memories deduplicated, a routine with no cron left out with a note', () => {
    const f = parseImport(JSON.stringify(DOC));
    expect(f.from).toBe('Grok Bot');
    expect(f.bots).toHaveLength(1);
    const ada = f.bots[0]!;
    expect(ada.name).toBe('Ada');
    expect(ada.instructions).toBe('Be brief.\nAsk before paying anything.');
    expect(ada.memory).toEqual(['Sarthak lives in Jammu.', 'Invoices are in INR.']);
    expect(ada.routines).toEqual([{ name: 'Morning digest', prompt: 'Summarise my inbox.', schedule: '0 9 * * 1-5', when: 'Weekdays at 9:00' }]);
    expect(ada.skills).toEqual([{ name: 'File GST', description: 'Files the return', body: '1. Open the portal\n2. Upload' }]);
    expect(f.notes.join(' ')).toMatch(/Vague one.*left out/);
    expect(importSummary(ada)).toBe('2 memories · 1 routine · 1 skill');
  });

  it('finds the JSON inside a chatty answer, a code block, a bare list or one bot', () => {
    const fenced = `Here you go!\n\n\`\`\`json\n${JSON.stringify(DOC, null, 2)}\n\`\`\`\nAnything else?`;
    expect(parseImport(fenced).bots[0]!.name).toBe('Ada');
    expect(parseImport(`Sure: ${JSON.stringify(DOC)} Done.`).bots[0]!.name).toBe('Ada');
    expect(parseImport(JSON.stringify(DOC.bots)).bots).toHaveLength(1);
    expect(parseImport(JSON.stringify({ name: 'Solo', system_prompt: 'Hi', memories: 'one\ntwo' })).bots[0]).toMatchObject({ name: 'Solo', instructions: 'Hi', memory: ['one', 'two'] });
  });

  it('reads nothing that could grant power, and takes text only', () => {
    const f = parseImport(JSON.stringify({ bots: [{ name: 'Eve', computerUse: true, modeId: 'bypassPermissions', providerId: 'x', instructions: { evil: true }, memory: [{ text: 'ok' }, 5, null, {}] }] }));
    expect(f.bots[0]).toEqual({ name: 'Eve', job: '', instructions: '', memory: ['ok', '5'], routines: [], skills: [] });
  });

  it('says in words what is wrong with a file', () => {
    expect(() => parseImport('   ')).toThrow(ImportError);
    expect(() => parseImport('I can’t do that, sorry.')).toThrow(/no JSON/);
    expect(() => parseImport('{"bots": []}')).toThrow(/no bots/);
    expect(() => parseImport(JSON.stringify({ bots: [{ job: 'nameless' }] }))).toThrow(/no bots/);
  });

  it('caps how much it takes', () => {
    const many = { bots: Array.from({ length: IMPORT_BOTS_MAX + 5 }, (_, i) => ({ name: `B${i}` })) };
    const f = parseImport(JSON.stringify(many));
    expect(f.bots).toHaveLength(IMPORT_BOTS_MAX);
    expect(f.notes.join(' ')).toMatch(/Only the first/);
    const long = parseImport(JSON.stringify({ bots: [{ name: 'L', instructions: 'x'.repeat(9000) }] }));
    expect(long.bots[0]!.instructions).toHaveLength(8000);
    expect(long.notes.join(' ')).toMatch(/cut/);
  });
});

describe('plainCron', () => {
  it('takes five plain fields and nothing else', () => {
    expect(plainCron('0 9 * * 1-5')).toBe('0 9 * * 1-5');
    expect(plainCron(' */15  *  * * * ')).toBe('*/15 * * * *');
    expect(plainCron('0 9,18 1 */2 0')).toBe('0 9,18 1 */2 0');
    expect(plainCron('@daily')).toBe('');
    expect(plainCron('0 9 * * MON')).toBe('');
    expect(plainCron('0 9 * *')).toBe('');
    expect(plainCron('0 9 * * 1; rm -rf /')).toBe('');
  });
});

describe('names and memory', () => {
  it('keeps a free name and marks a taken one', () => {
    expect(importName('Ada', ['Bo'])).toBe('Ada');
    expect(importName('Ada', ['ada'])).toBe('Ada (imported)');
    expect(importName('Ada', ['Ada', 'Ada (imported)'])).toBe('Ada (imported 2)');
  });

  it('writes the facts as dated memory entries, once each', () => {
    expect(importMemoryText('Ada', [], '2026-11-14')).toBe('');
    const m = importMemoryText('Ada', ['Lives in Jammu.', 'Lives in Jammu.', 'Likes short answers.'], '2026-11-14');
    expect(m).toContain('[2026-11-14] Lives in Jammu.');
    expect(m.match(/Lives in Jammu/g)).toHaveLength(1);
    expect(m).toContain('Likes short answers.');
  });
});
