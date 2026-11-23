import { useEffect, useRef, useState } from 'react';
import { PhoneAppCodes } from './PhoneApps';
import { Check, RefreshCw, Smartphone, Wifi } from '../../components/ui/icons';
import { PAIRED_DEVICES_MAX, type Device, type PairingInfo } from '@appubot/protocol';
import { Badge, Button, Icon, SettingsCard, Spinner, cn, type BadgeTone } from '../../components/ui';
import { toastCallError } from '../../lib/actions';
import { useCloud } from '../cloud/cloudAccount';
import { PairSignIn } from './PairSignIn';
import { GatewayError, rpc } from '../../lib/gateway';
import { useNow } from '../../lib/hooks';
import { THIS_MACHINE } from '../../lib/platform';
import { setState, useStore } from '../../lib/store';
import { TailscaleGuide } from './TailscaleGuide';
import { loadSystemInfo } from './TailscaleSettingRow';

/* ---------- session bookkeeping shared across mounts (StrictMode-safe) ---------- */
let inflight: Promise<PairingInfo | 'sign_in' | undefined> | null = null;
let mountCount = 0;
let cancelTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Start a pairing. `sign_in`: this computer isn't signed in to AppuBot, which pairing needs (the core refuses with
 * `sign_in_required`): the views show Sign in instead of a code and start again once signed in.
 */
function startPairing(): Promise<PairingInfo | 'sign_in' | undefined> {
  const p = rpc('pairing.start', { ttlSec: 300 }).then(
    (info) => {
      if (info && inflight === p) setState({ pairing: info });
      return info;
    },
    (e: unknown) => {
      if (e instanceof GatewayError && e.code === 'sign_in_required') return 'sign_in' as const;
      toastCallError(e, 'Could not start pairing');
      return undefined;
    },
  );
  inflight = p;
  return p;
}

const HOST_TONE: Record<PairingInfo['hosts'][number]['kind'], BadgeTone> = {
  tailscale: 'success', magicdns: 'success', lan: 'neutral', loopback: 'warning',
};
const HOST_LABEL: Record<PairingInfo['hosts'][number]['kind'], string> = {
  tailscale: 'Tailscale', magicdns: 'MagicDNS', lan: 'Wi-Fi', loopback: 'Loopback',
};

/**
 * A pairing session while mounted (shared across views, cancelled when the last one goes): the code, its QR, the
 * countdown, and the phone that paired meanwhile. PairingView draws it for Settings, onboarding's Pair step its own way.
 */
