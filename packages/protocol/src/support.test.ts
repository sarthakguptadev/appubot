import { describe, expect, it } from 'vitest';
import { CRISP, crispChatUrl, isCrispPage } from './util';

describe('support chat (Crisp)', () => {
  it('opens AppuBot’s hosted chat page', () => {
    expect(crispChatUrl()).toBe(`https://go.crisp.chat/chat/embed/?website_id=${CRISP.websiteId}`);
  });

  it('fills in a known email and name, encoded', () => {
    const u = new URL(crispChatUrl({ email: ' sam+a@example.com ', name: 'Sam Lee' }));
    expect(u.searchParams.get('website_id')).toBe(CRISP.websiteId);
    expect(u.searchParams.get('user_email')).toBe('sam+a@example.com');
    expect(u.searchParams.get('user_nickname')).toBe('Sam Lee');
  });

  it('leaves out an email that isn’t one, and blanks', () => {
    const u = new URL(crispChatUrl({ email: 'not an email', name: '  ' }));
    expect(u.searchParams.has('user_email')).toBe(false);
    expect(u.searchParams.has('user_nickname')).toBe(false);
  });

  it('knows Crisp’s pages from others', () => {
    expect(isCrispPage(crispChatUrl())).toBe(true);
    expect(isCrispPage('https://image.crisp.chat/x.png')).toBe(true);
    expect(isCrispPage('http://go.crisp.chat/chat/embed/')).toBe(false);
    expect(isCrispPage('https://crisp.chat.evil.com/')).toBe(false);
    expect(isCrispPage('https://appubot.com')).toBe(false);
    expect(isCrispPage('not a url')).toBe(false);
  });
});
