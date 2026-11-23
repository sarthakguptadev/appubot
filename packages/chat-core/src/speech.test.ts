import { describe, expect, it } from 'vitest';
import { speechChunks, speechLanguage, speechText, SPEECH_FIRST_PART_MAX, SPEECH_FIRST_PART_MIN, SPEECH_PART_MAX } from './speech';

describe('speechText', () => {
  it('is empty for empty input', () => {
    expect(speechText('')).toBe('');
    expect(speechText('  \n\n ')).toBe('');
  });
  it('drops fenced code, even unterminated', () => {
    expect(speechText('Run this:\n```sh\nrm -rf x\n```\nDone')).toBe('Run this: Done.');
    expect(speechText('~~~\ncode\n~~~\nafter')).toBe('after.');
    expect(speechText('Before\n```js\nnever closed\nmore')).toBe('Before.');
  });
  it('drops tables, rules, html, images and bare urls', () => {
    expect(speechText('| a | b |\n|---|---|\n| 1 | 2 |\nAfter')).toBe('After.');
    expect(speechText('One\n---\nTwo\n***')).toBe('One. Two.');
    expect(speechText('Hi <b>there</b> <br/>friend')).toBe('Hi there friend.');
    expect(speechText('Look ![a cat](http://x.io/c.png) here')).toBe('Look here.');
    expect(speechText('See https://example.com/a?b=1 now')).toBe('See now.');
  });
  it('reads a link as its text', () => {
    expect(speechText('Open [the docs](https://x.io/docs) please.')).toBe('Open the docs please.');
  });
  it('strips line-start markers', () => {
    expect(speechText('# Title\n> quoted\n- one\n* two\n+ three\n1. four\n2) five')).toBe('Title. quoted. one. two. three. four. five.');
  });
  it('strips emphasis only around spans', () => {
    expect(speechText('This is **bold**, __also__, ~~gone~~, *em* and _it_.')).toBe('This is bold, also, gone, em and it.');
    expect(speechText('call snake_case_name now')).toBe('call snake_case_name now.');
    expect(speechText('2 * 3 * 4')).toBe('2 * 3 * 4.');
  });
  it('reads inline code and mentions', () => {
    expect(speechText('Run `pnpm test` and ask @sarthak')).toBe('Run pnpm test and ask sarthak.');
    expect(speechText('mail me at a@b.com')).toBe('mail me at a@b.com.');
  });
  it('ends each line as a sentence', () => {
    expect(speechText('Hello\nIs it?\nWait:\nok…\n日本語。')).toBe('Hello. Is it? Wait: ok… 日本語。');
    expect(speechText('a,\n\n\nb;')).toBe('a, b;');
  });
});

