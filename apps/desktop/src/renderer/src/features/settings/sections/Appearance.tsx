// Settings › Appearance (T3 Code's Appearance panel, in AppuBot's terms): the colour scheme as three preview tiles,
// the background (the app's tones in a tint: packages/theme `backgrounds.ts`) as a tile each,
// the window's glass (macOS), how solid menus and the chat box are, and how chats read: maths, the send
// shortcut, 12/24-hour times, the empty chat's animated background, and whether a chat shows the bot's work as a trail. Everything but the scheme stays on this device (lib/appearance.ts).
import type { Settings } from '@appubot/protocol';
import { BACKGROUNDS, backgroundOf, type BackgroundId } from '@appubot/theme';
import { Button, Switch, cn } from '../../../components/ui';
import { GLASS_DEFAULT, GLASS_MAX, GLASS_MIN, SOLID_DEFAULT, appearance, useAppearancePrefs } from '../../../lib/appearance';
import { IS_MAC, shortcut } from '../../../lib/platform';
import { useStore } from '../../../lib/store';
import { useIsDark } from '../../../lib/theme';
import { machineParams, useT } from '../../../lib/i18n';
import { animatedBackgroundTitle, backgroundTitle, chatShowsTitle, clockTitle, colorSchemeTitle, glassOpacityTitle, mathTitle, sendShortcutTitle, shapeTitle, tooltipsTitle } from '../nav';
import { Slider } from '../Slider';
import { updateMacSettings, useMacSetting } from '../../../lib/thisMac';
import { SectionLoading, SettingRow, SettingsGroup, SettingsSegmented } from './shared';

type Theme = Settings['theme'];

/** A tile's tiny window: a sidebar, a header line and two chat bubbles, in that scheme's tones on a background. */
function Wireframe({ dark, background }: { dark: boolean; background: BackgroundId }) {
  const tones = backgroundOf(background)[dark ? 'dark' : 'light'];
  const c = dark
    ? { line: 'rgba(252,252,252,.13)', bubble: tones.raised, mine: '#c2602a' }
    : { line: 'rgba(28,28,28,.11)', bubble: 'rgba(28,28,28,.08)', mine: '#ee7944' };
  return (
    <svg viewBox="0 0 120 72" aria-hidden className="block size-full" preserveAspectRatio="none">
      <rect width="120" height="72" fill={tones.page} />
      <rect width="34" height="72" fill={tones.side} />
      <rect x="6" y="9" width="20" height="4" rx="2" fill={c.line} />
      <rect x="6" y="18" width="16" height="4" rx="2" fill={c.line} />
      <rect x="6" y="27" width="18" height="4" rx="2" fill={c.line} />
      <rect x="42" y="12" width="44" height="10" rx="5" fill={c.bubble} />
      <rect x="74" y="28" width="38" height="10" rx="5" fill={c.mine} />
      <rect x="42" y="44" width="56" height="10" rx="5" fill={c.bubble} />
    </svg>
  );
}

/** A preview tile's frame: ringed in the accent when chosen. */
const tileFrame = (on: boolean): string => cn(
  'relative block aspect-[5/3] w-full overflow-hidden rounded-card border transition-[border-color,box-shadow]',
  on
    ? 'border-[var(--ab-accent)] shadow-[0_0_0_1px_var(--ab-accent)]'
    : 'border-[color-mix(in_srgb,var(--ab-fg)_10%,transparent)] group-hover:border-[color-mix(in_srgb,var(--ab-fg)_22%,transparent)]',
  'group-focus-visible:shadow-[0_0_0_2px_var(--ab-ring)]',
);

/** The backgrounds as tiles, each drawn in its own tones for the scheme on screen; picking one repaints the app at once. */
function BackgroundTiles({ value, dark }: { value: BackgroundId; dark: boolean }) {
  const t = useT();
  return (
    <div role="radiogroup" aria-label={backgroundTitle()} className="grid w-full grid-cols-4 gap-3">
      {BACKGROUNDS.map((b) => {
        const on = b.id === value;
        const name = t(`appearance.background.${b.id}`);
        return (
          <button
            key={b.id}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={name}
            onClick={() => appearance.setBackground(b.id)}
            className="group flex flex-col gap-2 text-left outline-none"
          >
            <span className={tileFrame(on)}><Wireframe dark={dark} background={b.id} /></span>
            <span className={cn('text-copy', on ? 'font-medium text-fg' : 'text-fg-2')}>{name}</span>
          </button>
        );
      })}
    </div>
  );
}

/** T3 Code's mode tiles: System (half and half), Light and Dark, the chosen one ringed. */
function SchemeTiles({ value, background }: { value: Theme; background: BackgroundId }) {
  const t = useT();
  const schemes: { value: Theme; label: string; aria: string }[] = [
    { value: 'system', label: t('common.system'), aria: t('appearance.scheme.followAria', machineParams()) },
    { value: 'light', label: t('appearance.scheme.light'), aria: t('appearance.scheme.lightAria') },
    { value: 'dark', label: t('appearance.scheme.dark'), aria: t('appearance.scheme.darkAria') },
  ];
  return (
    <div role="radiogroup" aria-label={colorSchemeTitle()} className="grid w-full grid-cols-3 gap-3">
      {schemes.map((s) => {
        const on = s.value === value;
        return (
          <button
            key={s.value}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={s.aria}
            onClick={() => void updateMacSettings({ theme: s.value })}
            className="group flex flex-col gap-2 text-left outline-none"
          >
            <span className={tileFrame(on)}>
              {s.value === 'system' ? (
                <>
                  <span className="absolute inset-0"><Wireframe dark={false} background={background} /></span>
                  <span className="absolute inset-0 [clip-path:polygon(100%_0,100%_100%,0_100%)]"><Wireframe dark background={background} /></span>
                </>
              ) : (
                <Wireframe dark={s.value === 'dark'} background={background} />
              )}
            </span>
            <span className={cn('text-copy', on ? 'font-medium text-fg' : 'text-fg-2')}>{s.label}</span>
          </button>
        );
      })}
    </div>
  );
}

