import { useState } from 'react';
import { Download, RefreshCw } from '../ui/icons';
import { Button, Logo, Spinner } from '../ui';
import { native } from '../../lib/native';
import { macCall, useAppUpdate } from '../../lib/thisMac';

const DOWNLOAD_PAGE = 'https://appubot.com/download';

/**
 * This version was stopped (the version policy in the releases repo): AppuBot refuses everything but updating, so the
 * whole window says so and offers the update. It downloads by itself as soon as the stop arrives; a build that can't
 * update itself sends you to the download page. The stop is this app's own (this Mac's), so it shows whichever
 * computer is on screen: with an AppuBot computer there the window read that computer's status and never said so.
 */
export function UpdateRequired() {
  const update = useAppUpdate();
  const [asking, setAsking] = useState(false);
  if (!update?.required) return null;

  const openDownloads = () => void native().openExternal(DOWNLOAD_PAGE);
  const checkAgain = async () => {
    setAsking(true);
    await macCall('system.checkForUpdate', {}, { errorTitle: 'Could not check for updates' });
    setAsking(false);
  };

  let action;
  if (update.state === 'ready') {
    action = (
      <Button variant="primary" icon={RefreshCw} onClick={() => void macCall('system.installUpdate', {}, { errorTitle: 'Could not install the update' })}>
        Restart to update{update.version ? ` to ${update.version}` : ''}
      </Button>
    );
  } else if (update.state === 'downloading') {
    action = (
      <div className="flex w-64 flex-col items-center gap-2">
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
          <div className="h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${update.percent ?? 0}%` }} />
        </div>
        <p className="text-note text-muted tabular-nums">Downloading version {update.version ?? ''}… {update.percent ?? 0}%</p>
      </div>
    );
  } else if (update.state === 'checking' || asking) {
    action = <p className="flex items-center gap-2 text-copy text-muted"><Spinner size={14} /> Looking for the new version…</p>;
  } else if (update.state === 'unsupported') {
    action = <Button variant="primary" icon={Download} onClick={openDownloads}>Download the new version</Button>;
  } else {
    action = (
      <>
        {update.state === 'error' && update.error ? <p className="text-note text-danger">Couldn’t update: {update.error}</p> : null}
        {update.state === 'up-to-date' ? <p className="text-note text-muted">No newer version is out yet. Check again in a little while.</p> : null}
        <Button variant="primary" icon={RefreshCw} onClick={() => void checkAgain()}>{update.state === 'up-to-date' ? 'Check again' : 'Update now'}</Button>
        <button type="button" className="text-note text-muted underline underline-offset-4 hover:text-fg" onClick={openDownloads}>Or download it from appubot.com</button>
      </>
    );
  }

  return (
    <div role="alertdialog" aria-modal="true" aria-labelledby="update-required-title" className="drag fixed inset-0 z-[75] flex items-center justify-center overflow-hidden bg-[var(--ab-coat)] backdrop-blur-2xl">
      <div className="no-drag relative flex max-w-[420px] flex-col items-center px-6 text-center">
        <Logo size={56} className="mb-5" />
        <h1 id="update-required-title" className="font-display text-[24px] font-medium tracking-display text-fg">Update required</h1>
        <p className="mt-2 text-copy leading-relaxed text-muted">{update.required.message}</p>
        <div className="mt-6 flex flex-col items-center gap-3">{action}</div>
      </div>
    </div>
  );
}
