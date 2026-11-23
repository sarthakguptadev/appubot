/**
 * Pictures of what macOS shows when AppuBot asks for something, so onboarding's Permissions step can say "press this":
 * System Settings › Privacy & Security with AppuBot's switch (Accessibility, Screen Recording), the notification
 * request at the top right, and the microphone alert. Drawn here (no screenshots), in macOS's light and dark colours,
 * with a pointer that presses the right thing in a loop (still under Reduce motion). Once granted, the switch is on.
 */
import type { ReactNode } from 'react';
import { AccessibilityPerson, Check, ChevronDown, ChevronLeft, ChevronRight, Hand, MonitorUp, Search } from '../../components/ui/icons';
import { Icon, Logo, cn } from '../../components/ui';
import './onboarding.css';

/** macOS's arrow pointer, its tip at (2, 2) */
function Pointer({ className }: { className?: string }) {
  return (
    <svg width="17" height="24" viewBox="0 0 17 24" className={cn('pointer-events-none absolute drop-shadow-[0_2px_3px_rgba(0,0,0,.3)]', className)} aria-hidden>
      <path d="M2 2v17.2l4.3-4.1 2.9 6.6 2.9-1.3-2.9-6.4h6.1z" fill="#000" stroke="#fff" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

/** "Turn this on": the orange label pointing at what to press */
function Callout({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn('pointer-events-none absolute z-10 rounded-full bg-[var(--m-callout)] px-2 py-[3px] text-[10.5px] font-semibold whitespace-nowrap text-white shadow-[0_4px_12px_-4px_rgba(0,0,0,.35)]', className)}>
      {children}
    </span>
  );
}

/** The desktop the window sits on: a soft wallpaper filling the stage. */
export function MacStage({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('ob-mac relative isolate overflow-hidden rounded-[14px] bg-[image:var(--m-wall)] font-sans text-[var(--m-text)] select-none', className)} aria-hidden>
      {children}
    </div>
  );
}

function TrafficLights() {
  return (
    <div className="flex gap-[5px]">
      {['#ff5f57', '#febc2e', '#28c840'].map((c) => <span key={c} className="size-[8px] rounded-full" style={{ background: c }} />)}
    </div>
  );
}

/** The macOS switch: grey off, blue on (the loop flips it while the pointer presses). */
function MacSwitch({ on, loop, className }: { on: boolean; loop?: boolean; className?: string }) {
  return (
    <span className={cn('ob-switch relative inline-flex h-[15px] w-[26px] shrink-0 rounded-full p-[1px] transition-colors', className)} data-on={on || undefined} data-loop={loop || undefined}>
      <span className="ob-knob block size-[13px] rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,.3)] transition-transform" />
    </span>
  );
}

const SIDEBAR: { label: string; color: string; icon?: typeof Hand; selected?: boolean; gap?: boolean }[] = [
  { label: 'Wi‑Fi', color: '#0a84ff' },
  { label: 'Bluetooth', color: '#0a84ff' },
  { label: 'Network', color: '#0a84ff' },
  { label: 'General', color: '#8e8e93', gap: true },
  { label: 'Accessibility', color: '#0a84ff', icon: AccessibilityPerson },
  { label: 'Privacy & Security', color: '#0a84ff', icon: Hand, selected: true },
  { label: 'Desktop & Dock', color: '#3a3a3c' },
  { label: 'Displays', color: '#0a84ff' },
];

const PANES = {
  accessibility: { title: 'Accessibility', text: 'Allow the applications below to control your computer.' },
  screen_recording: { title: 'Screen & System Audio Recording', text: 'Allow the applications below to record the content of your screen and audio.' },
} as const;

/** An app's row in the pane's list: its icon, name and switch. */
function AppRow({ icon, name, on, children, className }: { icon: ReactNode; name: string; on: boolean; children?: ReactNode; className?: string }) {
  return (
    <div className={cn('relative flex h-[30px] items-center gap-2 px-2.5', className)}>
      {icon}
      <span className="min-w-0 flex-1 truncate text-[11px]">{name}</span>
      {children ?? <MacSwitch on={on} />}
    </div>
  );
}

