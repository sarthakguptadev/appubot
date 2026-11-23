import { useEffect, useState } from 'react';
import { ExternalLink, RefreshCw } from '../../components/ui/icons';
import { Badge, Button, cn } from '../../components/ui';
import { call } from '../../lib/actions';
import { native } from '../../lib/native';
import { THIS_MACHINE } from '../../lib/platform';
import { setState, useStore } from '../../lib/store';
import { TailscaleMark } from './brandLogos';
import { settingAnchorId } from './nav';
import { SETTINGS_ROW, SETTINGS_ROW_DESCRIPTION, SETTINGS_ROW_TITLE } from './sections/shared';

export async function loadSystemInfo(): Promise<void> {
  const info = await call('system.info', {}, { errorTitle: 'Could not load system info' });
  if (info) setState({ system: info });
}

/** Settings row for Tailscale, how the phone reaches this computer: installed / running, and its name on the tailnet. */
export function TailscaleSettingRow() {
  const ts = useStore((s) => s.system?.tailscale);
  const loaded = useStore((s) => !!s.system);
  const [loading, setLoading] = useState(false);
  useEffect(() => { if (!loaded) void loadSystemInfo(); }, [loaded]);

  const address = ts?.dnsName?.replace(/\.$/, '') || ts?.ips[0];
  const meta = [ts?.tailnet, ts?.loginName && `signed in as ${ts.loginName}`].filter(Boolean).join(' · ');

  return (
    <div id={settingAnchorId('Tailscale')} className={cn(SETTINGS_ROW, 'flex scroll-mt-24 items-center gap-3')}>
      <TailscaleMark />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className={SETTINGS_ROW_TITLE}>Tailscale</h3>
          {!ts ? null : !ts.installed ? <Badge tone="neutral">Not installed</Badge> : ts.running ? <Badge tone="success">Running</Badge> : <Badge tone="warning">Stopped</Badge>}
        </div>
        <p className={cn('mt-0.5', SETTINGS_ROW_DESCRIPTION)}>
          {ts?.installed && ts.running && address
            ? <>Your phone reaches {THIS_MACHINE} at <span className="selectable font-mono text-fg-2">{address}</span>{meta ? <>. {meta}</> : null}.</>
            : ts?.installed
              ? `Turn Tailscale on so your phone can reach ${THIS_MACHINE} privately.`
              : `Lets your phone reach ${THIS_MACHINE} privately, from anywhere.`}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <Button
          size="icon-sm" variant="ghost" icon={RefreshCw} loading={loading} aria-label="Refresh"
          onClick={async () => { setLoading(true); await loadSystemInfo(); setLoading(false); }}
        />
        {ts && !ts.installed ? (
          <Button size="sm" variant="secondary" icon={ExternalLink} onClick={() => void native().openExternal('https://tailscale.com/download')}>Get Tailscale</Button>
        ) : null}
      </div>
    </div>
  );
}