const SEND_KEYS = [
  { value: 'enter' as const, label: 'Enter' },
  { value: 'mod-enter' as const, label: shortcut('↵') },
];
export function AppearanceSection() {
  const t = useT();
  const loaded = useStore((s) => !!s.settings);
  // the colour scheme is this app's own (this Mac's setting), also with an AppuBot computer on screen
  const scheme = useMacSetting((s) => s.theme, 'system' as Theme);
  const prefs = useAppearancePrefs();
  const dark = useIsDark();
  if (!loaded) return <SectionLoading />;
  const glass = prefs.opacity ?? GLASS_DEFAULT;
  const solid = prefs.solid ?? SOLID_DEFAULT;
  // the bot's replies alone, or its work as a trail above them too (features/chat/WorkTrail.tsx)
  const shows = [
    { value: 'answers' as const, label: t('general.chatShows.answers') },
    { value: 'everything' as const, label: t('general.chatShows.everything') },
  ];
  const clocks = [
    { value: 'auto' as const, label: t('common.system') },
    { value: '12h' as const, label: t('appearance.clock.12') },
    { value: '24h' as const, label: t('appearance.clock.24') },
  ];

  return (
    <div className="space-y-6">
      <SettingsGroup title={colorSchemeTitle()} description={t('appearance.colorScheme.desc', machineParams())} bare>
        <div className="pt-1"><SchemeTiles value={scheme} background={prefs.background} /></div>
      </SettingsGroup>

      <SettingsGroup title={backgroundTitle()} description={t('appearance.background.desc')} bare>
        <div className="pt-1"><BackgroundTiles value={prefs.background} dark={dark} /></div>
      </SettingsGroup>

      <SettingsGroup title={t('appearance.interface')}>
        {/* the desktop only shows through on macOS (vibrancy): elsewhere the window is solid */}
        {IS_MAC ? (
          <>
            <SettingRow title={t('appearance.translucency')} description={t('appearance.translucency.desc')}>
              <Slider
                label={t('appearance.translucency')} min={GLASS_MIN} max={GLASS_MAX} value={glass} disabled={prefs.reduceTransparency}
                onChange={(v) => appearance.setOpacity(v)}
              />
              <span className="w-9 text-right text-copy leading-snug tabular-nums text-muted">{glass}%</span>
            </SettingRow>
            <SettingRow title={t('appearance.reduceTransparency')} description={t('appearance.reduceTransparency.desc')}>
              <Switch label={t('appearance.reduceTransparency')} checked={prefs.reduceTransparency} onChange={(v) => appearance.setReduceTransparency(v)} />
            </SettingRow>
          </>
        ) : null}
        <SettingRow title={glassOpacityTitle()} description={t('appearance.glassOpacity.desc')}>
          {prefs.solid !== null ? <Button size="xs" variant="ghost" className="text-muted" onClick={() => appearance.resetSolid()}>{t('common.reset')}</Button> : null}
          <Slider label={glassOpacityTitle()} min={0} max={100} value={solid} onChange={(v) => appearance.setSolid(v)} />
          <span className="w-9 text-right text-copy leading-snug tabular-nums text-muted">{solid}%</span>
        </SettingRow>
        <SettingRow title={shapeTitle()} description={t('appearance.shape.desc')}>
          <SettingsSegmented
            label={shapeTitle()}
            options={[{ value: 'round', label: t('appearance.shape.round') }, { value: 'squircle', label: t('appearance.shape.squircle') }]}
            value={prefs.shape}
            onChange={(v) => appearance.setShape(v)}
          />
        </SettingRow>
        <SettingRow title={tooltipsTitle()} description={t('appearance.tooltips.desc')}>
          <Switch label={tooltipsTitle()} checked={prefs.tooltips} onChange={(v) => appearance.setTooltips(v)} />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title={t('appearance.chats')}>
        <SettingRow
          title={chatShowsTitle()}
          description={prefs.workTrail ? t('general.chatShows.everything.desc') : t('general.chatShows.answers.desc')}
        >
          <SettingsSegmented
            label={chatShowsTitle()} options={shows} value={prefs.workTrail ? 'everything' : 'answers'}
            onChange={(v) => appearance.setWorkTrail(v === 'everything')}
          />
        </SettingRow>
        <SettingRow title={mathTitle()} description={t('appearance.math.desc')}>
          <Switch label={mathTitle()} checked={prefs.math} onChange={(v) => appearance.setMath(v)} />
        </SettingRow>
        <SettingRow
          title={sendShortcutTitle()}
          description={prefs.sendKey === 'enter' ? t('appearance.sendShortcut.enter') : t('appearance.sendShortcut.mod', { shortcut: shortcut('↵') })}
        >
          <SettingsSegmented label={sendShortcutTitle()} options={SEND_KEYS} value={prefs.sendKey} onChange={(k) => appearance.setSendKey(k)} />
        </SettingRow>
        <SettingRow title={clockTitle()} description={t('appearance.clock.desc')}>
          <SettingsSegmented label={clockTitle()} options={clocks} value={prefs.clock} onChange={(c) => appearance.setClock(c)} />
        </SettingRow>
        <SettingRow title={animatedBackgroundTitle()} description={t('appearance.animatedBackground.desc')}>
          <Switch label={animatedBackgroundTitle()} checked={prefs.animatedBackground} onChange={(v) => appearance.setAnimatedBackground(v)} />
        </SettingRow>
      </SettingsGroup>
    </div>
  );
}