/**
 * System Settings › Privacy & Security › Accessibility (or Screen Recording): the list of apps, AppuBot's switch
 * ringed and pressed by the pointer with "Turn this on"; `on` once macOS reports it granted.
 */
export function SettingsPaneMock({ pane, on }: { pane: keyof typeof PANES; on: boolean }) {
  const p = PANES[pane];
  return (
    <MacStage className="h-full w-full">
      <div className={cn('absolute top-1/2 left-1/2 flex h-[226px] w-[396px] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-[11px] bg-[var(--m-win)] shadow-[var(--m-shadow)] [@media(max-height:720px)]:scale-[.82]', !on && 'ob-loop')}>
        {/* sidebar */}
        <div className="flex w-[124px] shrink-0 flex-col bg-[var(--m-side)] px-1.5 pt-2.5">
          <div className="px-1"><TrafficLights /></div>
          <div className="mt-2.5 flex h-[18px] items-center gap-1 rounded-[5px] bg-[var(--m-field)] px-1.5 text-[9.5px] text-[var(--m-muted)]">
            <Icon icon={Search} size={9} />Search
          </div>
          <div className="mt-1.5 flex flex-col">
            {SIDEBAR.map((s) => (
              <div key={s.label} className={cn('flex h-[19px] items-center gap-1.5 rounded-[5px] px-1 text-[9.5px]', s.gap && 'mt-1.5', s.selected && 'bg-[var(--m-blue)] text-white')}>
                <span className="flex size-[12px] shrink-0 items-center justify-center rounded-[3px] text-white" style={{ background: s.selected ? 'rgba(255,255,255,.25)' : s.color }}>
                  {s.icon ? <s.icon size={8} strokeWidth={2.4} /> : null}
                </span>
                <span className="truncate">{s.label}</span>
              </div>
            ))}
          </div>
        </div>
        {/* the pane */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-[32px] shrink-0 items-center gap-1.5 px-2.5">
            <span className="flex text-[var(--m-muted)]"><ChevronLeft size={12} strokeWidth={2.2} /><ChevronRight size={12} strokeWidth={2.2} className="opacity-40" /></span>
            <span className="truncate text-[11.5px] font-semibold">{p.title}</span>
          </div>
          <div className="px-3 pt-0.5">
            <p className="text-[9.5px] leading-snug text-[var(--m-muted)]">{p.text}</p>
            <div className="mt-2 rounded-[7px] bg-[var(--m-group)] shadow-[0_0_0_.5px_var(--m-line)] [&>*+*]:shadow-[inset_0_.5px_0_var(--m-line)]">
              <AppRow name="Terminal" on icon={<span className="flex size-[16px] items-center justify-center rounded-[4px] bg-[#1c1c1e] font-mono text-[7px] font-bold text-[#e5e5ea] shadow-[inset_0_0_0_.5px_rgba(255,255,255,.2)]">&gt;_</span>} />
              <AppRow name="AppuBot" on={on} icon={<Logo size={16} className="rounded-[4px]" />}>
                <span className={cn('relative rounded-full', !on && 'ob-ring')}>
                  <MacSwitch on={on} />
                </span>
                {!on ? (
                  <>
                    <Callout className="top-1/2 right-[44px] -translate-y-1/2">Turn this on</Callout>
                    <Pointer className="ob-pointer top-[13px] right-[2px]" />
                  </>
                ) : null}
              </AppRow>
              <AppRow name="Shortcuts" on icon={<span className="size-[16px] rounded-[4px] bg-[linear-gradient(135deg,#ff5e8a,#8f5cff_55%,#2f9bff)]" />} />
            </div>
            <div className="mt-1.5 flex gap-0.5 text-[11px] leading-none text-[var(--m-muted)]"><span className="px-1">+</span><span className="px-1">−</span></div>
          </div>
        </div>
      </div>
    </MacStage>
  );
}

/** macOS's notification request at the top right: Options ⌄ opened, Allow under the pointer. */
export function NotificationPromptMock({ on }: { on: boolean }) {
  return (
    <MacStage className="h-full w-full">
      <MenuBar />
      <div className={cn('absolute top-[30px] right-[14px] w-[300px] origin-top-right [@media(max-height:720px)]:top-[26px] [@media(max-height:720px)]:scale-[.86]', !on && 'ob-loop')}>
        <div className="flex items-start gap-2.5 rounded-[14px] bg-[var(--m-banner)] p-2.5 shadow-[var(--m-shadow)] backdrop-blur-xl">
          <Logo size={30} className="mt-0.5 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="text-[10.5px] leading-snug font-semibold">“AppuBot” Would Like to Send You Notifications</div>
            <div className="mt-0.5 text-[9.5px] leading-snug text-[var(--m-muted)]">Notifications may include alerts, sounds and icon badges.</div>
          </div>
          {on ? (
            <span className="mt-0.5 flex h-[20px] items-center gap-1 rounded-[6px] px-1.5 text-[9.5px] font-medium text-[#28a745]"><Check size={10} strokeWidth={2.6} />Allowed</span>
          ) : (
            <span className="mt-0.5 flex h-[20px] shrink-0 items-center gap-0.5 rounded-[6px] bg-[var(--m-button)] px-2 text-[10px] font-medium">Options<ChevronDown size={9} strokeWidth={2.4} /></span>
          )}
        </div>
        {!on ? (
          <div className="relative mt-1 ml-auto w-[112px] rounded-[8px] bg-[var(--m-banner)] p-1 shadow-[var(--m-shadow)] backdrop-blur-xl">
            <div className="relative">
              <div className="ob-hover rounded-[4px] px-2 py-[3px] text-[10.5px]">Allow</div>
              <Pointer className="ob-pointer top-[5px] left-[64px]" />
              <Callout className="top-1/2 right-[calc(100%+12px)] -translate-y-1/2">Choose Allow</Callout>
            </div>
            <div className="rounded-[4px] px-2 py-[3px] text-[10.5px]">Don’t Allow</div>
          </div>
        ) : null}
      </div>
    </MacStage>
  );
}

/** macOS's microphone alert: AppuBot's icon, the reason from Info.plist, Allow under the pointer. */
export function MicPromptMock({ on }: { on: boolean }) {
  return (
    <MacStage className="h-full w-full">
      <div className={cn('absolute top-1/2 left-1/2 w-[236px] -translate-x-1/2 -translate-y-1/2 rounded-[12px] bg-[var(--m-alert)] px-4 pt-4 pb-3 text-center shadow-[var(--m-shadow)] [@media(max-height:720px)]:scale-[.84]', !on && 'ob-loop')}>
        <Logo size={44} className="mx-auto" />
        <div className="mt-2 text-[11px] leading-snug font-semibold">“AppuBot” would like to access the microphone.</div>
        <div className="mt-1 text-[9.5px] leading-snug text-[var(--m-muted)]">AppuBot listens when you talk to a bot by voice.</div>
        <div className="mt-3 grid grid-cols-2 gap-1.5">
          <span className="flex h-[22px] items-center justify-center rounded-[6px] bg-[var(--m-button)] text-[10.5px] font-medium">Don’t Allow</span>
          <span className="relative">
            <span className={cn('ob-press flex h-[22px] items-center justify-center gap-1 rounded-[6px] bg-[var(--m-blue)] text-[10.5px] font-medium text-white', !on && 'ob-ring')}>
              {on ? <Check size={10} strokeWidth={2.6} /> : null}Allow
            </span>
            {!on ? <Pointer className="ob-pointer top-[10px] left-[52px]" /> : null}
          </span>
        </div>
      </div>
    </MacStage>
  );
}

/** The menu bar along the stage's top, so a notification reads as being at the screen's corner. */
function MenuBar() {
  return (
    <div className="absolute inset-x-0 top-0 flex h-[18px] items-center gap-3 bg-[var(--m-menubar)] px-3 text-[9.5px] backdrop-blur-md">
      <span className="font-semibold">AppuBot</span>
      <span>File</span><span>Edit</span><span>View</span><span>Window</span>
      <span className="ml-auto flex items-center gap-2.5"><Icon icon={MonitorUp} size={10} /><span>9:41</span></span>
    </div>
  );
}
