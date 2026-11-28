/**
 * How a page names the computer on screen in a sentence: "this Mac" (lib/platform `THIS_MACHINE`) on this Mac, else
 * the remote computer: "your AppuBot computer", or a team's "Acme Cloud Computer" (chat-core `computerDisplayName`). Settings pages
 * and dialogs that say where something is kept or runs read it, so a cloud computer's pages never say "this Mac".
 */
import { computerDisplayName } from '@appubot/chat-core';
import { THIS_MACHINE } from '../../lib/platform';
import { useCloud } from './cloudAccount';
import { useCloudLink } from './cloudClient';
import { YOUR_COMPUTER } from './names';

export interface ThisComputer {
  /** mid-sentence: "this Mac", "your AppuBot computer", "Acme Cloud Computer" */
  name: string;
  /** at the start of a sentence */
  cap: string;
  /** possessive: "this Mac’s", "your AppuBot computer’s", "Acme Cloud Computer’s" */
  of: string;
  /** the computer on screen isn't this one */
  remote: boolean;
}

export function thisComputer(remote: boolean, teamName: string | undefined | null): ThisComputer {
  const name = !remote ? THIS_MACHINE : teamName !== undefined && teamName !== null ? computerDisplayName({ team: teamName }) : YOUR_COMPUTER;
  return { name, cap: name.charAt(0).toUpperCase() + name.slice(1), of: `${name}’s`, remote };
}

export function useThisComputer(): ThisComputer {
  const remote = useCloudLink((s) => s.computer === 'cloud');
  const team = useCloudLink((s) => s.team);
  const teamName = useCloud((s) => (team ? s.view?.teams?.find((t) => t.team.id === team)?.team.name ?? 'the team' : undefined));
  return thisComputer(remote, remote ? teamName : undefined);
}

/**
 * Whether the remote computer on screen is on the newest version (`CloudComputer.fix.upToDate`); undefined on this
 * Mac, or while the account hasn't said (not read yet, a backend from before).
 */
export function useCloudUpToDate(): boolean | undefined {
  const remote = useCloudLink((s) => s.computer === 'cloud');
  const team = useCloudLink((s) => s.team);
  const upToDate = useCloud((s) => (team ? s.view?.teams?.find((t) => t.team.id === team)?.computer : s.view?.computer)?.fix?.upToDate);
  return remote ? upToDate : undefined;
}
