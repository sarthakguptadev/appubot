import { useEffect, useReducer, type ComponentType } from 'react';

/**
 * A component whose code is a chunk of its own, loaded the first time it renders (or by `preload`), drawing nothing
 * until it is here and itself from then on. Unlike `React.lazy` there is no Suspense boundary: React holds a boundary's
 * content back up to 300 ms once it resolves (its reveal throttle), which a dialog opened before its chunk was
 * preloaded showed as a 300 ms wait; here it draws in the frame after the chunk arrives (a few ms from disk).
 */
export function lazyComponent<P extends object>(load: () => Promise<ComponentType<P>>): ComponentType<P> & { preload: () => Promise<void> } {
  let Loaded: ComponentType<P> | null = null;
  let pending: Promise<void> | null = null;
  const preload = (): Promise<void> => {
    pending ??= load().then((c) => { Loaded = c; }, () => { pending = null; });
    return pending;
  };
  function Lazy(props: P) {
    const [, redraw] = useReducer((n: number) => n + 1, 0);
    useEffect(() => {
      if (Loaded) return;
      let alive = true;
      void preload().then(() => { if (alive) redraw(); });
      return () => { alive = false; };
    }, []);
    return Loaded ? <Loaded {...props} /> : null;
  }
  return Object.assign(Lazy, { preload });
}
