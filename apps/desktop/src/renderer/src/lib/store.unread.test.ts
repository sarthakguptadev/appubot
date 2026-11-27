import { beforeEach, describe, expect, it } from 'vitest';
import { getState, setState, ui } from './store';

beforeEach(() => setState({ unread: {} }));

describe('unread marks', () => {
  it('keep the first reply you have not seen, where the chat\'s NEW line goes', () => {
    ui.markUnread('t1', 'm1');
    ui.markUnread('t1', 'm2');
    expect(getState().unread.t1).toBe('m1');
    ui.markRead('t1');
    expect(getState().unread.t1).toBeUndefined();
    ui.markUnread('t1', 'm3');
    expect(getState().unread.t1).toBe('m3');
  });

  it('still mark a thread unread with no reply to point at', () => {
    ui.markUnread('t2');
    expect(getState().unread.t2).toBe(true);
  });
});
