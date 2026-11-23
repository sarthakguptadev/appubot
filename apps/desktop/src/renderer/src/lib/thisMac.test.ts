/** This Mac's own settings and system info stay this Mac's with another computer on screen (lib/thisMac.ts). */
import { afterEach, describe, expect, it } from 'vitest';
import type { Settings, SystemInfo } from '@appubot/protocol';
import { setActiveComputer, setCloudGateway, type GatewayLike } from './gateway';
import { macSettingsOf, macSystemOf } from './store';

const settings = (theme: Settings['theme'], desktop: boolean) => ({ theme, notifications: { desktop, mobile: true } }) as unknown as Settings;
const system = (version: string, state: 'ready' | 'unsupported') => ({ version, update: { state } }) as unknown as SystemInfo;

afterEach(() => { setCloudGateway(null); });

describe('this Mac’s own state', () => {
  const screen = { settings: settings('system', true), system: system('2026.11.01', 'unsupported') };
  const mac = { macSettings: settings('dark', false), macSystem: system('2026.1116.1', 'ready') };

  it('is the store’s while this Mac is on screen (what was just picked shows at once)', () => {
    expect(macSettingsOf({ ...screen, ...mac })?.theme).toBe('system');
    expect(macSystemOf({ ...screen, ...mac })?.version).toBe('2026.11.01');
    // nothing on screen yet: what this Mac's gateway last said
    expect(macSettingsOf({ settings: null, ...mac })?.theme).toBe('dark');
  });

  it('is this Mac’s, never the screen computer’s, with an AppuBot computer on screen', () => {
    setCloudGateway({} as GatewayLike);
    setActiveComputer('cloud');
    // the app's own update, colour scheme and notifications: the cloud computer's "doesn't update itself" hid them
    expect(macSystemOf({ ...screen, ...mac })?.update?.state).toBe('ready');
    expect(macSettingsOf({ ...screen, ...mac })?.theme).toBe('dark');
    expect(macSettingsOf({ ...screen, ...mac })?.notifications.desktop).toBe(false);
    // not read yet: unknown, never the other computer's answer
    expect(macSettingsOf({ ...screen, macSettings: null })).toBeNull();
    expect(macSystemOf({ ...screen, macSystem: null })).toBeNull();
  });
});
