// This Mac's own voice while another computer is on screen (voiceRoute.ts): its status and settings (the store holds
// the computer on screen's), read from this Mac's own gateway, and the gateway each half of voice goes to. Voice mode
// and dictation hear through `hearingGateway()` and read through `speakingGateway()`; with this Mac's own bots on
// screen both are the one gateway, as before.
import { useEffect, useMemo } from 'react';
import { create } from 'zustand';
import type { Settings, VoiceStatus } from '@appubot/protocol';
import { activeComputer, gateway, localGateway, type GatewayLike } from '../../lib/gateway';
import { getState, useStore } from '../../lib/store';
import { useCloudLink } from '../cloud/cloudClient';
import { readThrough } from './speech';
import { HERE, voiceRouteFor, type VoicePlace, type VoiceRoute } from './voiceRoute';

interface MacVoice { voice: VoiceStatus | null; settings: Pick<Settings, 'voice'> | null }

/** this Mac's voice and its settings, as last read while another computer was on screen (null until then) */
export const useMacVoice = create<MacVoice>(() => ({ voice: null, settings: null }));

/** Reads this Mac's own voice (its models' state moves while a download runs: ask again). */
export async function readMacVoice(): Promise<MacVoice> {
  const mac = localGateway();
  const [voice, settings] = await Promise.all([mac.call('voice.status'), mac.call('settings.get')]);
  const next = { voice, settings };
  useMacVoice.setState(next);
  return next;
}

let following = false;
/**
 * This Mac's events aren't followed while another computer is on screen, so a download started here is read again
 * every second until none runs.
 */
export function followMacDownload(): void {
  if (following) return;
  following = true;
  const look = async () => {
    const mac = await readMacVoice().catch(() => null);
    if (mac?.voice?.models.some((m) => m.phase === 'downloading')) setTimeout(() => void look(), 1000);
    else following = false;
  };
  setTimeout(() => void look(), 1000);
}

/** The route now, from what is known (outside React). */
export function currentVoiceRoute(): VoiceRoute {
  const s = getState();
  return voiceRouteFor({ remote: activeComputer() === 'cloud', screen: s.voice, screenSettings: s.settings, mac: useMacVoice.getState().voice });
}

/**
 * Whether voice can be offered with the computer on screen, and where its halves run. With another computer on
 * screen this Mac's voice is read once, so the button shows as soon as it is known.
 */
export function useVoiceRoute(): VoiceRoute {
  const remote = useCloudLink((s) => s.computer === 'cloud');
  const screen = useStore((s) => s.voice);
  const screenSettings = useStore((s) => s.settings);
  const mac = useMacVoice((s) => s.voice);
  useEffect(() => { if (remote) void readMacVoice().catch(() => undefined); }, [remote]);
  return useMemo(() => voiceRouteFor({ remote, screen, screenSettings, mac }), [remote, screen, screenSettings, mac]);
}

/** the route a running voice mode or dictation settled on (the speaker and the hearing follow it) */
let active: VoiceRoute = HERE;
export function setActiveVoiceRoute(route: VoiceRoute | null): void {
  active = route ?? HERE;
  // the speaker reads through this Mac's own gateway when the route says this Mac reads
  readThrough(active.speak === 'mac' ? (method, params, opts) => localGateway().call(method, params, opts) : null);
}
export function activeVoiceRoute(): VoiceRoute { return active; }

const at = (place: VoicePlace | null): GatewayLike => (place === 'mac' ? localGateway() : gateway());
/** who hears: this Mac's own gateway when the computer on screen hears nothing */
export const hearingGateway = (): GatewayLike => at(active.hear);