describe('speechChunks', () => {
  it('is empty for blank text', () => {
    expect(speechChunks('')).toEqual([]);
    expect(speechChunks('   ')).toEqual([]);
  });
  it('keeps a short text whole', () => {
    expect(speechChunks('Hello there.')).toEqual(['Hello there.']);
  });
  it('flushes the first part once it has 40 characters', () => {
    const s1 = 'This first sentence is a bit short.';
    const s2 = 'This second one adds enough to pass forty.';
    const s3 = 'Then a third sentence follows afterwards.';
    const parts = speechChunks(`${s1} ${s2} ${s3}`);
    expect(parts[0]).toBe(`${s1} ${s2}`);
    expect(parts[0]!.length).toBeGreaterThanOrEqual(SPEECH_FIRST_PART_MIN);
    expect(parts[1]).toBe(s3);
  });
  it('never lets the first part pass 80 characters', () => {
    const s = 'Short one here. Another short one here. And one more that goes a bit longer than before. Tail.';
    for (const p of speechChunks(s)) expect(p.length).toBeLessThanOrEqual(400);
    expect(speechChunks(s)[0]!.length).toBeLessThanOrEqual(SPEECH_FIRST_PART_MAX);
  });
  it('grows later parts by three times the previous, capped', () => {
    const sentence = 'Word word word word word word word word word word word word. '; // 61 chars
    const parts = speechChunks(sentence.repeat(60));
    expect(parts[0]!.length).toBeLessThanOrEqual(80);
    expect(parts[1]!.length).toBeLessThanOrEqual(Math.max(80, parts[0]!.length * 3));
    for (let i = 1; i < parts.length; i++) {
      expect(parts[i]!.length).toBeLessThanOrEqual(Math.min(SPEECH_PART_MAX, Math.max(80, parts[i - 1]!.length * 3)));
    }
    expect(parts.some((p) => p.length > 300)).toBe(true);
  });
  it('splits a long sentence at a comma past half the limit', () => {
    const a = 'a'.repeat(30);
    const long = `${a} ${a}, ${'b'.repeat(40)} ${'c'.repeat(30)}`;
    const parts = speechChunks(long);
    expect(parts[0]).toBe(`${a} ${a},`);
    expect(parts.join(' ')).toBe(long);
  });
  it('reads a sentence with no clause to cut at whole', () => {
    const plain = 'The capital of France is Paris and it is also the largest city in the whole world.';
    expect(plain.length).toBeGreaterThan(SPEECH_FIRST_PART_MAX);
    expect(speechChunks(plain)).toEqual([plain]);
    expect(speechChunks(`Sure. ${plain}`, 'en', { after: 10 })).toEqual(['Sure.', plain]);
  });
  it('cuts at the first clause end past the limit when none fits it', () => {
    const s = "You're speaking out loud, and something on your end turns your speech into text that gets handed to me, then turns my written reply back into audio you hear.";
    expect(speechChunks(s)).toEqual([
      "You're speaking out loud, and something on your end turns your speech into text that gets handed to me,",
      'then turns my written reply back into audio you hear.',
    ]);
  });
  it('leaves no few words behind a cut', () => {
    const s = `${'word '.repeat(14)}word, and more, yes.`;
    expect(speechChunks(s)).toEqual([`${'word '.repeat(14)}word,`, 'and more, yes.']);
    const t = `${'word '.repeat(18)}word, yes.`;
    expect(speechChunks(t)).toEqual([t]);
  });
  it('cuts only a sentence over the largest part at a space, then hard', () => {
    const spaced = speechChunks(`${'word '.repeat(40)}end`);
    expect(spaced).toEqual([`${'word '.repeat(40)}end`]);
    const long = speechChunks(`${'word '.repeat(120)}end`);
    expect(long[0]!.length).toBeLessThanOrEqual(SPEECH_PART_MAX);
    expect(long[0]!.endsWith('word')).toBe(true);
    expect(long.join(' ')).toBe(`${'word '.repeat(120)}end`);
    const hard = speechChunks('x'.repeat(2500));
    expect(hard[0]).toHaveLength(SPEECH_PART_MAX);
    expect(hard.join('')).toBe('x'.repeat(2500));
  });
  it('gives whole sentences, as large as parts may be, to a reader nothing waits on', () => {
    const a = 'This first sentence is a bit short.';
    const b = 'The capital of France is Paris and it is also the largest city in the whole world.';
    expect(speechChunks(`${a} ${b}`, 'en', { after: Infinity })).toEqual([`${a} ${b}`]);
    for (const p of speechChunks(`${b} `.repeat(30), 'en', { after: Infinity })) {
      expect(p.length).toBeLessThanOrEqual(SPEECH_PART_MAX);
      expect(p.endsWith('world.')).toBe(true);
    }
  });
  it('follows on from the part before a streaming reply\'s next words', () => {
    const b = 'The capital of France is Paris and it is also the largest city in the whole world.';
    // after a short part, two sentences that fit three times its length go as one
    expect(speechChunks(`${b} Really.`, 'en', { after: 40 })).toEqual([`${b} Really.`]);
    expect(speechChunks(`${b} ${b}`, 'en', { after: 40 })).toEqual([b, b]);
  });
  it('splits a Japanese sentence at 、', () => {
    const jp = `${'あ'.repeat(50)}、${'い'.repeat(60)}`;
    const parts = speechChunks(jp, 'ja');
    expect(parts[0]).toBe(`${'あ'.repeat(50)}、`);
  });
  it('caps every part at 1000 and trims', () => {
    const parts = speechChunks(`${'y'.repeat(5000)}. ${'Hello world. '.repeat(500)}`);
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(1000);
      expect(p).toBe(p.trim());
      expect(p).not.toBe('');
    }
  });
});

describe('speechLanguage', () => {
  const cases: [string, string, string][] = [
    ['English', 'The documents are ready and I have sent them to you.', 'en'],
    ['English with a stray accent', 'Here is the résumé that you asked for, and it is ready for the review.', 'en'],
    ['Hindi', 'नमस्ते, आपके दस्तावेज़ तैयार हैं', 'hi'],
    ['Spanish', '¿Qué tal? Los documentos están listos', 'es'],
    ['French', 'Les documents sont prêts et je vous les envoie avec plaisir', 'fr'],
    ['German', 'Die Dokumente sind bereit und ich habe sie für dich geprüft, schön', 'de'],
    ['Portuguese', 'Os documentos estão prontos, não é?', 'pt'],
    ['Russian', 'Привет, документы готовы и отправлены', 'ru'],
    ['Ukrainian', 'Привіт, документи готові і надіслані', 'uk'],
    ['Bulgarian', 'Здравей, документите са готови във всичко със ъ', 'bg'],
    ['Japanese', 'こんにちは、書類の準備ができました', 'ja'],
    ['Korean', '안녕하세요, 문서가 준비되었습니다', 'ko'],
    ['Arabic', 'مرحبا، المستندات جاهزة', 'ar'],
    ['Greek', 'Γεια σου, τα έγγραφα είναι έτοιμα', 'el'],
    ['Turkish', 'Merhaba, belgeler hazır, teşekkür ederim', 'tr'],
    ['Polish', 'Dokumenty są gotowe, dziękuję bardzo', 'pl'],
    ['Vietnamese', 'Xin chào, tài liệu của bạn đã sẵn sàng', 'vi'],
    ['Czech', 'Dokumenty jsou připraveny, děkuji ř', 'cs'],
    ['Romanian', 'Documentele sunt gata și le trimit acum, mulțumesc', 'ro'],
  ];
  for (const [name, text, want] of cases) it(name, () => expect(speechLanguage(text)).toBe(want));

  it('falls back for unsupported scripts', () => {
    expect(speechLanguage('สวัสดีครับ เอกสารพร้อมแล้ว')).toBe('en');
    expect(speechLanguage('你好，文件已经准备好了', 'fr')).toBe('fr');
  });
  it('falls back when empty or unclear', () => {
    expect(speechLanguage('')).toBe('en');
    expect(speechLanguage('   123 !!', 'de')).toBe('de');
    expect(speechLanguage('xyz qrt', 'it')).toBe('it');
  });
});
