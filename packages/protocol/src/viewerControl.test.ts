import { describe, expect, it } from 'vitest';
import { ComputerStatusSchema, parseComputerMessage, parseViewerMessage } from './index';

describe('the screen port’s control channel', () => {
  it('reads what a viewer says and drops anything else', () => {
    expect(parseViewerMessage('{"t":"hello","name":"Sam","via":"browser"}')).toEqual({ t: 'hello', name: 'Sam', via: 'browser' });
    expect(parseViewerMessage('{"t":"control","on":true}')).toEqual({ t: 'control', on: true });
    expect(parseViewerMessage('{"t":"alive"}')).toEqual({ t: 'alive' });
    expect(parseViewerMessage('{"t":"control"}')).toBeNull();
    expect(parseViewerMessage('{"t":"run","cmd":"rm"}')).toBeNull();
    expect(parseViewerMessage('not json')).toBeNull();
    expect(parseViewerMessage(`{"t":"hello","name":"${'x'.repeat(3000)}"}`)).toBeNull();
  });

  it('reads what the computer says', () => {
    const control = { id: 'ctl_1', name: 'Sam', via: 'desktop', since: 1, expiresAt: 2, left: 1 };
    expect(parseComputerMessage(JSON.stringify({ t: 'state', control, mine: true }))).toEqual({ t: 'state', control, mine: true });
    expect(parseComputerMessage('{"t":"hello","v":1}')).toEqual({ t: 'hello', v: 1 });
    expect(parseComputerMessage('{"t":"state"}')).toBeNull();
  });

  it('keeps a computer status from before valid (no control fields)', () => {
    const old = { backend: 'native', available: true, permissions: { accessibility: true, screenRecording: true } };
    expect(ComputerStatusSchema.parse(old).takeControl).toBeUndefined();
  });
});
