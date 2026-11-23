import { describe, expect, it } from 'vitest';
import { GROUP_HOPS_MAX } from '@appubot/protocol';
import { groupLead, groupPaused, groupPreview, groupRecipients, isNoReply, joinGroupMessages, linkMentions, MENTION_HREF, groupTileLayout, mentionedBots, renderBotMessagePreface, renderGroupPrompt, replyTextOf } from './groups';

const ada = { id: 'a', name: 'Ada', chief: true };
const bo = { id: 'b', name: 'Bo' };
const scout = { id: 's', name: 'Lead Scout' };
const members = [ada, bo, scout];

describe('groups', () => {
  it('finds the bots a message names, longest name first, each once, @everyone all', () => {
    expect(mentionedBots('@Bo draft it; @Lead Scout book it. @bo again', members)).toEqual([bo, scout]);
    expect(mentionedBots('mail me at x@y.com, @Ada', members)).toEqual([ada]);
    expect(mentionedBots('@Boring nothing', members)).toEqual([]);
    expect(mentionedBots('@everyone status?', members)).toEqual(members);
    expect(mentionedBots('no one named', members)).toEqual([]);
  });

  it('picks the lead: the chosen member, else the first chief', () => {
    expect(groupLead({ botIds: ['b', 'a'] }, members)).toEqual(ada);
    expect(groupLead({ botIds: ['b', 'a'], leadId: 'b' }, members)).toEqual(bo);
    expect(groupLead({ botIds: ['b', 's'] }, members)).toBeUndefined();
  });

  it('routes a message: names first, the user to the lead, a member to the lead, the lead to nobody', () => {
    const user = { kind: 'user' as const };
    expect(groupRecipients({ from: user, mentions: [bo], members, lead: ada })).toEqual([bo]);
    expect(groupRecipients({ from: user, mentions: [], members, lead: ada })).toEqual([ada]);
    expect(groupRecipients({ from: user, mentions: [], members })).toEqual(members);
    expect(groupRecipients({ from: { kind: 'bot', botId: 'b', name: 'Bo' }, mentions: [], members, lead: ada })).toEqual([ada]);
    expect(groupRecipients({ from: { kind: 'bot', botId: 'a', name: 'Ada' }, mentions: [], members, lead: ada })).toEqual([]);
    expect(groupRecipients({ from: { kind: 'bot', botId: 'a', name: 'Ada' }, mentions: members, members, lead: ada })).toEqual([bo, scout]);
    expect(groupRecipients({ from: { kind: 'bot', botId: 'b', name: 'Bo' }, mentions: [], members })).toEqual([]);
    expect(groupRecipients({ from: { kind: 'system' }, mentions: [ada], members, lead: ada })).toEqual([]);
    expect(groupPaused(GROUP_HOPS_MAX)).toBe(true);
    expect(groupPaused(2)).toBe(false);
  });

  it('words the prompts and reads replies back', () => {
    const p = renderGroupPrompt({ group: { name: 'Launch' }, you: ada, members, lead: ada, message: { from: { kind: 'user' }, text: 'Plan it', hop: 0 }, recent: [{ from: { kind: 'bot', botId: 'b', name: 'Bo' }, text: 'Hi' }] });
    expect(p).toContain('Group "Launch"');
    expect(p).toContain('You lead this group');
    expect(p).toContain('Bo, Lead Scout');
    expect(p).toContain('- Bo: Hi');
    expect(p).toContain('The user wrote:\nPlan it');
    expect(renderGroupPrompt({ group: { name: 'Launch' }, you: bo, members, lead: ada, message: { from: { kind: 'bot', botId: 'a', name: 'Ada' }, text: '@Bo go', hop: 1 } })).toContain('Ada leads this group');
    const two = renderGroupPrompt({ group: { name: 'Launch' }, you: ada, members, lead: ada, message: { from: { kind: 'bot', botId: 'b', name: 'Bo' }, text: 'Done A', hop: 2 }, also: [{ from: { kind: 'bot', botId: 's', name: 'Lead Scout' }, text: 'Done B', hop: 2 }] });
    expect(two).toContain('2 messages came for you');
    expect(two).toContain('The bot Bo wrote:\nDone A');
    expect(two).toContain('The bot Lead Scout wrote:\nDone B');
    expect(joinGroupMessages([{ from: { kind: 'bot', name: 'Bo' }, text: 'A' }, { from: { kind: 'user' }, text: 'B' }])).toBe('Bo: A\n\nYou: B');
    expect(joinGroupMessages([{ from: { kind: 'user' }, text: 'Just me' }])).toBe('Just me');
    expect(renderBotMessagePreface({ from: ada, you: bo, waits: true })).toContain('Ada is waiting for your reply');
    expect(isNoReply(' NO_REPLY. ')).toBe(true);
    expect(isNoReply('No reply needed, but here is a thing')).toBe(false);
    expect(replyTextOf({ parts: [{ type: 'text', text: 'Done. ' }, { type: 'tool_call', toolCallId: 't', title: 'x', kind: 'other', status: 'completed', content: [], locations: [] } as never, { type: 'text', text: 'All good.' }], status: 'complete' })).toBe('Done.\n\nAll good.');
    expect(replyTextOf({ parts: [], status: 'error', error: 'boom' })).toBe('(couldn\'t answer: boom)');
    expect(groupPreview({ from: { kind: 'bot', name: 'Ada' }, text: 'On\n it' })).toBe('Ada: On it');
    expect(groupPreview({ from: { kind: 'user' }, text: 'Hi' })).toBe('You: Hi');
  });
});

