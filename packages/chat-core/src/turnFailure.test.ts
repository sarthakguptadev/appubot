import { describe, expect, it } from 'vitest';
import { failureKind, turnFailure } from './turnFailure';

describe('a failed turn, as something to act on', () => {
  it('reads the agent’s words into what went wrong', () => {
    expect(failureKind('The requested model is not supported')).toBe('model');
    expect(failureKind('Upstream request failed: Model is unavailable')).toBe('model');
    expect(failureKind('model not found: github-copilot/gemini-4-hydrogen')).toBe('model');
    expect(failureKind('Claude usage limit reached. Resets at 5pm')).toBe('limit');
    expect(failureKind('429 Too Many Requests')).toBe('limit');
    expect(failureKind('prompt is too long: 213000 tokens > 200000 maximum')).toBe('context');
    expect(failureKind('Please run /login · API Error: 401 unauthorized')).toBe('sign-in');
    expect(failureKind('Claude Code needs you to sign in again')).toBe('sign-in');
    expect(failureKind('Asana answered 503: Service Unavailable.')).toBe('network');
    expect(failureKind('fetch failed (ECONNRESET)')).toBe('network');
    expect(failureKind('spawn codex ENOENT')).toBe('not-installed');
    expect(failureKind('ACP connection closed')).toBe('stopped');
    expect(failureKind('Something odd')).toBe('other');
    expect(failureKind(undefined)).toBe('other');
  });

  it('offers what puts it right, best first', () => {
    const model = turnFailure('The requested model is not supported', { botName: 'Olive', agentName: 'OpenCode', asked: true });
    expect(model).toMatchObject({ title: 'That model can’t answer right now', fixes: ['model', 'retry'], detail: 'The requested model is not supported' });
    expect(model.body).toBe('Pick another model for Olive, then try again.');
    // a turn of the bot's own (its greeting) has no message to send again
    expect(turnFailure('The requested model is not supported', { botName: 'Olive' }).fixes).toEqual(['model']);
    expect(turnFailure('401 unauthorized', { botName: 'Olive', agentName: 'Claude Code', asked: true })).toMatchObject({ title: 'Claude Code needs you to sign in', fixes: ['agents', 'model', 'retry'], agentsLabel: 'Sign in' });
    expect(turnFailure('spawn codex ENOENT', { botName: 'Olive', agentName: 'Codex' })).toMatchObject({ title: 'Codex isn’t installed on this computer', fixes: ['agents', 'model'], agentsLabel: 'Install it' });
    expect(turnFailure('prompt is too long', { botName: 'Olive', asked: true }).fixes).toEqual(['new-thread', 'model']);
    expect(turnFailure('fetch failed', { botName: 'Olive', asked: true })).toMatchObject({ title: 'A connection problem stopped Olive', fixes: ['retry', 'model'] });
    expect(turnFailure('usage limit reached', { botName: 'Olive', agentName: 'Claude Code', asked: true }).title).toBe('Claude Code has reached its limit');
  });

  it('keeps the agent’s own words short, and says something when it said nothing', () => {
    expect(turnFailure(`boom\n\n  ${'x'.repeat(600)}`, { botName: 'Olive' }).detail.length).toBe(400);
    expect(turnFailure('', { botName: 'Olive', asked: true })).toMatchObject({ kind: 'other', title: 'Olive couldn’t finish', body: 'Something went wrong on the way.', detail: '', fixes: ['retry', 'model'] });
  });
});
