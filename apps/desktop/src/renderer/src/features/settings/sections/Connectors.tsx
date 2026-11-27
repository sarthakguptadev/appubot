import { useState } from 'react';
import { Plus } from '../../../components/ui/icons';
import { Button } from '../../../components/ui';
import { ConnectorDialog, ConnectorRow, type ConnectorStep } from '../../apps/ConnectorDialog';
import { useConnectors, type ConnectorsUnavailable } from '../../apps/connectorsData';
import type { ComputerId } from '../../../lib/gateway';
import { MACHINE } from '../../../lib/platform';
import { CONNECTORS_TITLE } from '../nav';
import { SETTINGS_ROW, SETTINGS_ROW_DESCRIPTION, SettingsCard, SettingsGroup } from './shared';

/** What the section says in place of the list when the computer on screen can't have connectors. */
function unavailableText(why: ConnectorsUnavailable, on: ComputerId): string {
  if (why === 'notAllowed') return 'Only the team’s admins can add connectors to this computer.';
  return on === 'local'
    ? `AppuBot on this ${MACHINE} needs a restart to add connectors (Settings › About).`
    : 'This computer’s AppuBot is older and can’t add connectors yet. Update it in Settings › Account › Manage.';
}

/** Settings › Apps › Custom connectors: the person's own MCP servers, an Add for more, each opening its page. */
export function ConnectorsGroup() {
  const { list, loaded, unavailable, on } = useConnectors();
  const [open, setOpen] = useState<ConnectorStep | null>(null);
  return (
    <SettingsGroup
      title={CONNECTORS_TITLE}
      description="Your own MCP servers: one at an address, or one this computer starts. Their tools go to the bots you choose."
      action={<Button size="sm" variant="secondary" icon={Plus} disabled={!!unavailable} onClick={() => setOpen({ kind: 'menu' })}>Add</Button>}
      bare
    >
      <SettingsCard>
        {list.length ? list.map((c) => <ConnectorRow key={c.id} connector={c} onOpen={() => setOpen({ kind: 'view', id: c.id })} />) : (
          <p className={`${SETTINGS_ROW} ${SETTINGS_ROW_DESCRIPTION}`}>{unavailable ? unavailableText(unavailable, on) : loaded ? 'None yet. Add a server by its address, a command, or a config from another app.' : 'Loading…'}</p>
        )}
      </SettingsCard>
      {open ? <ConnectorDialog start={open} onClose={() => setOpen(null)} /> : null}
    </SettingsGroup>
  );
}
