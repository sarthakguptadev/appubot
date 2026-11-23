/** The bots whose generated CLAUDE.md the fixture pins (`bots.instructions.test.ts`): every branch of the generator. */
import type { Bot } from '@appubot/protocol';

const base = {
  id: 'bot_fixture', emoji: '🪔', color: '#FF7A1F', shape: 'circle', providerId: 'claude-code', modelId: '', effort: 'medium', fast: false, modeId: 'auto',
  workspace: '/Users/someone/AppuBot/ada', pinned: false, chief: false, autoApprove: false, appsOff: [], createdAt: 0, updatedAt: 0,
} as const;

export const BOTS: Bot[] = [
  { ...base, name: 'Ada', job: 'Bookkeeping and invoices', instructions: 'Keep every reply under five lines.\nUse British spelling.', computerUse: true } as unknown as Bot,
  { ...base, name: 'Quiet', job: '', instructions: '', computerUse: false } as unknown as Bot,
];
