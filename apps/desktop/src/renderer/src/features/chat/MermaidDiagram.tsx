// Mermaid diagrams in chat markdown (after T3 Code's MermaidDiagram, MIT): a ```mermaid block draws once its reply
// stops streaming (`CodeBlock` in Markdown.tsx). Mermaid (~1 MB) loads in a lazy chunk the first time one is shown;
// renders run one at a time (initialize() is global) and are cached by theme + source; the SVG is sanitised again
// on top of Mermaid's strict mode and drawn at its own size, so a wide one scrolls inside its block.
import { useEffect, useState } from 'react';
import type { Mermaid } from 'mermaid';
import type { DOMPurify } from 'dompurify';
import { useIsDark } from '../../lib/theme';

export type MermaidResult = { ok: true; svg: string } | { ok: false; error: string };

interface Libs { mermaid: Mermaid; purify: DOMPurify }
let libs: Promise<Libs> | null = null;
let queue: Promise<unknown> = Promise.resolve();
let nextId = 0;
const MAX_CACHED = 160;
/** Finished renders, oldest first (an LRU); pending ones are shared until they settle. */
const done = new Map<string, MermaidResult>();
const pending = new Map<string, Promise<MermaidResult>>();

const REMOTE_CSS_URL = /url\(\s*(?!['"]?#)[^)]*\)/gi;

/** Mermaid and DOMPurify, both in lazy chunks; the hooks are set once. */
function loadLibs(): Promise<Libs> {
  libs ??= Promise.all([import('mermaid'), import('dompurify')])
    .then(([m, d]) => {
      const purify = d.default(window);
      purify.addHook('uponSanitizeElement', (node, data) => {
        if (data.tagName === 'style' && node.textContent) node.textContent = node.textContent.replace(REMOTE_CSS_URL, 'none');
      });
      purify.addHook('uponSanitizeAttribute', (_node, data) => {
        if (data.attrName === 'style') data.attrValue = data.attrValue.replace(REMOTE_CSS_URL, 'none');
      });
      return { mermaid: m.default, purify };
    })
    .catch((e: unknown) => { libs = null; throw e; });
  return libs;
}

/**
 * Nothing that navigates, runs script or fetches (CSS keeps only local url(#id)), and the picture at its own size:
 * width/height from its viewBox instead of Mermaid's width="100%" + max-width, which would shrink it to fit.
 */
function finishSvg(purify: DOMPurify, svg: string): string {
  const body = purify.sanitize(svg, {
    ADD_TAGS: ['foreignObject'],
    HTML_INTEGRATION_POINTS: { foreignobject: true },
    FORBID_ATTR: ['href', 'xlink:href', 'src', 'srcset'],
    FORBID_TAGS: ['a', 'img', 'image', 'script'],
    USE_PROFILES: { svg: true, svgFilters: true, html: true },
    RETURN_DOM: true,
  });
  const el = body instanceof Element ? body.querySelector('svg') : null;
  if (!el) throw new Error('Mermaid drew nothing.');
  const box = el.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
  if (box?.length === 4 && box.every(Number.isFinite)) {
    el.setAttribute('width', String(Math.ceil(box[2]!)));
    el.setAttribute('height', String(Math.ceil(box[3]!)));
    el.style.removeProperty('max-width');
  }
  return el.outerHTML;
}

/** Mermaid's own lazy diagram chunks can fail to load too: worth another try later, unlike a syntax error. */
const CHUNK_LOAD_ERROR = /dynamically imported module|importing a module script|failed to fetch/i;

/**
 * Pie slices in the dark theme: Mermaid's own darken its first colour to near black (#1f2020 → its biggest slice and
 * legend swatch vanish on the dark card), so mid tones that hold the light labels and read on the dark ground.
 */
const DARK_PIE: Record<string, string> = Object.fromEntries([
  '#4c6fd6', '#c2643a', '#3f9c74', '#9a5cc6', '#b8942f', '#3a8fb0', '#b5506c', '#6f7d90', '#5d9c3c', '#a0603f', '#4f5fb0', '#8a8a3a',
].map((c, i) => [`pie${i + 1}`, c]));

async function draw(source: string, dark: boolean): Promise<MermaidResult & { retry?: boolean }> {
  let mermaid: Mermaid, purify: DOMPurify;
  try { ({ mermaid, purify } = await loadLibs()); } catch { return { ok: false, error: 'Mermaid failed to load.', retry: true }; }
  const id = `ab-mermaid-${nextId++}`;
  try {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      // labels and theme CSS are laid out in the page before sanitising, so a diagram's own directives can't set them
      secure: ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'suppressErrorRendering', 'maxEdges', 'htmlLabels', 'themeCSS'],
      htmlLabels: false,
      theme: dark ? 'dark' : 'default',
      fontFamily: getComputedStyle(document.body).fontFamily,
      // nearer the chat's 13px than Mermaid's 16px, so an ordinary diagram fits a reply without scrolling
      themeVariables: { fontSize: '13px', ...(dark ? DARK_PIE : {}) },
    });
    const { svg } = await mermaid.render(id, source);
    return { ok: true, svg: finishSvg(purify, svg) };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return { ok: false, error, retry: CHUNK_LOAD_ERROR.test(error) };
  } finally {
    // render() leaves its scratch element behind when it throws
    document.getElementById(`d${id}`)?.remove();
  }
}

const keyOf = (source: string, dark: boolean) => `${dark ? 'dark' : 'light'}\n${source}`;

function cached(key: string): MermaidResult | undefined {
  const hit = done.get(key);
  if (hit) { done.delete(key); done.set(key, hit); }
  return hit;
}

function render(source: string, dark: boolean): Promise<MermaidResult> {
  const key = keyOf(source, dark);
  const hit = cached(key) ?? null;
  if (hit) return Promise.resolve(hit);
  let p = pending.get(key);
  if (p) return p;
  p = queue.then(() => draw(source, dark)).then(({ retry, ...result }) => {
    pending.delete(key);
    if (!retry) {
      done.set(key, result);
      for (const k of done.keys()) { if (done.size <= MAX_CACHED) break; done.delete(k); }
    }
    return result;
  });
  queue = p;
  pending.set(key, p);
  return p;
}

/** The drawn diagram for `source` in the app's current scheme (redrawn when it changes); null while drawing or off. */
export function useMermaid(source: string, enabled: boolean): MermaidResult | null {
  const dark = useIsDark();
  const src = source.trim();
  const key = keyOf(src, dark);
  const [state, setState] = useState<{ key: string; result: MermaidResult } | null>(() => {
    const hit = enabled ? cached(key) : undefined;
    return hit ? { key, result: hit } : null;
  });
  useEffect(() => {
    if (!enabled || !src) return;
    let alive = true;
    void render(src, dark).then((result) => { if (alive) setState({ key, result }); });
    return () => { alive = false; };
  }, [enabled, src, dark, key]);
  // a scheme switch keeps the old picture until the new one is drawn, rather than flashing the source
  if (!enabled || !state) return null;
  return state.key === key || state.result.ok ? state.result : null;
}

/** The diagram itself, centred, at its own size (wide ones scroll sideways inside the block). */
export function MermaidSvg({ svg }: { svg: string }) {
  return <div className="chat-markdown-mermaid" dangerouslySetInnerHTML={{ __html: svg }} />;
}
