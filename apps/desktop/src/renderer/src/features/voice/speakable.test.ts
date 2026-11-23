import { describe, expect, it } from 'vitest';
import { FIRST_CLAUSE_MIN, speakableEnd, speakablePiece } from './speakable';

const upTo = (md: string, from = 0, final = false) => md.slice(from, speakableEnd(md, from, final));

describe('speakableEnd', () => {
  it('reads up to the last sentence end of the line being written', () => {
    expect(upTo('Hello there. How are')).toBe('Hello there.');
    expect(upTo('Hello there. How are you? I', 12)).toBe(' How are you?');
    expect(upTo('Wait… what')).toBe('Wait…');
  });

  it('reads a finished line whole, punctuation or not', () => {
    expect(upTo('## Summary\nThe first')).toBe('## Summary\n');
    expect(upTo('- one\n- two\n- thr')).toBe('- one\n- two\n');
  });

  it('waits for nothing once the reply is complete', () => {
    expect(upTo('No full stop at the end', 0, true)).toBe('No full stop at the end');
    expect(speakableEnd('abc', 3, true)).toBe(3);
  });

  it('never cuts inside a code block, and cuts again after it', () => {
    const open = 'Run this:\n```sh\nnpm i. Then\n';
    expect(upTo(open)).toBe('Run this:\n');
    const closed = `${open}\`\`\`\nDone. And`;
    expect(upTo(closed, 'Run this:\n'.length)).toBe('```sh\nnpm i. Then\n```\nDone.');
  });

  it("doesn't cut at a list's number, a table row or a decimal", () => {
    expect(speakableEnd('1. First thi', 0, false)).toBe(0);
    expect(speakableEnd('| a. b | c', 0, false)).toBe(0);
    expect(upTo('It costs 3.50 now. And')).toBe('It costs 3.50 now.');
  });

  it('takes closing quotes and emphasis with the sentence', () => {
    expect(upTo('He said “yes.” Then')).toBe('He said “yes.”');
    expect(upTo('**Done.** Next')).toBe('**Done.**');
  });

  it('cuts after CJK sentence ends without a space', () => {
    expect(upTo('你好。世界')).toBe('你好。');
  });

  it('stays put while nothing new can be read', () => {
    expect(speakableEnd('Hello there. How are', 12, false)).toBe(12);
    expect(speakableEnd('', 0, false)).toBe(0);
  });

  it('lets the first piece end at a clause break once it is long enough', () => {
    const first = (md: string) => md.slice(0, speakableEnd(md, 0, false, FIRST_CLAUSE_MIN));
    expect(first('The capital of Australia is Canberra, and about 460,000 people')).toBe('The capital of Australia is Canberra,');
    // too short yet, or a number's comma
    expect(first('Well, the capital of Australia')).toBe('');
    expect(first('There are roughly 460,000 people living in it')).toBe('');
    // a sentence's end still comes first, however short
    expect(first('Sure. The capital of Australia is Canberra, which')).toBe('Sure.');
    expect(first('Boil it for about eight to nine minutes — then taste')).toBe('Boil it for about eight to nine minutes —');
    // later pieces wait for their sentence
    expect(speakableEnd('Sure. The capital of Australia is Canberra, which', 5, false)).toBe(5);
  });
});

describe('speakablePiece', () => {
  it('reads Markdown as words and drops emphasis cut in half', () => {
    expect(speakablePiece('**Hello.')).toBe('Hello.');
    expect(speakablePiece('See [the docs](https://x.y) now.')).toBe('See the docs now.');
    expect(speakablePiece('```js\nconst a = 1;\n```\n')).toBe('');
  });
});
