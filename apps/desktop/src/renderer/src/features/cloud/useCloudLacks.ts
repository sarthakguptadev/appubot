import { useStore } from '../../lib/store';
import { cloudLacks, type CloudLacks } from './cloudView';

/**
 * What the computer on screen can't do because it is an AppuBot Cloud computer (its `SystemInfo.cloud`): voice, power
 * and lid, the system's permissions, teach recording, the agent cursor, Vault payment cards. Nothing, on this Mac.
 */
export function useCloudLacks(): CloudLacks {
  return cloudLacks({ cloud: useStore((s) => s.system?.cloud) });
}
