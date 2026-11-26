// The other assistants' own marks for Settings › Import's picker, used only to name the product a person is coming
// from (as the site's Compare page does), each in its own colours: Grok Bot's face (from x.ai/bot)
// in white on the blue of its announcement card, the dots ring with its blue dot looking out (chatgpt.com/features/dots,
// "get your dot"), Muse's squiggle in Meta's blue (muse.ai's own icon), OpenClaw's, OpenBot's and Manus' the Empire
// film's copies, MausBot's its site's icon (mausbot.com/icon.svg) and Hermes Agent's its desktop app's icon
// (NousResearch/hermes-agent `apps/desktop/assets/icon.png`). All are drawn as images or masks, never as documents.
import type { CSSProperties } from 'react';
import { cn } from '../../components/ui';
import { RegistryIcon } from '../providers/providerLogos';
import grokbot from './import-logos/grokbot.svg?raw';
import dots from './import-logos/dots.png';
import hermes from './import-logos/hermes.png';
import manus from './import-logos/manus.png';
import mausbot from './import-logos/mausbot.svg';
import muse from './import-logos/muse-color.svg';
import openbot from './import-logos/openbot.png';
import openclaw from './import-logos/openclaw.svg';

/** pictures: `fill` covers the whole tile (it brings its own background), else it sits inside the tile; `on` is the
 *  tile's own colour where the mark needs one behind it */
const PICTURE: Record<string, { src: string; fill?: boolean; on?: string }> = {
  dots: { src: dots, on: '#fff' },
  muse: { src: muse, on: '#fff' },
  openclaw: { src: openclaw },
  openbot: { src: openbot, fill: true },
  mausbot: { src: mausbot, fill: true },
  manus: { src: manus, fill: true },
  hermes: { src: hermes, fill: true, on: '#fff' },
};
/** one-colour marks (SVG text) drawn as a mask in `ink` on a tile of their own colour */
const MARK: Record<string, { svg: string; ink: string; on: string }> = {
  grokbot: { svg: grokbot, ink: '#fff', on: 'linear-gradient(135deg, #4c9dff, #8cc6ff)' },
};

/** An assistant's mark on a small tile; an initial for one with no mark here. */
export function ImportLogo({ id, name, size = 28, className }: { id: string; name: string; size?: number; className?: string }) {
  const picture = PICTURE[id];
  const mark = MARK[id];
  const inner = Math.round(size * 0.6);
  const style: CSSProperties = { width: size, height: size, background: picture?.on ?? mark?.on, color: mark?.ink };
  return (
    <span aria-hidden className={cn('ab-pill squircle grid shrink-0 place-items-center overflow-hidden rounded-control-sm bg-surface-3 text-fg', className)} style={style}>
      {picture ? <img src={picture.src} alt="" draggable={false} className={picture.fill ? 'size-full object-cover' : 'object-contain'} style={picture.fill ? undefined : { width: inner + 4, height: inner + 4 }} />
        : mark ? <RegistryIcon svg={mark.svg} size={inner + 2} />
          : <span className="text-ui font-semibold text-fg-2">{name.charAt(0).toUpperCase()}</span>}
    </span>
  );
}
