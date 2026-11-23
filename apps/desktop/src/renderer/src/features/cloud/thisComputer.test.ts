import { describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/platform', () => ({ MACHINE: 'Mac', THIS_MACHINE: 'this Mac', TERMINAL: 'Terminal' }));
vi.mock('./cloudAccount', () => ({ useCloud: () => undefined }));
vi.mock('./cloudClient', () => ({ useCloudLink: () => undefined }));

import { thisComputer } from './thisComputer';

describe('thisComputer', () => {
  it('names this Mac on its own computer', () => {
    expect(thisComputer(false, undefined)).toEqual({ name: 'this Mac', cap: 'This Mac', of: 'this Mac’s', remote: false });
  });
  it('names the person’s own AppuBot computer', () => {
    const c = thisComputer(true, undefined);
    expect(c).toEqual({ name: 'your AppuBot computer', cap: 'Your AppuBot computer', of: 'your AppuBot computer’s', remote: true });
  });
  it('names a team’s computer like a device', () => {
    expect(thisComputer(true, 'Acme').name).toBe('Acme Cloud Computer');
    expect(thisComputer(true, 'Acme').of).toBe('Acme Cloud Computer’s');
    expect(thisComputer(true, '').name).toBe('Team Cloud Computer');
  });
});
