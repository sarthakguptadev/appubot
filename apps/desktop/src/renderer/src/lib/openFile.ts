import type { FileAttachment } from '@appubot/protocol';
import { call } from './actions';
import { openRemoteFile, remoteComputer } from '../features/cloud/remoteFiles';

/**
 * Open a file in its own Mac app (Preview, QuickTime, the PDF reader…), the way a double-click in Finder would. A
 * remote computer's (your AppuBot computer, a team's) is brought to this Mac first (features/cloud/remoteFiles.ts):
 * `files.open` there would open it on that computer's own screen.
 */
export function openFile(f: FileAttachment): void {
  if (remoteComputer()) { void openRemoteFile(f); return; }
  openFileById(f.id, f.name);
}

/** The same for a file known only by its id (a tool's link to `/files/<id>`): never a URL handed to the browser. */
export function openFileById(id: string, name: string): void {
  if (remoteComputer()) { void openRemoteFile({ id, name }); return; }
  void call('files.open', { id }, { errorTitle: `Could not open ${name}` });
}
