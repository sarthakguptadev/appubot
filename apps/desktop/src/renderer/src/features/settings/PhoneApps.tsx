/**
 * Where to get the phone app, as two codes a phone's camera reads: iPhone (the App Store) and Android (Google Play), the
 * links the site's phone cards use (`lib/links.ts`). Shown wherever a phone is paired: onboarding's Pair step,
 * Settings › Devices' pairing view and its empty state. Each code is also a button that opens the link here.
 */
import { useEffect, useState } from 'react';
import { ANDROID_APP_URL, IOS_APP_URL } from '../../lib/links';
import { native } from '../../lib/native';
import { cn } from '../../components/ui';

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
      className="group flex flex-col items-center gap-1.5 rounded-card p-1.5 text-center transition-colors hover:bg-[var(--ab-ink-tint)]"
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
