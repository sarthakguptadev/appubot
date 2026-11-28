/**
 * The bot at work on the computer says nothing over the composer (the owner, 2026-11-28: "no need for this pill rm it"):
 * no "is using" line and no Watch button there. Watching stays in the side panel's Computer tab.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { SettingsSchema, type Bot, type ComputerStatus, type Thread } from '@appubot/protocol';

// the speech models' download is a store of its own, read with useSyncExternalStore (none here)
vi.mock('../voice/DownloadNotice', () => ({ useVoiceDownload: () => null, VoiceDownloadNotice: () => null }));
// the chat's own parts render elsewhere; the composer stands in as a plain box
vi.mock('./Transcript', () => ({ Transcript: () => null }));
vi.mock('./ChatHeader', () => ({ ChatHeader: () => null }));
vi.mock('./EmptyThread', () => ({ EmptyThread: () => null }));
vi.mock('./ThreadSearch', () => ({ ThreadSearch: () => null }));
vi.mock('./QuoteSelection', () => ({ QuoteSelection: () => null }));
vi.mock('./Composer', async () => { const { createElement: h } = await import('react'); return { Composer: () => h('textarea') }; });
// a server render reads a store's first state: read this one as the test sets it
vi.mock('../../lib/store', async (orig) => {
  const real = await orig<typeof import('../../lib/store')>();
  const useStore = Object.assign(<T,>(sel: (s: ReturnType<typeof real.getState>) => T): T => sel(real.getState()), real.useStore);
  return { ...real, useStore };
});

describe('the chat while its bot uses the computer', async () => {
  beforeAll(() => { (globalThis as { window?: unknown }).window ??= { addEventListener() {}, removeEventListener() {}, innerWidth: 1280 }; });
  const { setState } = await import('../../lib/store');
  const { ThreadView } = await import('./ThreadView');
  const thread: Thread = {
    id: 't1', botId: 'b1', title: 'Chat', providerId: 'claude-code', cwd: '/x', status: 'running', modes: [], models: [], efforts: [], fastAvailable: false, fast: false,
    commands: [], source: 'desktop', lastMessagePreview: '', createdAt: 1, updatedAt: 1,
  };
  const bot = { id: 'b1', name: 'Echo', shape: 'circle', color: '#4C8DFF', pinned: false, computerUse: true } as unknown as Bot;

  it.each([
    ['on screen', { busy: true, activeThreadId: 't1' }],
    ['waiting for the screen', { busy: true, waits: [{ threadId: 't1', for: 'turn', since: 1 }] }],
    ['on a bot screen of its own', { busy: true, screens: [{ botId: 'b1', activeThreadId: 't1' }] }],
  ])('shows no line over the composer (%s)', (_, computer) => {
    setState({
      bots: [bot], threads: [thread], selectedBotId: 'b1', selectedThreadId: 't1', selectedGroupId: null,
      settings: SettingsSchema.parse({ onboarded: true, computer: { enabled: true } }),
      computer: computer as unknown as ComputerStatus, lastAction: { threadId: 't1', action: { kind: 'click', app: 'Google-chrome' } } as never,
    });
    const html = renderToStaticMarkup(createElement(ThreadView));
    expect(html).toContain('textarea');
    expect(html).not.toMatch(/is using|Watch|Work in background|in front for a moment/);
  });
});
