import { describe, expect, it } from 'vitest';
import { HANDOFF_HOPS_MAX, type Message } from '@appubot/protocol';
import { handoffContext, handoffNext, handoffTargets, mentionChoices, mentionQuery, renderHandoffBack, renderHandoffPrompt } from './handoff';

const ada = { id: 'a', name: 'Ada' };
const ledger = { id: 'l', name: 'Ledger' };
const scout = { id: 's', name: 'Lead Scout' };
const bots = [ada, ledger, scout];

const said = (role: 'user' | 'agent', text: string, o: Partial<Message> = {}): Message =>
  ({ id: `m${text}`, threadId: 't', role, parts: [{ type: 'text', text }], status: 'complete', via: 'desktop', createdAt: 1, updatedAt: 1, ...o }) as Message;

describe('hand-offs in a bot\'s chat', () => {
  it('finds the bots named, never in code, quotes or as @everyone', () => {
    expect(handoffTargets('@Ledger check this invoice', bots)).toEqual([ledger]);
    expect(handoffTargets('@Lead Scout and @ledger, both', bots)).toEqual([scout, ledger]);
    expect(handoffTargets('mail x@ledger.com', bots)).toEqual([]);
    expect(handoffTargets('run `@Ledger` or\n```\n@Ledger\n```', bots)).toEqual([]);
    expect(handoffTargets('> @Ledger said so\nfine', bots)).toEqual([]);
    expect(handoffTargets('@everyone hi, @all too', bots)).toEqual([]);
    expect(handoffTargets('@all@all, @everyone@everyone', bots)).toEqual([]);
    expect(handoffTargets('see youtube.com/@Ledger and @ada@mastodon.social', bots)).toEqual([]);
    expect(handoffTargets('thanks (@Ledger).', bots)).toEqual([ledger]);
    expect(handoffTargets('nobody named', bots)).toEqual([]);
  });

  it('routes the user\'s message: the bots named take it, the chat\'s bot only when named too or when nobody else is', () => {
    expect(handoffNext({ text: '@Ledger check this invoice', from: 'user', chatBotId: 'a', bots, hop: 0 })).toEqual({ to: [ledger], chatBot: false, paused: false });
    expect(handoffNext({ text: 'check this invoice', from: 'user', chatBotId: 'a', bots, hop: 0 })).toEqual({ to: [], chatBot: true, paused: false });
    expect(handoffNext({ text: '@Ada and @Ledger, both of you', from: 'user', chatBotId: 'a', bots, hop: 0 })).toEqual({ to: [ledger], chatBot: true, paused: false });
    expect(handoffNext({ text: '@Ada just you', from: 'user', chatBotId: 'a', bots, hop: 0 })).toEqual({ to: [], chatBot: true, paused: false });
  });

  it('routes a bot\'s reply: the chat\'s bot hands off by name; an answer goes back to it when it asked or is named', () => {
    // the chat's own bot names another: a hand-off; naming nobody (or itself): nothing more
    expect(handoffNext({ text: '@Ledger can you total these?', from: 'a', chatBotId: 'a', bots, hop: 1 })).toEqual({ to: [ledger], chatBot: false, paused: false });
    expect(handoffNext({ text: 'Done, as @Ada I say so', from: 'a', chatBotId: 'a', bots, hop: 1 })).toEqual({ to: [], chatBot: false, paused: false });
    // the bot handed a task answers: back to the chat's bot when it asked, nobody when the user did
    expect(handoffNext({ text: 'Total: $420', from: 'l', chatBotId: 'a', bots, hop: 2, askedByChatBot: true })).toEqual({ to: [], chatBot: true, paused: false });
    expect(handoffNext({ text: 'Total: $420', from: 'l', chatBotId: 'a', bots, hop: 1 })).toEqual({ to: [], chatBot: false, paused: false });
    // …or names someone: never itself
    expect(handoffNext({ text: '@Ada over to you; @Ledger out', from: 'l', chatBotId: 'a', bots, hop: 1 })).toEqual({ to: [], chatBot: true, paused: false });
    expect(handoffNext({ text: '@Lead Scout please book it', from: 'l', chatBotId: 'a', bots, hop: 1, askedByChatBot: true })).toEqual({ to: [scout], chatBot: false, paused: false });
  });

  it('stops passing bots\' messages on at the hop cap', () => {
    const at = (hop: number) => handoffNext({ text: '@Ledger again', from: 'a', chatBotId: 'a', bots, hop });
    expect(at(HANDOFF_HOPS_MAX - 1)).toEqual({ to: [ledger], chatBot: false, paused: false });
    expect(at(HANDOFF_HOPS_MAX)).toEqual({ to: [], chatBot: false, paused: true });
    // a message that goes to nobody anyway isn't a pause; the user's own never pause
    expect(handoffNext({ text: 'all done', from: 'a', chatBotId: 'a', bots, hop: HANDOFF_HOPS_MAX })).toEqual({ to: [], chatBot: false, paused: false });
    expect(handoffNext({ text: '@Ledger', from: 'user', chatBotId: 'a', bots, hop: 0 }).paused).toBe(false);
  });

  it('tells the bot named where the task comes from, with the chat\'s latest messages', () => {
    const recent = [said('user', 'I got an invoice from Acme'), said('agent', 'Want me to file it?'), said('agent', 'Earlier total: $10', { from: { botId: 'l', name: 'Ledger' } })];
    const p = renderHandoffPrompt({ you: ledger, chatBot: ada, from: 'user', recent });
    expect(p).toContain('The user named you (@Ledger) in their chat with Ada');
    expect(p).toContain("shown in Ada's chat under your name");
    expect(p).toContain('- The user: I got an invoice from Acme\n- Ada: Want me to file it?\n- Ledger: Earlier total: $10');
    expect(p.endsWith('The user wrote:')).toBe(true);
    const fromBot = renderHandoffPrompt({ you: ledger, chatBot: ada, from: ada, recent: [] });
    expect(fromBot).toContain('Ada named you (@Ledger) in its chat with the user');
    expect(fromBot).not.toContain('Earlier in that chat');
    expect(fromBot.endsWith('Ada wrote:')).toBe(true);
    // only the latest few, each cut short
    const many = Array.from({ length: 20 }, (_, i) => said('user', `n${i} ${'x'.repeat(400)}`));
    const cut = renderHandoffPrompt({ you: ledger, chatBot: ada, from: 'user', recent: many });
    expect(cut).not.toContain('n11 ');
    expect(cut).toContain('n12 ');
    expect(cut).toContain('…');
  });

  it('gives the chat\'s own bot what it missed since its last reply, the answers attributed', () => {
    const chat = [
      said('user', 'hi'), said('agent', 'Hello!'),
      said('user', '@Ledger check this invoice'),
      said('agent', 'It double-charges VAT.', { via: 'bot', from: { botId: 'l', name: 'Ledger' } }),
      said('agent', '', { via: 'bot', from: { botId: 's', name: 'Lead Scout' }, status: 'streaming', parts: [] }),
    ];
    const c = handoffContext(chat, { botName: 'Ada' })!;
    expect(c).toContain('- The user: @Ledger check this invoice\n- Ledger: It double-charges VAT.');
    expect(c).not.toContain('Hello!');
    expect(c).not.toContain('The user: hi');
    // nothing handed off since its last reply: nothing to tell
    expect(handoffContext(chat.slice(0, 2), { botName: 'Ada' })).toBeNull();
    expect(handoffContext([...chat.slice(0, 4), said('agent', 'Fixed it.')], { botName: 'Ada' })).toBeNull();
    // an answer still being worked on alone: nothing yet
    expect(handoffContext([chat[0]!, chat[1]!, chat[2]!, chat[4]!], { botName: 'Ada' })).toBeNull();
    expect(renderHandoffBack({ from: ledger })).toContain('Ledger answered in this chat');
  });

  it('reads the @ being typed for the composer\'s menu, and offers the bots that fit', () => {
    expect(mentionQuery('@', 1)).toEqual({ start: 0, query: '' });
    expect(mentionQuery('hey @Led', 8)).toEqual({ start: 4, query: 'Led' });
    expect(mentionQuery('hey @Led and more', 8)).toEqual({ start: 4, query: 'Led' });
    expect(mentionQuery('hey @Ledger check', 17)).toBeNull();
    expect(mentionQuery('x@y.com', 7)).toBeNull();
    expect(mentionQuery('plain', 5)).toBeNull();
    expect(mentionChoices(bots, '')).toEqual(bots);
    expect(mentionChoices(bots, 'le')).toEqual([ledger, scout]);
    expect(mentionChoices(bots, 'SCO')).toEqual([scout]);
    expect(mentionChoices(bots, 'z')).toEqual([]);
  });
});
