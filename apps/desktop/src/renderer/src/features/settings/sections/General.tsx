import { useState } from 'react';
import { type PowerStatus, type Settings, offersFastMode } from '@appubot/protocol';
import { Button, Select, Switch } from '../../../components/ui';
import { call } from '../../../lib/actions';
import { getState, macSettingsOf, setState, useStore } from '../../../lib/store';
import { updateMacSettings, useMacSetting } from '../../../lib/thisMac';
import { IS_MAC, PLATFORM, THIS_MACHINE } from '../../../lib/platform';
import { LOCALES, localeInfo, machineParams, setLanguage, systemLocale, useLanguageSetting, useT, type LanguageSetting } from '../../../lib/i18n';
import { ModelPicker } from '../../providers/ModelPicker';
import { PermissionPicker } from '../../providers/PermissionPicker';
import { keepAwakeTitle, openAtLoginTitle } from '../nav';
import { useNotificationAccess } from '../../notifications/access';
import { SectionLoading, SettingRow, SettingsGroup, SettingsSegmented, updateSettings } from './shared';
import { useCloudLacks } from '../../cloud/useCloudLacks';
import { useThisComputer } from '../../cloud/thisComputer';

/** The "Chat shows" switch is hidden for now: chats show answers only (the Mac moves saved settings back to it). */
const SHOW_CHAT_VIEW = false;

const chatViews = (t: ReturnType<typeof useT>): { value: Settings['chatView']; label: string }[] => [
  { value: 'answers', label: t('general.chatShows.answers') },
  { value: 'everything', label: t('general.chatShows.everything') },
];

/**
 * Settings › General › Language: Automatic (the system's language, named) or one of ours by its own name. A
 * device-local preference (lib/i18n.ts), applied at once.
 */
function LanguageGroup() {
  const t = useT();
  const setting = useLanguageSetting();
  const auto = localeInfo(systemLocale());
  return (
    <SettingsGroup title={t('general.language')}>
      <SettingRow title={t('general.language.title')} description={t('general.language.desc', machineParams())}>
        <Select fit aria-label={t('general.language.title')} value={setting} onChange={(e) => setLanguage(e.target.value as LanguageSetting)}>
          <option value="auto">{t('general.language.auto', { name: auto.native })}</option>
          {LOCALES.map((l) => <option key={l.code} value={l.code}>{l.native}</option>)}
        </Select>
      </SettingRow>
    </SettingsGroup>
  );
}

/** the Mac's password prompt may stay up a while: don't call it failed (and let a second click in) after the usual minute */
const PASSWORD_WAIT_MS = 15 * 60_000;

const LID_STATUS: Partial<Record<PowerStatus['lidClosed'], string>> = {
  // only macOS has a setup step (its sudoers rule); Linux reports `setup` when there is no systemd-logind to ask
  setup: IS_MAC ? 'Needs the Mac’s password once to finish setting up.' : 'Needs systemd-logind, which this computer doesn’t have.',
  'paused-battery': 'Paused: the battery is low. It resumes on power or above 20%.',
  'paused-heat': 'Paused while the Mac is running hot.',
};

/**
 * How lid mode works here: macOS switches system sleep off (pmset, after the Mac's password once); Windows sets the
 * power plan's lid action to "Do nothing" and its sleep timer to never, and puts both back afterwards; Linux holds a
 * systemd-logind lock while AppuBot runs.
 */
const OS_KEY = IS_MAC ? 'mac' : PLATFORM === 'win32' ? 'win' : 'linux';

function PowerGroup({ settings }: { settings: Settings }) {
  const t = useT();
  const status = useStore((s) => s.system?.power);
  const [busy, setBusy] = useState(false);
  const lid = settings.power.keepAwake && settings.power.lidClosed;
  const note = status?.lidClosed === 'error' ? status.error : status ? LID_STATUS[status.lidClosed] : undefined;

  // through power.setLidClosed, not settings.update: the first time it asks for the Mac's password
  const setLid = async (on: boolean, forgetRule?: boolean) => {
    setBusy(true);
    const res = await call('power.setLidClosed', { on, ...(forgetRule ? { forgetRule } : {}) }, {
      errorTitle: on ? `Could not keep ${THIS_MACHINE} awake with the lid closed` : 'Could not change this',
      timeoutMs: PASSWORD_WAIT_MS,
    });
    if (res) setState((s) => (s.system ? { system: { ...s.system, power: res } } : {}));
    setBusy(false);
  };

  return (
    <SettingsGroup title={t('general.power')} description={t('general.power.desc')}>
      <SettingRow title={keepAwakeTitle()} description={t('general.keepAwake.desc')}>
        <Switch
          label={keepAwakeTitle()}
          checked={settings.power.keepAwake}
          onChange={(keepAwake) => void updateSettings({ power: { ...settings.power, keepAwake } })}
        />
      </SettingRow>
      <SettingRow
        title={t('general.lid')}
        description={
          <>
            {t('general.lid.desc')} {t(`general.lid.how.${OS_KEY}`)}
            {note && (lid || status?.lidClosed === 'error') ? <span className="mt-1 block text-fg-2">{note}</span> : null}
          </>
        }
      >
        {lid && status?.lidClosed === 'setup' && IS_MAC ? (
          <Button size="sm" variant="secondary" loading={busy} onClick={() => void setLid(true)}>{t('general.lid.setup')}</Button>
        ) : null}
        {/* only macOS installs something (its sudoers rule) that can be removed */}
        {!lid && status?.lidRule && IS_MAC ? (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void setLid(false, true)}>{t('general.lid.remove')}</Button>
        ) : null}
        <Switch label={t('general.lid')} checked={lid} disabled={!settings.power.keepAwake || busy} onChange={(on) => void setLid(on)} />
      </SettingRow>
    </SettingsGroup>
  );
}

