import { Button, cn } from '../../../components/ui';
import { ui, useStore } from '../../../lib/store';
import { AppLogoStack } from '../../apps/AppRow';
import { activeSlugs } from '@appubot/chat-core';
import { signOut, useAppsLive, useAppsUi, useConnectedApps } from '../../apps/appsData';
import { DISCONNECT_APPS_TITLE } from '../nav';
import { SETTINGS_ROW, SETTINGS_ROW_DESCRIPTION, SETTINGS_ROW_TITLE, SettingRow, SettingsCard, SettingsGroup } from './shared';
import { ConnectorsGroup } from './Connectors';

/**
 * Settings › Apps: how many apps are connected and the way to them, and Disconnect all apps. It never names the
 * service the apps come through (the owner's call 2026-11-27, "apps works, that's all"): signing in to it is part of
 * the Connect apps popup's own flow. The apps themselves, and the bots that may use each, are in that popup.
 */
export function AppsSection() {
  // signed in to the apps service, or apps connected on their own servers (those need no sign-in)
  const signedIn = useStore((s) => !!s.apps?.configured);
  const error = useStore((s) => s.apps?.error);
  useAppsLive();
  const connected = useConnectedApps();
  const total = connected.slugs.length;
  // as the Connect apps popup counts them: one that is signed out is listed, and said to be
  const working = activeSlugs(useAppsUi((s) => s.connections));

  return (
    <div className="space-y-6">
      <SettingsGroup title="Connected apps" description="Choose which bots use each app." bare>
        <SettingsCard>
          {total ? (
            <div className={cn(SETTINGS_ROW, 'flex items-center gap-3')}>
              <AppLogoStack toolkits={connected.toolkits} ring="var(--ab-surface)" />
              <div className="min-w-0 flex-1">
                <h3 className={SETTINGS_ROW_TITLE}>{total} {total === 1 ? 'app' : 'apps'}</h3>
                <p className={cn('truncate', SETTINGS_ROW_DESCRIPTION)}>{connected.toolkits.map((t) => (working.includes(t.slug) ? t.name : `${t.name} (signed out)`)).join(', ')}</p>
              </div>
              <Button size="sm" variant="secondary" onClick={() => ui.openApps('connected')}>Manage</Button>
            </div>
          ) : (
            <div className={cn(SETTINGS_ROW, 'flex items-center gap-3')}>
              <p className={cn('min-w-0 flex-1', SETTINGS_ROW_DESCRIPTION)}>No apps connected yet. Connect Gmail, Slack, GitHub and more.</p>
              <Button size="sm" variant="secondary" onClick={() => ui.openApps()}>Connect apps</Button>
            </div>
          )}
          {/* the apps can't be reached, or their sign-in ended: said here too, not only in the Connect apps popup */}
          {error ? <p className="selectable px-4 pb-3 text-ui leading-snug text-danger">{error}</p> : null}
        </SettingsCard>
      </SettingsGroup>

      {signedIn ? (
        <SettingsCard>
          <SettingRow title={DISCONNECT_APPS_TITLE} description="Your bots lose access to every connected app until you connect one again.">
            <Button size="sm" variant="ghost" onClick={signOut}>Disconnect all</Button>
          </SettingRow>
        </SettingsCard>
      ) : null}

      <ConnectorsGroup />
    </div>
  );
}
