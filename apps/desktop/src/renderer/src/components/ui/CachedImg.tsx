// An <img> that paints at once when the picture was already shown this run (lib/imageCache.ts holds it decoded), and
// holds it once it loads. Everything else is a plain <img>.
import { forwardRef, type ImgHTMLAttributes, type SyntheticEvent } from 'react';
import { isDecoded, noteShown } from '../../lib/imageCache';

export const CachedImg = forwardRef<HTMLImageElement, ImgHTMLAttributes<HTMLImageElement> & { src: string }>(function CachedImg({ src, onLoad, ...rest }, ref) {
  const warm = isDecoded(src);
  return (
    <img
      ref={ref}
      src={src}
      // a held picture decodes in step (a memory hit), so it is there in the first frame; a new one decodes off-thread
      decoding={warm ? 'sync' : 'async'}
      {...(warm ? {} : { loading: rest.loading ?? 'lazy' })}
      onLoad={(e: SyntheticEvent<HTMLImageElement>) => { noteShown(src); onLoad?.(e); }}
      {...rest}
    />
  );
});
