/**
 * Where to get the phone app, as two codes a phone's camera reads: iPhone (the App Store) and Android (Google Play), the
 * links the site's phone cards use (`lib/links.ts`). Shown wherever a phone is paired: onboarding's Pair step,
 * Settings › Devices' pairing view and its empty state. Each code is also a button that opens the link here.
 * The account menu's "Get AppuBot for mobile" opens `PhoneAppDialog`: one code for the site's phone downloads, which
 * offers the store of the phone that opens it, and the stores' own badges under it.
 */
import { useEffect, useState } from 'react';
import { ANDROID_APP_URL, IOS_APP_URL, PHONE_DOWNLOAD_URL } from '../../lib/links';
import { native } from '../../lib/native';
import { Dialog, cn } from '../../components/ui';
import appStoreBadge from '../../assets/store-badges/app-store.svg';
import googlePlayBadge from '../../assets/store-badges/google-play.png';

/** A QR of `text` as a data URL (the encoder loads with the first use), or null while it's made. */
export function useQrDataUrl(text: string, px = 320): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    import('qrcode')
      .then(({ default: QRCode }) => QRCode.toDataURL(text, { margin: 1, width: px, color: { dark: '#1f1f1f', light: '#ffffff' } }))
      .then((u) => { if (alive) setUrl(u); })
      .catch(() => { if (alive) setUrl(null); });
    return () => { alive = false; };
  }, [text, px]);
  return url;
}

const APPS = [
  { key: 'ios', url: IOS_APP_URL, device: 'iPhone', via: 'App Store', on: 'the App Store' },
  { key: 'android', url: ANDROID_APP_URL, device: 'Android', via: 'Google Play', on: 'Google Play' },
] as const;

function PhoneAppCode({ url, device, via, on, size }: { url: string; device: string; via: string; on: string; size: number }) {
  const qr = useQrDataUrl(url, size * 3);
  return (
    <button
      type="button"
      onClick={() => void native().openExternal(url)}
      title={`${device}: ${url}`}
      aria-label={`Get AppuBot for ${device} on ${on}`}
      className="group flex flex-col items-center gap-1.5 rounded-card p-1.5 text-center hover:bg-[var(--ab-ink-tint)]"
    >
      <span className="flex items-center justify-center rounded-[10px] bg-white p-1.5 shadow-[0_0_0_.5px_rgba(0,0,0,.14)]" style={{ width: size + 12, height: size + 12 }}>
        {qr ? <img src={qr} alt="" width={size} height={size} draggable={false} className="rounded-[4px]" /> : <span className="block rounded-[4px] bg-[#f0f0f0]" style={{ width: size, height: size }} />}
      </span>
      <span className="text-note font-medium leading-tight text-fg">{device}</span>
      <span className="-mt-1 text-[11px] leading-tight text-muted group-hover:text-fg-2">{via}</span>
    </button>
  );
}

/** The two codes side by side. */
export function PhoneAppCodes({ size = 88, className }: { size?: number; className?: string }) {
  return (
    <div className={cn('flex items-start justify-center gap-3', className)}>
      {APPS.map((a) => <PhoneAppCode key={a.key} url={a.url} device={a.device} via={a.via} on={a.on} size={size} />)}
    </div>
  );
}

/**
 * The stores' badges as Apple and Google publish them, unaltered: Apple's black "Download on the App Store" (its grey
 * edge keeps it clear on a dark page too) and Google's "Get it on Google Play", whose picture carries its own clear space
 * round the badge (41 of its 250px each way), drawn so both badges stand the same height.
 */
const BADGE_H = 40;
const PLAY = { h: 250, badge: 168, pad: 41 } as const;
const STORES = [
  { key: 'ios', url: IOS_APP_URL, label: 'Download on the App Store', src: appStoreBadge, height: BADGE_H, margin: 0 },
  { key: 'android', url: ANDROID_APP_URL, label: 'Get it on Google Play', src: googlePlayBadge, height: (BADGE_H * PLAY.h) / PLAY.badge, margin: -(BADGE_H * PLAY.pad) / PLAY.badge },
] as const;

/** Get AppuBot on a phone: a code to scan, and the two stores' badges, each opening its store. */
export function PhoneAppDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qr = useQrDataUrl(PHONE_DOWNLOAD_URL, 528);
  return (
    <Dialog open={open} onClose={onClose} size="sm" title="Get AppuBot for mobile" description="Scan with your phone’s camera to download it.">
      <div className="flex flex-col items-center gap-6 pt-3 pb-2">
        <span className="flex size-[200px] items-center justify-center rounded-card bg-white shadow-[0_0_0_1px_var(--ab-hairline)]">
          {qr ? <img src={qr} alt={`Code for ${PHONE_DOWNLOAD_URL}`} width={176} height={176} draggable={false} /> : <span className="block size-[176px] rounded-[4px] bg-[#f0f0f0]" />}
        </span>
        <div className="flex items-center justify-center gap-3">
          {STORES.map((s) => (
            <a
              key={s.key} href={s.url} aria-label={s.label} title={s.label}
              onClick={(e) => { e.preventDefault(); void native().openExternal(s.url); }}
              className="flex rounded-[8px] focus-visible:shadow-[0_0_0_2px_var(--ab-ring)] focus-visible:outline-none"
            >
              <img src={s.src} alt={s.label} draggable={false} style={{ height: s.height, margin: s.margin }} />
            </a>
          ))}
        </div>
      </div>
    </Dialog>
  );
}
