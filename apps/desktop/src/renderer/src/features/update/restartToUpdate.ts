/**
 * Putting a downloaded update on: AppuBot restarts into it. Shared by Settings › About and the sidebar's update row.
 * The update is this app's own, so every call goes to this Mac's gateway, whichever computer is on screen.
 */
import { confirm } from '../../lib/actions';
import { activeComputer, localGateway } from '../../lib/gateway';
import { macCall } from '../../lib/thisMac';
import { getState } from '../../lib/store';

/** how many of this Mac's bots are mid-turn (the store's threads are the screen computer's: a cloud computer's don't stop) */
async function macWorking(): Promise<number> {
  const busy = (ts: readonly { status: string }[]) => ts.filter((t) => t.status === 'running' || t.status === 'waiting').length;
  if (activeComputer() === 'local') return busy(getState().threads);
  try { return busy(await localGateway().call('threads.list', {})); } catch { return 0; }
}

/** restart into the downloaded version, asking first while bots are working (they stop) */
export async function restartToUpdate(version: string | undefined): Promise<void> {
  const install = async () => { await macCall('system.installUpdate', {}, { errorTitle: 'Could not install the update' }); };
  const working = await macWorking();
  if (!working) return void install();
  confirm({
    title: 'Restart to update?',
    body: `${working} bot${working === 1 ? ' is' : 's are'} working right now and will stop. AppuBot opens again${version ? ` with version ${version}` : ''}.`,
    confirmLabel: 'Restart',
    onConfirm: install,
  });
}
