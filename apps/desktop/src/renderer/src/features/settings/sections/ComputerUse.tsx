import { useEffect } from 'react';
import type { Settings } from '@appubot/protocol';
import { Badge, Button, Switch } from '../../../components/ui';
import { IS_MAC, PLATFORM, THIS_MACHINE } from '../../../lib/platform';
import { ui, useStore } from '../../../lib/store';
import { refreshComputerStatus } from '../../computer/PermissionRows';
import { PERMISSIONS_TITLE, WORK_IN_BACKGROUND_TITLE, settingAnchorId } from '../nav';
import { useCloudLacks } from '../../cloud/useCloudLacks';
import { InfoRow, SectionLoading, SettingRow, SettingsGroup, updateSettings } from './shared';

type ComputerSettings = Settings['computer'];
const BACKEND_LABEL = { 'cua-driver': 'Cua driver', native: 'Native (macOS)', none: 'None' } as const;
/** Linux draws the cursor only on X11 desktops that composite, and can't keep it out of screenshots */
const CURSOR_DESCRIPTION = PLATFORM === 'linux'
  ? 'While a bot works, its pointer and avatar glide on your screen to each thing it clicks. Shows on X11 desktops like GNOME, KDE or Cinnamon, not on Wayland.'
  : 'While a bot works, its pointer and avatar glide on your screen to each thing it clicks. Screenshots never include it.';
const BACKGROUND_DESCRIPTION = `Keep using ${THIS_MACHINE} while bots work: their windows stay behind yours. A step that needs its window in front, like a click on a web page or a drag, waits until you pause, then takes a moment. Off: the window comes forward so you can watch.`;

function updateComputer(current: ComputerSettings, patch: Partial<ComputerSettings>): void {
  void updateSettings({ computer: { ...current, ...patch } });
}

export function ComputerUseSection() {
  const settings = useStore((s) => s.settings);
  const status = useStore((s) => s.computer);
  // the cloud computer draws no cursor and has no system permissions to give (SystemInfo.cloud)
  const lacks = useCloudLacks();

  useEffect(() => { void refreshComputerStatus(); }, []);

  if (!settings) return <SectionLoading />;
  // Input Monitoring is only for Teach mode, so it counts once it's known to be missing
  const p = status?.permissions;
  const allGranted = !!p && p.accessibility && p.screenRecording && p.inputMonitoring !== false;
  const c = settings.computer;

  return (
    <div className="space-y-6">
      <SettingsGroup title="Control" description="Let bots see the screen and use your apps with the mouse and keyboard.">
        <SettingRow title="Allow computer use" description="Bots with computer use turned on can click, type and take screenshots.">
          <Switch label="Allow computer use" checked={c.enabled} onChange={(enabled) => updateComputer(c, { enabled })} />
        </SettingRow>
        <SettingRow title="Live view" description="Show what a bot sees, live in this window and on your phone, while it uses the computer.">
          <Switch label="Live view" checked={c.liveView} disabled={!c.enabled} onChange={(liveView) => updateComputer(c, { liveView })} />
        </SettingRow>
        {/* your AppuBot computer: the bots always work on its real screen (it is theirs); people step in with live view's Take control */}
        {lacks.background ? null : (
          <SettingRow title={WORK_IN_BACKGROUND_TITLE} description={BACKGROUND_DESCRIPTION}>
            <Switch label={WORK_IN_BACKGROUND_TITLE} checked={c.background} disabled={!c.enabled} onChange={(background) => updateComputer(c, { background })} />
          </SettingRow>
        )}
        {lacks.agentCursor ? null : (
          <SettingRow title="Show the bot's cursor" description={CURSOR_DESCRIPTION}>
            <Switch label="Show the bot's cursor" checked={c.agentCursor} disabled={!c.enabled} onChange={(agentCursor) => updateComputer(c, { agentCursor })} />
          </SettingRow>
        )}
      </SettingsGroup>

      {/* both only show while something needs fixing: a missing permission (granted in About), or no backend */}
      {!allGranted && !lacks.permissions ? (
        <SettingsGroup>
          <SettingRow
            title={IS_MAC ? 'Permissions needed' : 'Access to your apps'}
            description={IS_MAC ? 'macOS still has to allow some of what computer use needs.' : 'Something computer use reaches your apps through isn’t working.'}
          >
            <Button size="sm" variant="secondary" onClick={() => ui.openSettings('permissions', settingAnchorId(PERMISSIONS_TITLE))}>Open permissions</Button>
          </SettingRow>
        </SettingsGroup>
      ) : null}

      {status && !status.available ? <SettingsGroup title="Status">
        <InfoRow label="Backend">
          {status ? BACKEND_LABEL[status.backend] : '-'}
        </InfoRow>
        <InfoRow label="Available">
          {status ? (status.available ? <Badge tone="success">Ready</Badge> : <Badge tone="warning">Unavailable</Badge>) : '-'}
        </InfoRow>
        {status?.screen ? (
          <InfoRow label="Screen" mono>
            {status.screen.width} × {status.screen.height} @{status.screen.scale}x
          </InfoRow>
        ) : null}
        {status ? (
          <InfoRow label="Activity">
            {status.paused ? <Badge tone="warning">Paused</Badge> : status.busy ? <Badge tone="accent">In use</Badge> : <Badge tone="neutral">Idle</Badge>}
          </InfoRow>
        ) : null}
      </SettingsGroup> : null}
    </div>
  );
}
