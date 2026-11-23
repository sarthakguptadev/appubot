/**
 * Shiki code highlighting for chat markdown.
 * Loaded lazily on the first code block: one shared highlighter, languages loaded on demand, JS regex
 * engine (the renderer CSP has no 'wasm-unsafe-eval'). Its theme is Shiki's CSS-variables one: every token's colour is
 * a `var(--shiki-token-…)`, which the code block's frame sets (components/rare/codeBlock.css: Rare UI's shades of one
 * accent, for both colour schemes), so a highlighted block is kept once whatever colours it is shown in.
 */
import type { HighlighterCore, LanguageInput } from 'shiki/core';
import { contentHash } from '../../lib/lruStore';

const LANGS: Record<string, () => LanguageInput> = {
  typescript: () => import('shiki/langs/typescript.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  bash: () => import('shiki/langs/bash.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  diff: () => import('shiki/langs/diff.mjs'),
  swift: () => import('shiki/langs/swift.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  applescript: () => import('shiki/langs/applescript.mjs'),
  mermaid: () => import('shiki/langs/mermaid.mjs'),
};

const ALIASES: Record<string, string> = {
  ts: 'typescript', mts: 'typescript', cts: 'typescript', js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash', shellscript: 'bash', py: 'python', yml: 'yaml',
  md: 'markdown', rs: 'rust', golang: 'go', jsonc: 'json', json5: 'json', htm: 'html', xml: 'html', patch: 'diff',
  osascript: 'applescript',
};

/** Canonical Shiki language for a fence info string, or null for plain text / unsupported languages. */
export function resolveLang(lang: string | undefined): string | null {
  if (!lang) return null;
  const l = lang.toLowerCase();
  const id = ALIASES[l] ?? l;
  return id in LANGS ? id : null;
}

const THEME = 'css-variables';
let core: Promise<HighlighterCore> | null = null;
const loading = new Map<string, Promise<void>>();
/** highlighted blocks by language and content hash (not the code itself: a long block isn't kept twice), newest last */
const cache = new Map<string, string>();
const CACHE_MAX = 800;
const keyOf = (code: string, lang: string): string => `${lang}\u0000${contentHash(code)}`;

function highlighter(): Promise<HighlighterCore> {
  core ??= (async () => {
    const [{ createHighlighterCore, createCssVariablesTheme }, { createJavaScriptRegexEngine }] = await Promise.all([
      import('shiki/core'),
      import('shiki/engine/javascript'),
    ]);
    return createHighlighterCore({
      themes: [createCssVariablesTheme({ name: THEME, variablePrefix: '--shiki-', fontStyle: true })],
      langs: [],
      engine: createJavaScriptRegexEngine({ forgiving: true }),
    });
  })();
  return core;
}

function ensureLang(h: HighlighterCore, lang: string): Promise<void> {
  let p = loading.get(lang);
  if (!p) {
    p = h.loadLanguage(LANGS[lang]!());
    loading.set(lang, p);
  }
  return p;
}

/** Synchronous cache hit (lets remounted blocks paint highlighted on the first frame). */
export function cachedHighlight(code: string, lang: string): string | undefined {
  const key = keyOf(code, lang);
  const hit = cache.get(key);
  // used again: last out of the cache
  if (hit !== undefined) { cache.delete(key); cache.set(key, hit); }
  return hit;
}

interface Job { key: string; code: string; lang: string; wanted: number; resolve: (html: string | null) => void; done: Promise<string | null> }
/** blocks waiting to be highlighted, the newest last; one job per distinct block */
const queue: Job[] = [];
const queued = new Map<string, Job>();
let draining = false;

/** Lets the event loop run (input, painting) between two blocks. */
function yieldTask(): Promise<void> {
  const s = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (s?.yield) return s.yield();
  return new Promise((r) => { const ch = new MessageChannel(); ch.port1.onmessage = () => { ch.port1.close(); r(); }; ch.port2.postMessage(null); });
}

/**
 * One block at a time, the event loop running between them (a chat opening with two dozen code blocks used to
 * highlight them all in one ~120ms task), the newest request first: the blocks drawn last are the chat's newest, the
 * ones in view. A block nobody waits for any more (unmounted, or its streaming code moved on) is skipped.
 */
async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    let h: HighlighterCore | null = null;
    try { h = await highlighter(); } catch { /* no highlighting: every block stays plain */ }
    while (queue.length) {
      const job = queue.pop()!;
      queued.delete(job.key);
      if (!h || job.wanted <= 0) { job.resolve(null); continue; }
      const hit = cache.get(job.key);
      if (hit !== undefined) { job.resolve(hit); continue; }
      try {
        await ensureLang(h, job.lang);
        const html = h.codeToHtml(job.code, { lang: job.lang, theme: THEME });
        if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
        cache.set(job.key, html);
        job.resolve(html);
      } catch {
        job.resolve(null);
      }
      if (queue.length) await yieldTask();
    }
  } finally {
    draining = false;
  }
}

/**
 * Highlighted HTML for `code`, or null when the language is unknown, highlighting fails, or `signal` was aborted
 * before its turn came.
 */
export function highlight(code: string, lang: string, signal?: AbortSignal): Promise<string | null> {
  const key = keyOf(code, lang);
  const hit = cache.get(key);
  if (hit !== undefined) return Promise.resolve(hit);
  let job = queued.get(key);
  if (!job) {
    let resolve!: (html: string | null) => void;
    const done = new Promise<string | null>((r) => { resolve = r; });
    job = { key, code, lang, wanted: 0, resolve, done };
    queued.set(key, job);
    queue.push(job);
    void drain();
  }
  const j = job;
  j.wanted++;
  signal?.addEventListener('abort', () => { j.wanted--; }, { once: true });
  return j.done;
}
