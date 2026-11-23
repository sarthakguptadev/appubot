// Injected before the page's scripts (Page.addScriptToEvaluateOnNewDocument): a stand-in React DevTools hook that
// counts commits and, per commit, the components that rendered (function/class/forwardRef/memo fibers with React's
// PerformedWork flag that weren't carried over untouched from the previous commit). Works on production builds;
// names need a non-minified build. Read with `window.__renderCounts.take()` (`owners`: "Name ← the component that drew
// it", motion's own wrappers skipped, to find who re-renders an animated element).
(() => {
  const PERFORMED_WORK = 1;
  const COMPONENT_TAGS = new Set([0, 1, 11, 14, 15]);
  let prev = new Set();
  const state = { commits: 0, renders: 0, byName: new Map(), byOwner: new Map() };
  // what a component was drawn by: the nearest component above it that isn't motion's own plumbing
  const PLUMBING = /^(motion\.|AnimatePresence|PresenceChild|PopChild|PopChildMeasure|\?|Anonymous)/;
  const nameOf = (f) => {
    const t = f.type;
    if (!t) return '?';
    return t.displayName || t.name || t.render?.displayName || t.render?.name || t.type?.displayName || t.type?.name || '?';
  };
  const hook = {
    supportsFiber: true,
    renderers: new Map(),
    inject(r) { const id = hook.renderers.size + 1; hook.renderers.set(id, r); return id; },
    checkDCE() {},
    onScheduleFiberRoot() {},
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    onCommitFiberRoot(_id, root) {
      state.commits++;
      const seen = new Set();
      const stack = [root.current];
      while (stack.length) {
        const f = stack.pop();
        seen.add(f);
        if (COMPONENT_TAGS.has(f.tag) && (f.flags & PERFORMED_WORK) && !prev.has(f)) {
          state.renders++;
          const n = nameOf(f);
          state.byName.set(n, (state.byName.get(n) ?? 0) + 1);
          let o = f.return;
          while (o && !(COMPONENT_TAGS.has(o.tag) && !PLUMBING.test(nameOf(o)))) o = o.return;
          const k = `${n} ← ${o ? nameOf(o) : 'root'}`;
          state.byOwner.set(k, (state.byOwner.get(k) ?? 0) + 1);
        }
        if (f.sibling) stack.push(f.sibling);
        if (f.child) stack.push(f.child);
      }
      prev = seen;
    },
  };
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = hook;
  window.__renderCounts = {
    take() {
      const out = { commits: state.commits, renders: state.renders, top: [...state.byName].sort((a, b) => b[1] - a[1]).slice(0, 60), owners: [...state.byOwner].sort((a, b) => b[1] - a[1]).slice(0, 40) };
      state.commits = 0; state.renders = 0; state.byName = new Map(); state.byOwner = new Map();
      return out;
    },
  };
})();