describe('linkMentions', () => {
  const members = [{ id: 'b1', name: 'Bo' }, { id: 'b2', name: 'Bo Jr' }, { id: 'b3', name: 'Mailent' }];
  it('turns members and @everyone into mention links, longest name first, never in code or emails', () => {
    expect(linkMentions('@Mailent please mail sa@x.com', members)).toBe(`[@Mailent](${MENTION_HREF}b3) please mail sa@x.com`);
    expect(linkMentions('ask @bo jr, then @Bo.', members)).toBe(`ask [@bo jr](${MENTION_HREF}b2), then [@Bo](${MENTION_HREF}b1).`);
    expect(linkMentions('@everyone: go', members)).toBe(`[@everyone](${MENTION_HREF}everyone): go`);
    expect(linkMentions('run `@Bo` and @Zed', members)).toBe('run `@Bo` and @Zed');
    expect(linkMentions('@Bob is not Bo', members)).toBe('@Bob is not Bo');
  });
});

describe('groupTileLayout', () => {
  it('puts the members on a shape inside the tile, the avatars never touching', () => {
    for (let n = 2; n <= 8; n++) {
      const { avatar, points } = groupTileLayout(n, 38);
      expect(points).toHaveLength(n);
      for (const p of points) { expect(p.x - avatar / 2).toBeGreaterThanOrEqual(-0.01); expect(p.x + avatar / 2).toBeLessThanOrEqual(38.01); expect(p.y + avatar / 2).toBeLessThanOrEqual(38.01); }
      const d = Math.hypot(points[0]!.x - points[1]!.x, points[0]!.y - points[1]!.y);
      expect(d).toBeGreaterThanOrEqual(avatar);
    }
    expect(groupTileLayout(3, 38).points[0]!.y).toBeLessThan(19); // a triangle's point up
  });
});

describe('the word a bot says to stay quiet', () => {
  it('is recognised however a model dresses it', async () => {
    const { isNoReply, withoutNoReply, reactionBack } = await import('./groups');
    for (const t of ['NO_REPLY', ' no_reply ', '`NO_REPLY`', '**NO_REPLY**', 'NO_REPLY.', '(NO REPLY)', '"NO_REPLY"\n', '']) expect(isNoReply(t), t).toBe(true);
    for (const t of ['No reply from the bank yet.', 'Done.', 'NO_REPLY\n\nHappy to help.']) expect(isNoReply(t), t).toBe(false);
    // only what a person should read is left
    expect(withoutNoReply('NO_REPLY\n\nHappy to help.')).toBe('Happy to help.');
    expect(withoutNoReply('Happy to help.\n`NO_REPLY`')).toBe('Happy to help.');
    expect(withoutNoReply('NO_REPLY: nothing to add')).toBe('nothing to add');
    expect(withoutNoReply('Thanks! NO_REPLY')).toBe('Thanks!');
    expect(withoutNoReply('The bank sent no reply.')).toBe('The bank sent no reply.');
    // a reaction answered with nothing: the user's own back, or thanks for an unhappy one
    expect(reactionBack('❤️')).toBe('❤️');
    expect(reactionBack('👎')).toBe('🙏');
  });
});
