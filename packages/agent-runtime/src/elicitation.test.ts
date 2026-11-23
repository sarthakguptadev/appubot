import { describe, expect, it } from 'vitest';
import { elicitationContent, elicitationFields } from './elicitation';

// the schema OpenCode 2.0.22 sends for its `question` tool (two questions, the first taking several answers)
const OPENCODE = {
  type: 'object',
  properties: {
    q0: { type: 'array', title: 'Fruits', description: 'Which fruits do you like?', items: { anyOf: [{ const: 'apple', title: 'Apple', description: 'Crisp' }, { const: 'banana', title: 'Banana' }] } },
    q0_custom: { type: 'string', title: 'Fruits (other)', description: 'Add your own answer' },
    q1: { type: 'string', title: 'Season', description: 'Which season do you like best?', oneOf: [{ const: 'summer', title: 'Summer' }, { const: 'winter', title: 'Winter' }] },
    q1_custom: { type: 'string', title: 'Season (other)', description: 'Type your own answer' },
  },
  required: [],
};

describe('an agent’s own form (ACP elicitation)', () => {
  it('reads the fields a schema asks for, in order', () => {
    const fields = elicitationFields(OPENCODE);
    expect(fields.map((f) => [f.id, f.kind, f.options.map((o) => o.value)])).toEqual([
      ['q0', 'multichoice', ['apple', 'banana']], ['q0_custom', 'text', []], ['q1', 'choice', ['summer', 'winter']], ['q1_custom', 'text', []],
    ]);
    expect(fields[0]).toMatchObject({ title: 'Fruits', description: 'Which fruits do you like?', required: false });
    expect(fields[0]!.options[0]).toEqual({ value: 'apple', title: 'Apple', description: 'Crisp' });
  });

  it('reads every plain kind, what is required and what a field starts with; a kind it doesn’t know is asked as text', () => {
    const fields = elicitationFields({
      properties: {
        name: { type: 'string', title: 'Name', default: 'Ada' },
        mail: { type: 'string', format: 'email' },
        size: { type: 'string', enum: ['s', 'm'] },
        count: { type: 'integer', default: 3 },
        ratio: { type: 'number' },
        ok: { type: 'boolean', default: true },
        tags: { type: 'array', items: { type: 'string', enum: ['a', 'b'] }, default: ['b'] },
        odd: { type: '_future' },
        junk: 7,
      },
      required: ['name', 'count'],
    });
    expect(fields.map((f) => [f.id, f.kind, f.required])).toEqual([
      ['name', 'text', true], ['mail', 'text', false], ['size', 'choice', false], ['count', 'number', true], ['ratio', 'number', false], ['ok', 'toggle', false], ['tags', 'multichoice', false], ['odd', 'text', false],
    ]);
    expect(fields[0]!.default).toBe('Ada');
    expect(fields[1]!.format).toBe('email');
    expect(fields[2]!.options).toEqual([{ value: 's', title: 's' }, { value: 'm', title: 'm' }]);
    expect(fields[3]).toMatchObject({ integer: true, default: 3 });
    expect(fields[5]!.default).toBe(true);
    expect(fields[6]!.default).toEqual(['b']);
    expect(elicitationFields(null)).toEqual([]);
    expect(elicitationFields({ properties: {} })).toEqual([]);
  });

  it('puts an answer back in the schema’s own types, and leaves out what doesn’t fit', () => {
    const fields = elicitationFields({
      properties: {
        pick: { type: 'string', oneOf: [{ const: 'a1', title: 'Apple' }, { const: 'b1', title: 'Banana' }] },
        many: { type: 'array', items: { anyOf: [{ const: 'mon', title: 'Monday' }, { const: 'tue', title: 'Tuesday' }] } },
        n: { type: 'integer' },
        x: { type: 'number' },
        on: { type: 'boolean' },
        note: { type: 'string' },
      },
    });
    // a choice by its value or by the title a person saw; numbers from text; a toggle from its words
    expect(elicitationContent(fields, { pick: 'banana', many: ['Monday', 'tue', 'nope'], n: '4.6', x: '2.5', on: 'true', note: ' hi ', extra: 'x' }))
      .toEqual({ pick: 'b1', many: ['mon', 'tue'], n: 5, x: 2.5, on: true, note: ' hi ' });
    expect(elicitationContent(fields, { pick: 'cherry', n: 'many', on: 'maybe', note: '  ' })).toEqual({});
    expect(elicitationContent(fields, { many: [] })).toEqual({ many: [] });
    expect(elicitationContent(fields, {})).toEqual({});
  });
});
