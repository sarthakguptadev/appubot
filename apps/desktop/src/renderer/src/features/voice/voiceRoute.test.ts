import { describe, expect, it } from 'vitest';
import { DEFAULT_VOICE_STT_MODEL, DEFAULT_VOICE_TTS_MODEL, type VoiceModelStatus, type VoiceStatus } from '@appubot/protocol';
import { HERE, macNeeds, macReadiness, readsFromAfar, voiceRouteFor } from './voiceRoute';

const model = (id: string, kind: 'stt' | 'tts', phase: VoiceModelStatus['phase']): VoiceModelStatus =>
  ({ id, kind, name: id, bytes: 100, phase }) as VoiceModelStatus;
const mac = (stt: VoiceModelStatus['phase'] = 'ready', tts: VoiceModelStatus['phase'] = 'ready'): VoiceStatus =>
  ({ supported: true, models: [model(DEFAULT_VOICE_STT_MODEL, 'stt', stt), model(DEFAULT_VOICE_TTS_MODEL, 'tts', tts)] }) as VoiceStatus;
/** an AppuBot computer: it hears nothing, and reads aloud once its voice is downloaded */
const cloud = (tts: VoiceModelStatus['phase'] | null): VoiceStatus =>
  ({ supported: false, ...(tts ? { speaks: true, models: [model(DEFAULT_VOICE_TTS_MODEL, 'tts', tts)] } : { models: [] }) }) as VoiceStatus;

describe('where voice runs', () => {
  it('this Mac’s own bots: both halves here, as always', () => {
    expect(voiceRouteFor({ remote: false, screen: mac(), screenSettings: null, mac: null })).toEqual(HERE);
    // a computer that can't run speech offers no voice
    expect(voiceRouteFor({ remote: false, screen: { supported: false, models: [] } as unknown as VoiceStatus, screenSettings: null, mac: null }).hear).toBeNull();
    expect(voiceRouteFor({ remote: false, screen: null, screenSettings: null, mac: null }).hear).toBeNull();
  });

  it('an AppuBot computer on screen: this Mac hears, and that computer reads once its voice is there', () => {
    expect(voiceRouteFor({ remote: true, screen: cloud('ready'), screenSettings: null, mac: mac() })).toEqual({ hear: 'mac', speak: 'screen' });
    // its voice still downloading, or a computer from before it spoke: this Mac reads too
    expect(voiceRouteFor({ remote: true, screen: cloud('downloading'), screenSettings: null, mac: mac() })).toEqual({ hear: 'mac', speak: 'mac' });
    expect(voiceRouteFor({ remote: true, screen: cloud(null), screenSettings: null, mac: mac() })).toEqual({ hear: 'mac', speak: 'mac' });
  });

  it('no voice there until this Mac’s own is known, or when this Mac has none', () => {
    expect(voiceRouteFor({ remote: true, screen: cloud('ready'), screenSettings: null, mac: null }).hear).toBeNull();
    expect(voiceRouteFor({ remote: true, screen: cloud('ready'), screenSettings: null, mac: { supported: false, models: [] } as unknown as VoiceStatus }).hear).toBeNull();
  });

  it('a remote computer that hears does both itself', () => {
    expect(voiceRouteFor({ remote: true, screen: mac(), screenSettings: null, mac: mac() })).toEqual(HERE);
  });

  it('knows a reply read by the other computer from one read here', () => {
    expect(readsFromAfar(HERE)).toBe(false);
    expect(readsFromAfar({ hear: 'mac', speak: 'mac' })).toBe(false);
    expect(readsFromAfar({ hear: 'mac', speak: 'screen' })).toBe(true);
  });

  it('this Mac needs its speech model, and its voice only when it also reads', () => {
    expect(macNeeds(HERE)).toBeNull();
    expect(macNeeds({ hear: 'mac', speak: 'screen' })).toBe('dictate');
    expect(macNeeds({ hear: 'mac', speak: 'mac' })).toBe('converse');
    expect(macReadiness(HERE, mac(), null)).toBeNull();
    // the voice missing doesn't hold back a route where the other computer reads
    expect(macReadiness({ hear: 'mac', speak: 'screen' }, mac('ready', 'missing'), null)).toEqual({ state: 'ready' });
    expect(macReadiness({ hear: 'mac', speak: 'mac' }, mac('ready', 'missing'), null)).toEqual({ state: 'missing' });
    expect(macReadiness({ hear: 'mac', speak: 'screen' }, mac('missing'), null)).toEqual({ state: 'missing' });
  });
});
