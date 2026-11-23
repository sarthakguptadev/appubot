import { describe, expect, it } from 'vitest';
import { deriveLiteralCommand, sentenceText, toolSentence, type ToolCallPart } from './toolText';

const call = (title: string, rawInput: Record<string, unknown> = {}): ToolCallPart => ({ type: 'tool_call', toolCallId: 'b', title, kind: 'other', status: 'completed', content: [], locations: [], rawInput });
const say = (t: ToolCallPart, running = false) => sentenceText(toolSentence(t, running));

describe('bot tool sentences', () => {
  it('says whose profile a bot looked at or changed, and what changed', () => {
    expect(say(call('List bots'))).toBe('Listed the bots');
    expect(say(call('List bots'), true)).toBe('Listing the bots');
    expect(say(call('Look at a bot'))).toBe('Looked at its profile');
    expect(say(call('Look at a bot', { bot_id: 'bot_2' }), true)).toBe('Looking at a bot');
    expect(say(call('Update a bot', { job: 'Books' }))).toBe('Updated its job');
    expect(say(call('Update a bot', { job: 'Books', instructions: 'You…' }), true)).toBe('Updating its job and instructions');
    expect(say(call('Update a bot', { bot_id: 'bot_2', name: 'Munshi', color: '#FF7A1F', shape: 'hex', model_id: 'm1' }))).toBe('Updated a bot’s name, look and model');
    expect(say(call('Update a bot'))).toBe('Updated its profile');
    expect(say(call('Read a bot’s chat'))).toBe('Read its own chat');
    expect(say(call('Read a bot’s chat', { bot_id: 'bot_2' }), true)).toBe('Reading a bot’s chat');
  });
});

describe('deriveLiteralCommand', () => {
  it('strips POSIX and Windows shell wrappers alike', () => {
    expect(deriveLiteralCommand(`/bin/zsh -lc "cd /a && ls -la"`)).toBe('ls -la');
    expect(deriveLiteralCommand(`"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command 'Get-ChildItem'`)).toBe('Get-ChildItem');
    expect(deriveLiteralCommand(`"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoProfile -Command "dir"`)).toBe('dir');
    expect(deriveLiteralCommand('powershell.exe -NoProfile -ExecutionPolicy Bypass -Command npm test')).toBe('npm test');
    expect(deriveLiteralCommand('cmd.exe /d /s /c "npm run build"')).toBe('npm run build');
    expect(deriveLiteralCommand('cmd /c dir')).toBe('dir');
    expect(deriveLiteralCommand('git status')).toBe('git status');
  });
});
