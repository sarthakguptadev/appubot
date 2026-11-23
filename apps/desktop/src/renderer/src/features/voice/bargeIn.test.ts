import { describe, expect, it } from 'vitest';
import {
  BARGE_IN_LEVEL, BARGE_IN_MAX, ECHO_WINDOW_MS, EchoMeter, VERIFY_AFTER_MS, VERIFY_MAX_MS, VERIFY_PRE_MS, VERIFY_RETRY_MS,
  VoiceLevel, bargeInLevel, isNoise, novelty, ownWords, speechWords, verifyCutIn, type CutInChecker,
} from './bargeIn';

const BOT = 'I’m doing well, thanks for asking! How can I help you today?';
const own = (heard: string, read = BOT) => ownWords(novelty(heard, read));

describe('the level a cut-in needs', () => {
  it('stands clearly above the echo of what plays, within bounds', () => {
    expect(bargeInLevel(0)).toBe(BARGE_IN_LEVEL);
    expect(bargeInLevel(0.3)).toBe(BARGE_IN_LEVEL);
    expect(bargeInLevel(0.5)).toBeCloseTo(0.55);
    expect(bargeInLevel(0.7)).toBeCloseTo(0.71);
    // never out of reach: a loud voice still cuts in on a loud reading
    expect(bargeInLevel(1)).toBe(BARGE_IN_MAX);
  });

  it('takes the output’s loudest of the last moment', () => {
    const m = new EchoMeter();
    expect(m.note(0.6, 0)).toBe(0.6);
    expect(m.note(0.1, 100)).toBe(0.6);
    expect(m.note(0.2, ECHO_WINDOW_MS)).toBe(0.6);
    expect(m.note(0.2, ECHO_WINDOW_MS + 1)).toBe(0.2);
    m.reset();
    expect(m.note(0, 1000)).toBe(0);
  });
});

describe('novelty', () => {
  it('reads words the way a speech model writes them', () => {
    expect(speechWords('I’m here — “really”, 3.50!')).toEqual(['i', 'am', 'here', 'really', '3', '50']);
    expect(speechWords("Don't, it's fine")).toEqual(['do', 'not', 'its', 'fine']);
    expect(speechWords('  ')).toEqual([]);
  });

  it('takes the bot’s own sentence coming back as echo, misheard or not', () => {
    expect(own('How can I help you today?')).toBe(false);
    expect(own('thanks for asking how can I help you to day')).toBe(false);
    expect(own('I am doing well thanks for asking')).toBe(false);
    // a word or two misheard in a longer stretch
    expect(own('Im doing good thanks for askin how can I help you today')).toBe(false);
    // from the part before as well
    expect(own('is Canberra, a planned city. I am doing', 'The capital of Australia is Canberra, a planned city. ' + BOT)).toBe(false);
  });

  it('counts the user’s own words, even in a language the model writes as nonsense', () => {
    expect(own('Stop.')).toBe(true);
    expect(own('No wait, I meant Austria')).toBe(true);
    expect(own('That’s what Kabala Nikon me. That’s what')).toBe(true);
    // the bot's words in another order, with words of the user's own
    expect(own('Canberra is the capital of Australia, right? So what is its population?', 'The capital of Australia is Canberra.')).toBe(true);
  });

  it('a filler alone is no words', () => {
    expect(novelty('Mm-hmm. Uh.', BOT)).toEqual({ words: 0, novel: 0 });
    expect(own('Hmm.')).toBe(false);
    expect(own('Um, stop')).toBe(true);
  });

  it('knows what a speech model writes for noise', () => {
    expect(isNoise('Thank you.')).toBe(true);
    expect(isNoise(' you ')).toBe(true);
    expect(isNoise('Thank you, that’s enough')).toBe(false);
  });
});

