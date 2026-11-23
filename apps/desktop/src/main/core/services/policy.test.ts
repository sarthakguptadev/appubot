import { describe, expect, it } from 'vitest';
import { renderIntroPrompt } from './bots';
import { actsInAccounts, bridgeTool, isOwnTool, isSetupTool, pickAllowOnce } from './policy';
import { BotSchema } from '@appubot/protocol';

describe('a new bot setting itself up', () => {
  it('may use only AppuBot’s own setup tools without an approval', () => {
    expect(bridgeTool('mcp__appubot__ask_user')).toBe('ask_user');
    expect(isSetupTool('ask_user')).toBe(true);
    expect(isSetupTool('Ask you')).toBe(false);
    for (const t of ['mcp__appubot__ask_user', 'mcp__appubot__remember', 'mcp__appubot__update_bot', 'appubot.save_skill']) expect(isSetupTool(t)).toBe(true);
    for (const t of ['mcp__appubot__computer_click', 'mcp__appubot__send_file', 'Bash', 'mcp__other__ask_user', 'Edit file']) expect(isSetupTool(t)).toBe(false);
    expect(pickAllowOnce([{ optionId: 'no', name: 'Reject', kind: 'reject_once' }, { optionId: 'yes', name: 'Allow', kind: 'allow_once' }])).toBe('yes');
  });

  it('sets itself up in a short chat: what it’s for, a follow-up, its name while it has none, and rules', () => {
    const bot = BotSchema.parse({ id: 'b', slug: 'new-bot', name: 'New Bot', providerId: 'claude-code', workspace: '/w', createdAt: 1, updatedAt: 1 });
    const p = renderIntroPrompt(bot);
    expect(p).toContain("What they'd like you for");
    expect(p).toContain('One follow-up that fits their answer');
    expect(p).toContain('What to call you');
    expect(p).toContain('always or never do');
    expect(p).toContain('one at a time with the `ask_user` tool');
    expect(p).toContain('update_bot` with the name they picked, and your job (one short line), and your instructions');
  });

  it('asks a named bot nothing about its name, and fits a template’s job to the person', () => {
    const base = { id: 'b', slug: 'ada', providerId: 'claude-code', workspace: '/w', createdAt: 1, updatedAt: 1 };
    const named = renderIntroPrompt(BotSchema.parse({ ...base, name: 'Pip' }));
    expect(named).toContain("What they'd like you for");
    expect(named).not.toContain('What to call you');
    const template = renderIntroPrompt(BotSchema.parse({ ...base, name: 'Ledger', job: 'Bookkeeping', instructions: '- Ask first' }));
    expect(template).toContain('mentioning your job (Bookkeeping)');
    expect(template).toContain('fit your job (Bookkeeping) to them');
    expect(template).not.toContain("What they'd like you for");
    expect(template).not.toContain('What to call you');
    expect(template).toContain('keep the lines already there');
    expect(template).not.toContain('your job (one short line)');
  });
});

describe("Cursor's names for AppuBot's tools", () => {
  it('reads "appubot-ask_user: ask_user" as ask_user, one of its own tools', () => {
    expect(bridgeTool('appubot-ask_user: ask_user')).toBe('ask_user');
    expect(isOwnTool('appubot-ask_user: ask_user')).toBe(true);
    expect(bridgeTool('appubot-computer_click: computer_click')).toBe('computer_click');
    expect(isOwnTool('appubot-computer_click: computer_click')).toBe(false);
  });

  it('finds app tools and reads their inputs without asking, but running them acts in the user\'s accounts', () => {
    for (const t of ['mcp__appubot__apps_search', 'appubot-apps_tool_schemas: apps_tool_schemas']) expect(isOwnTool(t)).toBe(true);
    expect(isOwnTool('mcp__appubot__apps_execute')).toBe(false);
    expect(actsInAccounts('mcp__appubot__apps_execute')).toBe(true);
    expect(actsInAccounts('apps_execute')).toBe(true);
    expect(actsInAccounts('mcp__appubot__apps_search')).toBe(false);
  });

  it('takes the voice tools as its own (no approval to hear a file or send a voice message)', () => {
    for (const t of ['mcp__appubot__transcribe_audio', 'mcp__appubot__send_voice', 'appubot-send_voice: send_voice']) expect(isOwnTool(t)).toBe(true);
  });
});
