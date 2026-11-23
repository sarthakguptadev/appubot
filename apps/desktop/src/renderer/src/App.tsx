import { lazy, Suspense, useEffect, useRef } from 'react';
import { MotionConfig } from 'motion/react';
import { ConnectionOverlay, Splash } from './components/layout/Connection';
import { UpdateRequired } from './components/layout/UpdateRequired';
import { MainLayout } from './components/layout/MainLayout';
import { ModalHost } from './components/layout/ModalHost';
import { Toaster } from './features/notifications/Toaster';
import { TooltipHost } from './components/ui/Tooltip';
import { useGatewayBoot } from './lib/boot';
import { useThemeSync } from './lib/theme';
import { watchThisMac } from './lib/thisMac';
import { useQuitPrompt } from './lib/quit';
import { useAppearance } from './lib/appearance';
import { useI18n } from './lib/i18n';
import { getState, isVoiceBarView, ui, useStore, type SettingsSection } from './lib/store';
import { openBot } from './lib/actions';
import { rpc } from './lib/gateway';
import { native } from './lib/native';
import { reopenLastComputer, useCloudLink } from './features/cloud/cloudClient';
import { watchMacCloudOnly } from './features/cloud/cloudOnly';
import { endVoice } from './features/voice/useVoiceConversation';

// first-run setup only: its code loads when it is shown (the splash stays up meanwhile)
const Onboarding = lazy(() => import('./features/onboarding/Onboarding').then((m) => ({ default: m.Onboarding })));

export default function App() {
  const { error } = useGatewayBoot();
  useThemeSync();
  useAppearance(); // after the theme hook: its data-glass default is set first
  useI18n();
  useQuitPrompt();
  // a call opened from the menu bar ends voice mode here (one conversation at a time)
  useEffect(() => native().onEndVoice(() => { if (getState().voiceMode) endVoice(); }), []);
  // the menu bar menu's Settings… and bot items open their place here
  useEffect(() => native().onNavigate(({ to, id }) => {
    // mid-setup there are no Settings to open: the browser coming back from a sign-in or a checkout is followed by
    // setup's own screen (and Settings left open behind it would be the first thing seen after)
    if (to === 'settings') { if (getState().settings?.onboarded || useCloudLink.getState().computer === 'cloud') ui.openSettings((id as SettingsSection | 'cloud' | undefined) ?? 'general'); }
    else if (id) openBot(id);
  }), []);
  const hydrated = useStore((s) => s.hydrated);
  const onboarded = useStore((s) => s.settings?.onboarded ?? false);
  // first-run setup is this computer's (its agents, its permissions, a phone for it): a cloud computer on screen is
  // ready as it comes, so the app shows for it, and it is told it is set up, which makes its first bot say hello
  const onCloud = useCloudLink((s) => s.computer === 'cloud');
  const cloudReady = useCloudLink((s) => s.computer === 'cloud' && s.ready);
  const cloudKey = useCloudLink((s) => (s.computer === 'cloud' ? `cloud:${s.team ?? ''}` : ''));
  // a launch on its way to a cloud computer shows the splash until it is there, never this computer's bots first
  const placing = useCloudLink((s) => s.placing);
  const told = useRef(new Set<string>());
  useEffect(() => {
    if (!cloudReady || onboarded || told.current.has(cloudKey)) return;
    told.current.add(cloudKey);
    // quietly: a device that may not change settings (a limited one) just leaves it for another
    void rpc('settings.update', { onboarded: true }).catch(() => undefined);
  }, [cloudReady, onboarded, cloudKey]);
  // this Mac's "Only in the cloud", whichever computer is on screen (features/cloud/cloudOnly.ts)
  useEffect(() => (hydrated ? watchMacCloudOnly() : undefined), [hydrated]);
  // this Mac's own settings and system info (the app's update, colour scheme, notifications), whichever computer is on screen
  useEffect(() => (hydrated ? watchThisMac() : undefined), [hydrated]);
  // typing or clicking here tells main the app is in use, so a downloaded update doesn't restart it under someone
  // working on an AppuBot computer (this Mac's gateway only hears of work done on this Mac); at most every 20 s
  useEffect(() => {
    const used = native().usedApp;
    if (!used) return undefined;
    let last = 0;
    const note = () => { const now = Date.now(); if (now - last > 20_000) { last = now; used(); } };
    window.addEventListener('keydown', note, true);
    window.addEventListener('pointerdown', note, true);
    return () => { window.removeEventListener('keydown', note, true); window.removeEventListener('pointerdown', note, true); };
  }, []);
  // the computer used last comes back on screen at launch (the cloud computer, for someone who works there; always,
  // only in the cloud)
  useEffect(() => { if (hydrated && !isVoiceBarView()) void reopenLastComputer(); }, [hydrated]);

  return (
    <MotionConfig reducedMotion="user">
      {!hydrated || placing ? <Splash error={error} /> : onboarded || onCloud ? <MainLayout /> : <Suspense fallback={<Splash error={error} />}><Onboarding /></Suspense>}
      {hydrated ? <ModalHost /> : null}
      {/* a stopped version: over everything but the connection screen */}
      {hydrated ? <UpdateRequired /> : null}
      <Toaster />
      <TooltipHost />
      <ConnectionOverlay />
    </MotionConfig>
  );
}
