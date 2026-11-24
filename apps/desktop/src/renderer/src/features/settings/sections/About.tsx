import { useEffect, useState } from 'react';
import { timeAgo } from '@appubot/chat-core';
import type { AppUpdateStatus } from '@appubot/protocol';
import { ExternalLink, MessageCircle, RefreshCw } from '../../../components/ui/icons';
import { Button, Logo, cn } from '../../../components/ui';
import { macCall, refreshMacSystem, useAppUpdate, useMacSystem } from '../../../lib/thisMac';
import { FOUNDER_X_HANDLE, FOUNDER_X_URL, TELEGRAM_GROUP_HANDLE, TELEGRAM_GROUP_URL, X_HANDLE, X_URL } from '../../../lib/links';
import { openSupport } from '../../support/support';
import { restartToUpdate } from '../../update/restartToUpdate';
import { native } from '../../../lib/native';
import { CREDITS_TITLE, LINKS_TITLE, settingAnchorId } from '../nav';
import { CreditsDialog } from '../CreditsDialog';
import { useCloudVersion, useThisComputer, type ThisComputer } from '../../cloud/thisComputer';
import { SETTINGS_ROW, SETTINGS_ROW_DESCRIPTION, SETTINGS_ROW_TITLE, SettingRow, SettingsCard, SettingsGroup } from './shared';

/** Where AppuBot lives outside the app (the same as the website's); a row may carry more than one link. */
const LINKS: { title: string; description: string; links: { label: string; url: string }[] }[] = [
  { title: 'Website', description: 'Downloads, guides and answers.', links: [{ label: 'appubot.com', url: 'https://appubot.com' }] },
  { title: 'On X', description: 'News and what’s coming from AppuBot, and from me, Sarthak, who makes it.', links: [{ label: X_HANDLE, url: X_URL }, { label: FOUNDER_X_HANDLE, url: FOUNDER_X_URL }] },
  ...(TELEGRAM_GROUP_URL ? [{ title: 'Telegram group', description: 'Ask questions, share what your bots do, and hear first what’s new.', links: [{ label: TELEGRAM_GROUP_HANDLE, url: TELEGRAM_GROUP_URL }] }] : []),
  { title: 'Email', description: 'For anything you’d rather not post.', links: [{ label: 'sarthak@appubot.com', url: 'mailto:sarthak@appubot.com' }] },
];

/** the line under the version: where AppuBot's own update stands */
function updateLine(u: AppUpdateStatus | undefined): string {
  switch (u?.state) {
    case undefined: case 'idle': return '';
    case 'unsupported': return 'This build doesn’t update itself';
    case 'checking': return 'Checking for updates…';
    case 'up-to-date': return u.checkedAt && timeAgo(u.checkedAt) !== 'now' ? `Up to date · checked ${timeAgo(u.checkedAt)} ago` : 'Up to date';
    case 'downloading': return `Downloading version ${u.version ?? ''}… ${u.percent ?? 0}%`;
    case 'ready': return `Version ${u.version ?? ''} is ready. It installs when AppuBot restarts.`;
    case 'error': return `Couldn’t update: ${u.error ?? 'unknown error'}`;
  }
}

function UpdateButton({ update }: { update: AppUpdateStatus | undefined }) {
  const [checking, setChecking] = useState(false);
  if (!update || update.state === 'unsupported') return null;
  if (update.state === 'ready') {
    return <Button size="sm" variant="primary" icon={RefreshCw} onClick={() => void restartToUpdate(update.version)}>Restart to update</Button>;
  }
  const busy = checking || update.state === 'checking' || update.state === 'downloading';
  return (
    <Button
      size="sm" variant="outline" icon={RefreshCw} loading={busy} disabled={busy}
      onClick={async () => {
        setChecking(true);
        await macCall('system.checkForUpdate', {}, { errorTitle: 'Could not check for updates' });
        await refreshMacSystem();
        setChecking(false);
      }}
    >
      Check for updates
    </Button>
  );
}

/**
 * The AppuBot computer on screen, under the app's own lines: its version as the account knows it (the one Fix your
 * computer shows; the number its own gateway reports is an internal one) and that nobody has to update it.
 */
function cloudLine(computer: ThisComputer, v: { version?: number; latestVersion?: number; upToDate?: boolean }): string {
  if (v.version === undefined) return `${computer.cap} updates by itself.`;
  if (v.upToDate === false && v.latestVersion !== undefined && v.latestVersion !== v.version) {
    return `${computer.cap} is on version ${v.version} and moves to ${v.latestVersion} by itself.`;
  }
  return `${computer.cap} is on version ${v.version}${v.upToDate ? ', the newest' : ''}. It updates by itself.`;
}

export function AboutSection() {
  // the app's own version and update are this Mac's, also with an AppuBot computer on screen (lib/thisMac.ts): the
  // app has to update there too, and it used to show no status and no button
  const computer = useThisComputer();
  const update = useAppUpdate();
  const cloud = useCloudVersion();
  const [credits, setCredits] = useState(false);

  useEffect(() => { void refreshMacSystem(); }, []);

  const version = useMacSystem((s) => s.version, native().version);
  const line = updateLine(update);

  return (
    <div className="space-y-6">
      <SettingsCard divided={false} className={cn(SETTINGS_ROW, 'flex items-center gap-3')}>
        <Logo size={40} />
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className={SETTINGS_ROW_TITLE}>AppuBot</div>
          <div className={SETTINGS_ROW_DESCRIPTION}>
            Version <span className="selectable font-mono text-fg-2">{version}</span>
          </div>
          {line ? (
            <div className={cn(SETTINGS_ROW_DESCRIPTION, 'selectable', update?.state === 'error' && 'text-danger', update?.state === 'ready' && 'text-fg-2')}>{line}</div>
          ) : null}
          {computer.remote ? <div className={cn(SETTINGS_ROW_DESCRIPTION, 'selectable')}>{cloudLine(computer, cloud)}</div> : null}
        </div>
        <UpdateButton update={update} />
      </SettingsCard>

      <SettingsGroup title={LINKS_TITLE}>
        <SettingRow title="Chat with Sarthak" description="Stuck, found a bug or have an idea? I read every message myself.">
          <Button size="sm" variant="outline" icon={MessageCircle} onClick={() => openSupport()}>Open chat</Button>
        </SettingRow>
        {LINKS.map((l) => (
          <SettingRow key={l.title} title={l.title} description={l.description}>
            <div className="flex flex-wrap justify-end gap-2">
              {l.links.map((k) => (
                <Button key={k.url} size="sm" variant="outline" iconRight={ExternalLink} onClick={() => void native().openExternal(k.url)}>{k.label}</Button>
              ))}
            </div>
          </SettingRow>
        ))}
      </SettingsGroup>

      {/* Whose work AppuBot is made with, out of the way: one quiet button at the foot of the page that opens the list
          (Rare UI's licence asks for a credit people can find, with its link: it is in there, and Settings' search finds
          "Credits"; apps/desktop/scripts/licenses/RareUI.txt) */}
      <div id={settingAnchorId(CREDITS_TITLE)} className="mt-8 flex scroll-mt-24 justify-center">
        <button
          type="button" onClick={() => setCredits(true)}
          className="ab-press ab-pill rounded-control px-2.5 py-1 text-note text-muted/80 transition-colors hover:text-fg focus-visible:text-fg"
        >
          View credits
        </button>
      </div>
      <CreditsDialog open={credits} onClose={() => setCredits(false)} />

    </div>
  );
}
