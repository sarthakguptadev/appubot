import { useEffect } from 'react';
import { Badge, Button, cn } from '../../components/ui';
import { ui, useStore } from '../../lib/store';
import { ComposioMark } from '../settings/brandLogos';
import { settingAnchorId } from '../settings/nav';
import { SETTINGS_ROW, SETTINGS_ROW_DESCRIPTION, SETTINGS_ROW_TITLE } from '../settings/sections/shared';
import { loadAppsStatus, signOut } from './appsData';
import { SignInButton } from './AppsView';

/** Settings row for the Composio account the apps come through: who is signed in and Sign out, or the sign-in. */
export function ComposioSettingRow() {
  const apps = useStore((s) => s.apps);
  useEffect(() => { if (!apps) void loadAppsStatus(); }, [apps]);
  const configured = !!apps?.configured;

  return (
    <div id={settingAnchorId('Composio')} className={cn(SETTINGS_ROW, 'flex scroll-mt-24 flex-col gap-3')}>
      <div className="flex items-center gap-3">
        <ComposioMark />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className={SETTINGS_ROW_TITLE}>Composio</h3>
            {configured ? (apps?.error ? <Badge tone="warning">Can't reach it</Badge> : <Badge tone="success">Signed in</Badge>) : apps?.error ? <Badge tone="danger">Signed out</Badge> : <Badge tone="neutral">Not set up</Badge>}
          </div>
          <p className={cn('mt-0.5 truncate', SETTINGS_ROW_DESCRIPTION)}>
            {configured
              ? apps?.account ? `Signed in as ${apps.account}` : 'Gmail, Slack, GitHub and more for your bots.'
              : 'Gmail, Slack, GitHub and more for your bots, through your own free Composio account.'}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {configured ? <Button size="sm" variant="ghost" onClick={signOut}>Sign out</Button> : null}
          <Button size="sm" variant="secondary" onClick={() => ui.openApps()}>Connect apps</Button>
        </div>
      </div>
      {/* signed in and something is wrong (Composio can't be reached): said here too, not only in the Connect apps popup */}
      {configured && apps?.error ? <p className="selectable pl-12 text-ui leading-snug text-danger">{apps.error}</p> : null}
      {configured ? null : (
        <div className="flex flex-col gap-2 pl-12">
          {apps?.error ? <p className="selectable text-ui leading-snug text-danger">{apps.error}</p> : null}
          <SignInButton size="sm" again={!!apps?.error} />
        </div>
      )}
    </div>
  );
}