export function usePairingSession(onConnected?: (device: Device) => void) {
  const pairing = useStore((s) => s.pairing);
  const devices = useStore((s) => s.devices);
  const now = useNow(1000);

  // Snapshot of what existed when the view opened, so we can spot the newly paired device.
  const hydrated = useStore((s) => s.hydrated);
  const [baseline] = useState(() => ({ at: Date.now(), hydrated, ids: new Set(devices.map((d) => d.id)) }));
  const [loading, setLoading] = useState(false);
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const signedIn = useCloud((s) => !!s.view?.signedIn);
  const [qr, setQr] = useState<string | null>(null);
  const [connected, setConnected] = useState<Device | null>(null);
  const connectedRef = useRef(false);
  const onConnectedRef = useRef(onConnected);
  onConnectedRef.current = onConnected;

  /* start (or reuse) a pairing session; cancel it when the last view goes away */
  useEffect(() => {
    mountCount++;
    if (cancelTimer) { clearTimeout(cancelTimer); cancelTimer = null; }
    let alive = true;
    const reuse = inflight;
    setLoading(true);
    void (reuse ?? startPairing()).then((r) => { if (alive) setNeedsSignIn(r === 'sign_in'); }).finally(() => { if (alive) setLoading(false); });
    return () => {
      alive = false;
      mountCount--;
      if (cancelTimer) clearTimeout(cancelTimer);
      cancelTimer = setTimeout(() => {
        cancelTimer = null;
        if (mountCount > 0) return;
        inflight = null;
        setState({ pairing: null });
        if (!connectedRef.current) rpc('pairing.cancel').catch(() => undefined);
      }, 120);
    };
  }, []);

  /* signed in meanwhile (the browser came back): the code now */
  useEffect(() => {
    if (!needsSignIn || !signedIn) return;
    let alive = true;
    setLoading(true);
    void startPairing().then((r) => { if (alive) setNeedsSignIn(r === 'sign_in'); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [needsSignIn, signedIn]);

  /* QR image */
  useEffect(() => {
    if (!pairing?.url) { setQr(null); return; }
    let alive = true;
    // the QR encoder loads with the first pairing (it was drawn asynchronously already)
    import('qrcode')
      .then(({ default: QRCode }) => QRCode.toDataURL(pairing.url, { margin: 1, width: 440, color: { dark: '#1f1f1f', light: '#ffffff' } }))
      .then((url) => { if (alive) setQr(url); })
      .catch(() => { if (alive) setQr(null); });
    return () => { alive = false; };
  }, [pairing?.url]);

  /* detect the newly paired device */
  useEffect(() => {
    if (connectedRef.current) return;
    const fresh = devices
      // pairedAt after we opened (small slack for clock skew), or an id we hadn't seen (only trustworthy if the list was loaded)
      .filter((d) => d.pairedAt > baseline.at - 5_000 || (baseline.hydrated && !baseline.ids.has(d.id)))
      .sort((a, b) => b.pairedAt - a.pairedAt)[0];
    if (!fresh) return;
    connectedRef.current = true;
    setConnected(fresh);
    onConnectedRef.current?.(fresh);
  }, [devices, baseline]);

  const regenerate = async () => {
    setLoading(true);
    setNeedsSignIn((await startPairing()) === 'sign_in');
    setLoading(false);
  };

  const remaining = pairing ? pairing.expiresAt - now : 0;
  return {
    pairing, qr, loading, regenerate, remaining,
    /** this computer must sign in to AppuBot before it can pair a phone */
    needsSignIn,
    expired: !!pairing && remaining <= 0,
    /** the phone that paired while this was open (as it is now in the list) */
    connected: connected ? devices.find((d) => d.id === connected.id) ?? connected : null,
  };
}

/** "4:59" */
export function countdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function PairingView({ onConnected, className }: { onConnected?: (device: Device) => void; className?: string }) {
  const tailscale = useStore((s) => s.system?.tailscale);
  const systemLoaded = useStore((s) => !!s.system);
  useEffect(() => { if (!systemLoaded) void loadSystemInfo(); }, [systemLoaded]);
  const { pairing, qr, loading, regenerate, remaining, expired, connected, needsSignIn } = usePairingSession(onConnected);
  const full = useStore((s) => s.devices.length >= PAIRED_DEVICES_MAX);

  if (needsSignIn) return <PairSignIn className={className} />;

  if (connected) {
    const live = connected;
    return (
      <div className={cn('flex flex-col items-center gap-3 px-4 py-10 text-center', className)}>
        <div className="flex size-14 items-center justify-center rounded-full bg-success-soft text-success">
          <Icon icon={Check} size={28} />
        </div>
        <div className="font-display text-[19px] font-medium tracking-heading text-fg">Phone connected</div>
        <div className="flex items-center gap-1.5 text-copy text-fg-2">
          <Icon icon={Smartphone} size={16} className="text-muted" />
          {live.name}
        </div>
        <p className="max-w-[320px] text-copy leading-relaxed text-muted">
          You can now chat with your bots, approve actions and watch live from your phone.
        </p>
      </div>
    );
  }

  const digits = pairing?.code.split('') ?? [];

  return (
    <div className={cn('flex flex-col items-center gap-4', className)}>
      <div className="relative">
        <div className="flex size-[212px] items-center justify-center rounded-[14px] bg-white p-2.5 shadow-[0_0_0_.5px_rgba(0,0,0,.14),0_8px_28px_-12px_rgba(0,0,0,.25)]">
          {qr && pairing ? (
            <img src={qr} alt="Pairing QR code" width={192} height={192} className={cn('size-[192px] transition-[filter,opacity] duration-200', expired && 'opacity-25 blur-[3px]')} draggable={false} />
          ) : (
            <Spinner size={20} className="text-[#999]" />
          )}
        </div>
        {expired ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
            <span className="text-ui font-medium text-[#3d3d3d]">Code expired</span>
            <Button size="sm" variant="primary" icon={RefreshCw} loading={loading} onClick={() => void regenerate()} className="!bg-[#0d0d0d] !text-white">New code</Button>
          </div>
        ) : null}
      </div>

      <div className="flex flex-col items-center gap-2">
        <div className="selectable flex items-center gap-1" aria-label={pairing ? `Pairing code ${pairing.code}` : 'Pairing code loading'}>
          {(digits.length ? digits : Array.from({ length: 6 }, () => '')).map((d, i) => (
            <span
              key={i}
              className={cn(
                'flex h-10 w-8 items-center justify-center rounded-[8px] bg-surface-2 font-mono text-[20px] font-medium text-fg shadow-[inset_0_0_0_.5px_var(--ab-hairline),inset_0_-1px_0_var(--ab-hairline)]',
                i === 3 && 'ml-2',
                expired && 'text-muted line-through',
              )}
            >
              {d}
            </span>
          ))}
        </div>
        <div className="flex h-6 items-center gap-2 text-note text-muted">
          {pairing && !expired ? (
            <>
              <span>Expires in <span className="tabular-nums text-fg-2">{countdown(remaining)}</span></span>
              <span aria-hidden>·</span>
              <button type="button" className="text-fg-2 underline decoration-[var(--ab-hairline)] underline-offset-2 hover:text-fg disabled:opacity-50" disabled={loading} onClick={() => void regenerate()}>
                New code
              </button>
            </>
          ) : !pairing && !loading ? (
            <Button size="xs" variant="secondary" icon={RefreshCw} onClick={() => void regenerate()}>Generate code</Button>
          ) : expired ? (
            <span>This code can no longer be used.</span>
          ) : (
            <span>Generating a code…</span>
          )}
        </div>
      </div>

      {/* no app on the phone yet: the stores' codes */}
      <div className="flex flex-col items-center gap-1 pt-1">
        <div className="text-note text-muted">Don’t have the app yet? Point your phone’s camera at one of these</div>
        <PhoneAppCodes size={64} />
      </div>

      {full ? (
        <div className="flex max-w-[360px] items-start gap-2.5 rounded-control-lg bg-warning-soft px-3.5 py-2.5 text-note leading-snug text-warning">
          <Icon icon={Smartphone} size={15} className="mt-px shrink-0" />
          <span>{pairedFullText()}</span>
        </div>
      ) : null}

      <p className="max-w-[340px] text-center text-copy leading-relaxed text-fg-2">
        Open AppuBot on your phone → <span className="font-medium text-fg">Pair</span> → scan this code, or type the 6 digits.
      </p>

      {pairing?.hosts.length ? (
        <div className="flex w-full flex-col gap-2">
          <SettingsCard className="text-left">
            <div className="px-3.5 pt-2.5 pb-2 text-note font-medium text-muted">Your phone will try</div>
            {pairing.hosts.map((h) => (
              <div key={`${h.kind}-${h.host}-${h.port}`} className="flex h-9 items-center gap-2.5 px-3.5">
                <Badge tone={HOST_TONE[h.kind]} className="w-[72px] justify-center">{HOST_LABEL[h.kind]}</Badge>
                <span className="selectable min-w-0 truncate font-mono text-note text-fg-2">{h.host}:{h.port}</span>
              </div>
            ))}
            {pairing.connectId ? (
              <div className="flex h-9 items-center gap-2.5 px-3.5">
                <Badge tone="accent" className="w-[72px] justify-center">Connect</Badge>
                <span className="min-w-0 truncate text-note text-fg-2">From anywhere, encrypted end to end</span>
              </div>
            ) : null}
          </SettingsCard>
          {pairing.connectId ? (
            <p className="px-1 text-center text-note leading-snug text-muted">Your phone reaches {THIS_MACHINE} from anywhere through AppuBot Connect, and directly on the same Wi-Fi.</p>
          ) : (tailscale ? !tailscale.running : !pairing.hosts.some((h) => h.kind === 'tailscale' || h.kind === 'magicdns')) ? (
            <div className="flex items-start gap-2.5 rounded-control-lg bg-warning-soft px-3.5 py-2.5 text-note leading-snug text-warning">
              <Icon icon={Wifi} size={15} className="mt-px shrink-0" />
              <span>
                {tailscale?.installed === false
                  ? `Your phone can connect while it’s on ${THIS_MACHINE}’s Wi-Fi. To reach it from anywhere, set up Tailscale on ${THIS_MACHINE} and your phone.`
                  : `Tailscale is off on ${THIS_MACHINE}, so for now your phone connects only on the same Wi-Fi. Turn it on here and on your phone to reach it from anywhere.`}
              </span>
            </div>
          ) : (
            <p className="px-1 text-center text-note leading-snug text-muted">
              On the same Wi-Fi your phone connects directly; elsewhere it goes over Tailscale.
            </p>
          )}
        </div>
      ) : null}

      <TailscaleGuide compact defaultOpen={tailscale ? !tailscale.installed : false} />
    </div>
  );
}

/** Shown over the code while this computer keeps the most devices it allows (`PAIRED_DEVICES_MAX`). */
export function pairedFullText(): string {
  return `${PAIRED_DEVICES_MAX} devices are paired, the most ${THIS_MACHINE} keeps. Remove one in Settings › Devices to add a new one; a phone paired before can pair again.`;
}
