/**
 * One-shot performance marks for the startup bench (apps/desktop/bench/startup.mjs reads them over the DevTools
 * protocol): each name is marked once per page, after the next frame is painted when `painted` is set. A handful of
 * marks per launch, so they stay in the shipped app.
 */
const done = new Set<string>();

export function markOnce(name: string, painted = false): void {
  if (done.has(name) || typeof performance === 'undefined') return;
  done.add(name);
  if (!painted || typeof requestAnimationFrame !== 'function') { performance.mark(name); return; }
  // the frame after the next one: the content has been drawn by then
  requestAnimationFrame(() => setTimeout(() => performance.mark(name), 0));
}
