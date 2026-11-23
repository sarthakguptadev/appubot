import type { AppConnection } from '@appubot/protocol';
import { Plug } from '../../../components/ui/icons';
import { Button } from '../../../components/ui';
import { ui, useStore } from '../../../lib/store';
import { ConnectedCard, ConnectedSkeleton, useConnectionsBySlug } from '../../apps/AppsView';
import { ComposioSettingRow } from '../../apps/ComposioSettingRow';
import { useAppsLive, useConnectedApps } from '../../apps/appsData';
import { SettingsCard, SettingsEmptyState, SettingsGroup } from './shared';

const NO_CONNS: AppConnection[] = [];

/**
 * Settings › Apps: the Composio sign-in, then each connected app with the bots that may use it (the Apps page's own
 * cards), and the way to the Apps page for the rest of the directory.
 */
export function AppsSection() {
  // signed in to Composio, or apps connected on their own servers (those need no Composio sign-in)
  const configured = useStore((s) => !!s.apps?.configured || !!s.apps?.direct);
  useAppsLive();
  const bySlug = useConnectionsBySlug();
  const connected = useConnectedApps();

  return (
    <div className="space-y-6">
      <SettingsGroup title="Composio account" description="Your own Composio account connects your bots to apps. Each app is connected once, for all your bots.">
        <ComposioSettingRow />
      </SettingsGroup>

      {configured ? (
        <SettingsGroup
          title="Connected apps"
          description="Choose which bots use each app."
          action={<Button size="xs" variant="outline" icon={Plug} onClick={() => ui.openApps()}>Browse apps</Button>}
          bare
        >
          {connected.slugs.length ? (
            <div className="flex flex-col gap-3">
              {connected.loading
                ? connected.slugs.map((s) => <ConnectedSkeleton key={s} />)
                : connected.toolkits.map((t) => <ConnectedCard key={t.slug} toolkit={t} conns={bySlug.get(t.slug) ?? NO_CONNS} />)}
            </div>
          ) : (
            <SettingsCard>
              <SettingsEmptyState>No apps connected yet. Browse apps to connect Gmail, Slack, GitHub and more.</SettingsEmptyState>
            </SettingsCard>
          )}
        </SettingsGroup>
      ) : null}
    </div>
  );
}
