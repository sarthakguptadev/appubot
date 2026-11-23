// Where voice's two halves run. With this Mac's own bots on screen, both run on this Mac, as they always did. With
// another computer on screen (your AppuBot computer: it hears nothing, there's no room there for the speech models,
// and reads aloud once its voice is downloaded: `VoiceStatus.speaks`), this Mac's own speech model hears you (the
// words go to the bot there as text, with the turn's recording), and the reply is read by that computer's voice
// where it has one, else by this Mac's. So voice mode and dictation work there too (the owner's ask, 2026-11-12:
// "stt on the device, tts on the server"). Pure here; the gateways and this Mac's status are in macVoice.ts.
import type { Settings, VoiceStatus } from '@appubot/protocol';
import { readiness, voiceModelReady } from './models';

/** `screen`: the computer whose bots are on screen; `mac`: this Mac (the same one unless another is on screen) */
export type VoicePlace = 'screen' | 'mac';

export interface VoiceRoute {
  /** who turns your speech into words (null: nobody can, so voice isn't offered) */
  hear: VoicePlace | null;
  /** who reads the reply aloud (null with `hear`) */
  speak: VoicePlace | null;
}

export const HERE: VoiceRoute = { hear: 'screen', speak: 'screen' };
const NONE: VoiceRoute = { hear: null, speak: null };

export function voiceRouteFor(o: {
  /** another computer than this Mac is on screen */
  remote: boolean;
  /** the computer on screen's voice, and its settings (which voice model it reads with) */
  screen: VoiceStatus | null | undefined;
  screenSettings: Pick<Settings, 'voice'> | null | undefined;
  /** this Mac's own voice, read when another computer is on screen (null: not read yet, or this Mac has none) */
  mac: VoiceStatus | null | undefined;
}): VoiceRoute {
  // a computer that hears does both itself (this Mac's own bots; a remote computer with speech models)
  if (o.screen?.supported) return HERE;
  if (!o.remote || !o.mac?.supported) return NONE;
  const reads = o.screen?.speaks === true && voiceModelReady(o.screen, o.screenSettings);
  return { hear: 'mac', speak: reads ? 'screen' : 'mac' };
}

/** The reply is read by another computer than this Mac (every part crosses the network, and it is a smaller machine). */
export const readsFromAfar = (route: VoiceRoute): boolean => route.hear === 'mac' && route.speak === 'screen';

/** What this Mac's own models still need for its half (`null`: nothing of this Mac's is used). */
export function macNeeds(route: VoiceRoute): 'converse' | 'dictate' | null {
  if (route.hear !== 'mac') return null;
  // it hears; and reads too where the computer on screen has no voice yet
  return route.speak === 'mac' ? 'converse' : 'dictate';
}

/** Whether this Mac's half is ready (its speech model, and its voice when it also reads). */
export function macReadiness(route: VoiceRoute, mac: VoiceStatus | null, macSettings: Pick<Settings, 'voice'> | null) {
  const use = macNeeds(route);
  return use ? readiness(mac, macSettings, use) : null;
}
