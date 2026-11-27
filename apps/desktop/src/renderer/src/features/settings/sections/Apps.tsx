import { Button, cn } from '../../../components/ui';
import { ui, useStore } from '../../../lib/store';
import { AppLogoStack } from '../../apps/AppRow';
import { ComposioSettingRow } from '../../apps/ComposioSettingRow';
import { activeSlugs } from '@appubot/chat-core';
import { useAppsLive, useAppsUi, useConnectedApps } from '../../apps/appsData';
import { SETTINGS_ROW, SETTINGS_ROW_DESCRIPTION, SETTINGS_ROW_TITLE, SettingsCard, SettingsEmptyState, SettingsGroup } from './shared';
import { ConnectorsGroup } from './Connectors';

/**
 * Settings › Apps: the Composio sign-in, then how many apps are connected and the way to them. The apps themselves,
 * and the bots that may use each, are in the Connect apps popup.
 */
export function AppsSection() {
  // signed in to Composio, or apps connected on their own servers (those need no Composio sign-in)
  const configured = useStore((s) => !!s.apps?.configured || !!s.apps?.direct);
  useAppsLive();
  const connected = useConnectedApps();
  const total = connected.slugs.length;
  // as the Connect apps popup counts them: one that is signed out is listed, and said to be
  const working = activeSlugs(useAppsUi((s) => s.connections));

  return (
    <div className="space-y-6">
      <SettingsGroup title="Composio account" description="Your own Composio account connects your bots to apps. What you connect there, every bot can use.">
        <ComposioSettingRow />
      </SettingsGroup>

      {configured ? (
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
              <SettingsEmptyState>No apps connected yet. Connect Gmail, Slack, GitHub and more.</SettingsEmptyState>
            )}
          </SettingsCard>
        </SettingsGroup>
      ) : null}

      <ConnectorsGroup />
    </div>
  );
}
