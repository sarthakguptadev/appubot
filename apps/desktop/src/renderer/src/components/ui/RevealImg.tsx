// A picture in a box of its own shape (a chat's picture tile, a file's thumbnail) that arrives through Rare UI's
// GridReveal (components/rare/GridReveal.tsx): grey cells split while it is on its way, take its colours when it
// lands, and the picture fades in. One already shown this run (lib/imageCache.ts) is a plain <img> painted in its
// first frame, so scrolling back or opening a chat again never replays it. The real <img> takes the grid's place only
// once it has loaded under it, so nothing blinks at the swap.
import { useState, type ImgHTMLAttributes } from 'react';
import { GridReveal } from '../rare/GridReveal';
import { isDecoded, noteShown } from '../../lib/imageCache';
import { CachedImg } from './CachedImg';
import { cn } from './cn';

type Stage = 'grid' | 'swap' | 'img';
const stageOf = (src: string): Stage => (src && isDecoded(src) ? 'img' : 'grid');

export function RevealImg({ src, alt = '', className, imgClassName, cells, pace = 1.6, onError, ...img }: Omit<ImgHTMLAttributes<HTMLImageElement>, 'src' | 'className'> & {
  /** '' while the picture is still on its way: the grid waits */
  src: string;
  /** the box */
  className?: string;
  imgClassName?: string;
  cells?: number;
  pace?: number;
}) {
  const [stage, setStage] = useState<Stage>(() => stageOf(src));
  const [last, setLast] = useState(src);
  if (src !== last) {
    setLast(src);
    setStage(stageOf(src));
  }
  const picture = cn('size-full object-cover', imgClassName);
  return (
    <span className={cn('relative block size-full overflow-hidden', className)}>
      {stage === 'img' ? <CachedImg src={src} alt={alt} draggable={false} className={picture} onError={onError} {...img} /> : (
        <>
          <GridReveal
            src={src || null}
            alt={alt}
            cells={cells}
            pace={pace}
            className="absolute inset-0"
            onRevealComplete={() => { noteShown(src); setStage('swap'); }}
            onError={() => setStage('img')}
          />
          {stage === 'swap' ? <CachedImg src={src} alt="" aria-hidden draggable={false} loading="eager" className={cn(picture, 'absolute inset-0')} onLoad={() => setStage('img')} onError={() => setStage('img')} /> : null}
        </>
      )}
    </span>
  );
}
