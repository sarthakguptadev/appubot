import { describe, expect, it } from 'vitest';
import { fileKind, fileKindLabel, fileRuns, fileTitle, viewKind, VIEW_TEXT_MAX } from './fileKinds';

const f = (name: string, mimeType: string, caption?: string) => ({ name, mimeType, ...(caption ? { caption } : {}) });

describe('what a file is, in the Files tab', () => {
  it('tells a visual, a picture, a clip and sound from a document', () => {
    expect(fileKind(f('weekly-activity.html', 'text/html'))).toBe('page');
    expect(fileKind(f('shot.png', 'image/png'))).toBe('image');
    expect(fileKind(f('demo.mp4', 'video/mp4'))).toBe('video');
    expect(fileKind(f('clip.mov', 'video/quicktime'))).toBe('file');
    expect(fileKind(f('song.mp3', 'audio/mpeg'))).toBe('audio');
    expect(fileKind(f('report.pdf', 'application/pdf'))).toBe('file');
  });

  it('names a visual by its title, never by its file', () => {
    expect(fileTitle(f('weekly-activity.html', 'text/html', 'Weekly activity'))).toBe('Weekly activity');
    expect(fileTitle(f('olive-s-orbit.html', 'text/html'))).toBe('Olive s orbit');
    expect(fileTitle(f('.html', 'text/html'))).toBe('Visual');
    expect(fileTitle(f('Invoice-Acme-0042.pdf', 'application/pdf', 'For Acme'))).toBe('Invoice-Acme-0042.pdf');
  });

  it('says the kind in a word', () => {
    expect([
      f('a.html', 'text/html'), f('a.png', 'image/png'), f('a.mp4', 'video/mp4'), f('a.ogg', 'audio/ogg'), f('a.pdf', 'application/pdf'),
      f('a.xlsx', 'application/octet-stream'), f('a.zip', 'application/zip'), f('a.xyz', 'application/octet-stream'), f('noext', 'application/octet-stream'),
    ].map(fileKindLabel)).toEqual(['Visual', 'Picture', 'Video', 'Audio', 'PDF', 'Spreadsheet', 'Archive', 'XYZ', 'File']);
  });

  it('lays the list out as runs, in order: visuals share tiles, the rest are rows', () => {
    const list = [f('a.html', 'text/html'), f('b.png', 'image/png'), f('c.pdf', 'application/pdf'), f('d.mp3', 'audio/mpeg'), f('e.mp4', 'video/mp4')];
    expect(fileRuns(list).map((r) => [r.tiles, r.items.map((x) => x.name)])).toEqual([[true, ['a.html', 'b.png']], [false, ['c.pdf', 'd.mp3']], [true, ['e.mp4']]]);
    expect(fileRuns([])).toEqual([]);
  });

  it('knows what the app can show by itself, and what only its own app opens', () => {
    const v = (name: string, mimeType: string, size = 1000) => viewKind({ name, mimeType, size });
    expect([v('a.html', 'text/html'), v('a.png', 'image/png'), v('a.mp4', 'video/mp4'), v('a.mp3', 'audio/mpeg')]).toEqual(['page', 'image', 'video', 'audio']);
    expect([v('notes.md', 'text/markdown'), v('expenses.csv', 'text/csv'), v('data.json', 'application/json'), v('run.log', 'application/octet-stream'), v('readme', 'text/plain')]).toEqual(['markdown', 'table', 'text', 'text', 'text']);
    expect([v('report.pdf', 'application/pdf'), v('deck.pptx', 'application/octet-stream'), v('a.zip', 'application/zip')]).toEqual([null, null, null]);
    // a very large text file opens in its own app
    expect(v('big.log', 'text/plain', VIEW_TEXT_MAX + 1)).toBeNull();
  });
});