/** the Agents rows' pickers hug what they say, and give way (the profile's name truncating) before the row's title does */
const AGENT_CONTROL = 'sm:min-w-0 sm:max-w-[60%] sm:shrink';

export function GeneralSection() {
  const t = useT();
  const settings = useStore((s) => s.settings);
  const lacks = useCloudLacks();
  const computer = useThisComputer();
  if (!settings) return <SectionLoading />;

  return (
    <div className="space-y-6">
      <LanguageGroup />

      {SHOW_CHAT_VIEW ? <SettingsGroup title={t('general.chats')}>
        <SettingRow
          title={t('general.chatShows')}
          description={settings.chatView === 'answers' ? t('general.chatShows.answers.desc') : t('general.chatShows.everything.desc')}
        >
          <SettingsSegmented label={t('general.chatShows')} options={chatViews(t)} value={settings.chatView} onChange={(chatView) => void updateSettings({ chatView })} />
        </SettingRow>
      </SettingsGroup> : null}

      <SettingsGroup title={t('general.agents')}>
        <SettingRow title={t('general.model')} description={t('general.model.desc')} controlClassName={AGENT_CONTROL}>
          <ModelPicker
            context="defaults"
            label={t('general.model')}
            className="w-full sm:w-auto sm:max-w-[24rem]"
            align="end"
            providerId={settings.defaultProviderId}
            modelId={settings.defaultModelId}
            effort={settings.defaultEffort}
            defaultEffort="medium"
            fast={settings.defaultFast}
            fastAvailable={offersFastMode(settings.defaultProviderId)}
            // another agent has other models: the one picked there, else its own default
            onChange={(n) => void updateSettings({
              ...(n.providerId && n.providerId !== settings.defaultProviderId ? { defaultProviderId: n.providerId, defaultModelId: n.modelId ?? '' } : n.modelId !== undefined ? { defaultModelId: n.modelId } : {}),
              ...(n.effort !== undefined ? { defaultEffort: n.effort } : {}),
              ...(n.fast !== undefined ? { defaultFast: n.fast } : {}),
            })}
          />
        </SettingRow>
        <SettingRow title={t('general.permissions')} description={t('general.permissions.desc')} controlClassName={AGENT_CONTROL}>
          <PermissionPicker
            generic
            label={t('general.permissions')}
            className="w-full sm:w-auto sm:max-w-[24rem]"
            align="end"
            providerId={settings.defaultProviderId}
            value={settings.defaultModeId}
            onChange={(defaultModeId) => void updateSettings({ defaultModeId })}
          />
        </SettingRow>
      </SettingsGroup>

      {/* the cloud computer never sleeps on its own terms: no power or lid settings there */}
      {lacks.power ? null : <PowerGroup settings={settings} />}

      <NotificationsGroup settings={settings} />

      {/* opening at login is this app's own, also with an AppuBot computer on screen (it used to be hidden there,
          so someone who works only in the cloud couldn't change it) */}
      <StartupGroup remote={computer.remote} />
    </div>
  );
}

function NotificationsGroup({ settings }: { settings: Settings }) {
  const t = useT();
  const access = useNotificationAccess();
  // desktop notifications are this Mac's own switch, whichever computer is on screen: a remote computer shows none of
  // its own, what its bots do is shown by this Mac (the row used to be hidden there); phone notifications are the
  // screen computer's
  const desktop = useStore((s) => macSettingsOf(s)?.notifications.desktop);
  const blocked = !!desktop && (access === 'off' || access === 'not-asked');
  const setDesktop = (on: boolean) => {
    const mac = macSettingsOf(getState());
    if (mac) void updateMacSettings({ notifications: { ...mac.notifications, desktop: on } });
  };
  return (
    <SettingsGroup title={t('general.notifications')}>
      {desktop === undefined ? null : <SettingRow
        title={t('general.desktopNotifications')}
        description={blocked
          // when the OS won't show them: on macOS, AppuBot is off (or never allowed) in System Settings › Notifications
          ? <span className="text-warning">{t(`general.notifications.blocked.${OS_KEY}`)}</span>
          : t('general.desktopNotifications.desc')}
      >
        <Switch
          label={t('general.desktopNotifications')}
          checked={desktop}
          onChange={setDesktop}
        />
      </SettingRow>}
      <SettingRow title={t('general.phoneNotifications')} description={t('general.phoneNotifications.desc')}>
        <Switch
          label={t('general.phoneNotifications')}
          checked={settings.notifications.mobile}
          onChange={(mobile) => void updateSettings({ notifications: { ...settings.notifications, mobile } })}
        />
      </SettingRow>
    </SettingsGroup>
  );
}

function StartupGroup({ remote }: { remote: boolean }) {
  const t = useT();
  // this Mac's own setting (lib/thisMac.ts); with an AppuBot computer on screen the routines run there, so the line
  // says what opening at login is for here
  const on = useMacSetting((s) => s.launchAtLogin as boolean | undefined, undefined);
  if (on === undefined) return null;
  return (
    <SettingsGroup title={t('general.startup')}>
      <SettingRow title={openAtLoginTitle()} description={t(remote ? 'general.openAtLogin.cloud' : IS_MAC ? 'general.openAtLogin.menubar' : 'general.openAtLogin.tray')}>
        <Switch
          label={openAtLoginTitle()}
          checked={on}
          onChange={(launchAtLogin) => void updateMacSettings({ launchAtLogin })}
        />
      </SettingRow>
    </SettingsGroup>
  );
}