/** a fake checker: `heard` answers each hearing in turn; `loud` says whether the user still talks */
function checker(o: { heard: (string | Error)[]; loud?: boolean; read?: string; liveFor?: number }) {
  let t = 0;
  let live = 0;
  const asked: number[] = [];
  const answers = [...o.heard];
  const c: CutInChecker = {
    audio: async (ms) => { asked.push(ms); return new Int16Array(Math.round(ms * 16)); },
    hear: async () => {
      const a = answers.shift() ?? '';
      if (a instanceof Error) throw a;
      return a;
    },
    read: () => o.read ?? BOT,
    loud: () => o.loud ?? false,
    live: () => o.liveFor === undefined || live++ < o.liveFor,
    sleep: async (ms) => { t += ms; },
    now: () => t,
  };
  return { c, asked };
}

describe('verifyCutIn', () => {
  it('cuts the reading for words of the user’s own', async () => {
    const { c, asked } = checker({ heard: ['Wait, stop.'] });
    const v = await verifyCutIn(560, c);
    expect(v).toMatchObject({ cut: true, text: 'Wait, stop.', tries: 1, novelty: { words: 2, novel: 2 } });
    // the loud run, what came before it, and the ducked moment since
    expect(asked).toEqual([560 + VERIFY_PRE_MS + VERIFY_AFTER_MS]);
  });

  it('lets the reading go on for its own echo, nothing, a filler or noise', async () => {
    expect(await verifyCutIn(560, checker({ heard: ['How can I help you today?'] }).c)).toMatchObject({ cut: false, reason: 'the bot’s own words' });
    expect(await verifyCutIn(560, checker({ heard: [''] }).c)).toMatchObject({ cut: false, reason: 'nothing heard', tries: 1 });
    expect(await verifyCutIn(560, checker({ heard: ['Mm.'] }).c)).toMatchObject({ cut: false, reason: 'only a filler' });
    expect(await verifyCutIn(560, checker({ heard: ['Thank you.'] }).c)).toMatchObject({ cut: false, reason: 'noise' });
  });

  it('hears once more, with more audio, when nothing was heard while the user still talks', async () => {
    const { c, asked } = checker({ heard: ['', 'Hold on a second'], loud: true });
    const v = await verifyCutIn(560, c);
    expect(v).toMatchObject({ cut: true, tries: 2 });
    expect(asked).toEqual([560 + VERIFY_PRE_MS + VERIFY_AFTER_MS, 560 + VERIFY_PRE_MS + VERIFY_AFTER_MS + VERIFY_RETRY_MS]);
    // never more than twice
    const twice = checker({ heard: ['', '', 'late'], loud: true });
    expect(await verifyCutIn(560, twice.c)).toMatchObject({ cut: false, reason: 'nothing heard', tries: 2 });
    expect(twice.asked).toHaveLength(2);
  });

  it('never hears more than the most a check takes', async () => {
    const { c, asked } = checker({ heard: ['Stop'] });
    await verifyCutIn(5000, c);
    expect(asked).toEqual([VERIFY_MAX_MS]);
  });

  it('lets the reading go on when the words can’t be heard', async () => {
    const v = await verifyCutIn(560, checker({ heard: [new Error('host exited')] }).c);
    expect(v).toMatchObject({ cut: false, reason: 'couldn’t hear it (host exited)' });
  });

  it('says nothing once the check stopped mattering', async () => {
    expect(await verifyCutIn(560, checker({ heard: ['Stop'], liveFor: 0 }).c)).toBeNull();
    expect(await verifyCutIn(560, checker({ heard: ['Stop'], liveFor: 1 }).c)).toBeNull();
  });
});

describe('VoiceLevel', () => {
  it('learns the median of each turn’s loud p75, ignoring turns too short to tell', () => {
    const v = new VoiceLevel();
    expect(v.db).toBeNull();
    v.learn([-30, -30]);
    expect(v.db).toBeNull();
    v.learn([-40, -30, -28, -26, -50]);
    expect(v.db).toBe(-28);
    v.learn([-20, -20, -20, -20]);
    v.learn([-35, -35, -35, -35]);
    expect(v.db).toBe(-28);
  });
});
