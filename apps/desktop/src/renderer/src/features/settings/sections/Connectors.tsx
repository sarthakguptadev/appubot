import { useState } from 'react';
import { Plus } from '../../../components/ui/icons';
import { Button } from '../../../components/ui';
import { ConnectorDialog, ConnectorRow, type ConnectorStep } from '../../apps/ConnectorDialog';
import { useConnectors } from '../../apps/connectorsData';
import { CONNECTORS_TITLE } from '../nav';
import { SETTINGS_ROW, SETTINGS_ROW_DESCRIPTION, SettingsCard, SettingsGroup } from './shared';

/** Settings › Apps › Custom connectors: the person's own MCP servers, an Add for more, each opening its page. */
export function ConnectorsGroup() {
  const { list, loaded } = useConnectors();
  const [open, setOpen] = useState<ConnectorStep | null>(null);
  return (
    <SettingsGroup
      title={CONNECTORS_TITLE}
      description="Your own MCP servers: one at an address, or one this computer starts. Their tools go to the bots you choose."
      action={<Button size="sm" variant="secondary" icon={Plus} onClick={() => setOpen({ kind: 'menu' })}>Add</Button>}
      bare
    >
      <SettingsCard>
        {list.length ? list.map((c) => <ConnectorRow key={c.id} connector={c} onOpen={() => setOpen({ kind: 'view', id: c.id })} />) : (
          <p className={`${SETTINGS_ROW} ${SETTINGS_ROW_DESCRIPTION}`}>{loaded ? 'None yet. Add a server by its address, a command, or a config from another app.' : 'Loading…'}</p>
        )}
      </SettingsCard>
      {open ? <ConnectorDialog start={open} onClose={() => setOpen(null)} /> : null}
    </SettingsGroup>
  );
}
