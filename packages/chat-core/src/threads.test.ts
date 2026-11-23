import { describe, expect, it } from 'vitest';
import { chatsToPrefetch } from './threads';

type T = Parameters<typeof chatsToPrefetch>[0][number];
const t = (id: string, botId: string, at: number, extra: Partial<T> = {}): T => ({ id, botId, source: 'desktop', createdAt: at, lastActiveAt: at, lastMessagePreview: 'hi', ...extra });

describe('chatsToPrefetch', () => {
  it('takes each bot’s current chat, most recently active first', () => {
    const threads = [t('a1', 'a', 10), t('a2', 'a', 30), t('b1', 'b', 20), t('c1', 'c', 5)];
    expect(chatsToPrefetch(threads, () => false)).toEqual(['a2', 'b1', 'c1']);
  });
  it('leaves out empty chats, ones made here, ones already loaded and old Telegram ones', () => {
    const threads = [
      t('a1', 'a', 10, { lastMessagePreview: '' }),
      t('local:x', 'b', 20),
      t('c1', 'c', 30),
      t('d1', 'd', 40),
      t('tg', 'e', 50, { source: 'channel' }),
    ];
    expect(chatsToPrefetch(threads, (id) => id === 'd1')).toEqual(['c1']);
  });
  it('stops at n', () => {
    const threads = Array.from({ length: 12 }, (_, i) => t(`t${i}`, `b${i}`, i));
    expect(chatsToPrefetch(threads, () => false, 3)).toEqual(['t11', 't10', 't9']);
  });
});
