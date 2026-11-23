import { describe, expect, it } from 'vitest';
import { kokoroText, numberWords, spellNumbers } from './kokoroText';

const LEXICON = new Set(['the', 'api', 'git', 'hub', 'is', 'on', 'at', 'i', 'am', 'here', 'phone', 'costs', 'dollars', 'and', 'apple']);
const known = (w: string) => LEXICON.has(w);

describe('numberWords', () => {
  it('says whole numbers', () => {
    expect(numberWords(0)).toBe('zero');
    expect(numberWords(45)).toBe('forty five');
    expect(numberWords(1250)).toBe('one thousand two hundred fifty');
    expect(numberWords(3_000_007)).toBe('three million seven');
  });
});

describe('spellNumbers', () => {
  it('reads money, times, percentages, years, ordinals and decimals as words', () => {
    expect(spellNumbers('It costs $45.')).toBe('It costs forty five dollars.');
    expect(spellNumbers('$1.50 and ₹1')).toBe('one dollar fifty and one rupee');
    expect(spellNumbers('at 3:30 PM, 9:05 or 10:00')).toBe('at three thirty p m, nine oh five or ten o\'clock');
    expect(spellNumbers('at 3pm')).toBe('at three p m');
    expect(spellNumbers('up 12.5%')).toBe('up twelve point five percent');
    expect(spellNumbers('in 2026 and 1990, 2005')).toBe('in twenty twenty six and nineteen ninety, two thousand five');
    expect(spellNumbers('the 3rd and 21st')).toBe('the third and twenty first');
    expect(spellNumbers('1,250 people')).toBe('one thousand two hundred fifty people');
    // "am" the word stays a word
    expect(spellNumbers('I am here')).toBe('I am here');
  });
});

describe('kokoroText', () => {
  it('reads words its lexicon lacks as letters or as the words they join', () => {
    expect(kokoroText('The API is on GitHub', known)).toBe('The API is on Git Hub');
    expect(kokoroText('The PDF and the PDFs', known)).toBe('The P D F and the P D F');
    // a name it doesn't know stays (Kokoro skips it)
    expect(kokoroText('Priya is here', known)).toBe('Priya is here');
    expect(kokoroText('It costs $3', known)).toBe('It costs three dollars');
  });
});
