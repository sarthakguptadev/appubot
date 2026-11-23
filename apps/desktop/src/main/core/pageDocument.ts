/**
 * Visual replies (T3 Code's): a bot's `show_page` HTML made into the document the chat's frame loads from the gateway's
 * `/pages/:id`. Its head gets the app's look (the theme as CSS variables, so a chart follows light and dark, the app's
 * own face where the app sends it, and quiet defaults for headings, tables and buttons: the page's own styles win) and
 * a small script that tells the chat how tall the page is, hands link clicks to it (links open in the browser) and
 * lays flat a card the page draws round itself: the chat shows a page in one card of its own, with no title bar, so a
 * page's own outer card would be a card in a card (2026-11-17, the owner's "a card inside another card, I don't want
 * that": pages made before are served through here too, so they change with it). The response's policy
 * (`PAGE_HEADERS`) lets the page run its own scripts and nothing else: no network, no frames, no forms.
 */

export type PageTheme = 'light' | 'dark';

const THEMES: Record<PageTheme, string> = {
  dark: '--fg:#fcfcfc;--muted:rgba(252,252,252,.58);--bg:transparent;--surface:rgba(252,252,252,.05);--surface-2:rgba(252,252,252,.09);--border:rgba(252,252,252,.1);--accent:#f58056;'
    + '--c1:#f58056;--c2:#4c9dff;--c3:#90c85b;--c4:#ffb94a;--c5:#b48cff;--c6:#ff6f91;color-scheme:dark;',
  light: '--fg:#1c1c1c;--muted:rgba(28,28,28,.6);--bg:transparent;--surface:rgba(28,28,28,.04);--surface-2:rgba(28,28,28,.07);--border:rgba(28,28,28,.1);--accent:#ee7944;'
    + '--c1:#ee7944;--c2:#2e8eff;--c3:#3f9f1f;--c4:#d99a1a;--c5:#8a5cf6;--c6:#e0457b;color-scheme:light;',
};

/** the face the page is set in when the app sends none of its own */
const SYSTEM_FONT = '-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif';
/** how far the page's content keeps from the card's edge (the card is the chat's; the page fills it) */
export const PAGE_PAD = 16;

/**
 * The look a page starts from, the app's own: its type sizes and weights, hairline tables, filled round buttons.
 * Element selectors only and first in the head, so anything the page styles itself wins.
 */
const BASE = [
  `html,body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 var(--font);-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;}`,
  `body{padding:${PAGE_PAD}px;}`,
  'a{color:var(--accent);}',
  'h1,h2,h3,h4{margin:0 0 .45em;font-weight:600;line-height:1.25;letter-spacing:-.01em;}',
  'h1{font-size:18px;}h2{font-size:15px;}h3,h4{font-size:14px;}',
  'p{margin:0 0 .75em;}',
  'body>:first-child{margin-top:0;}body>:last-child{margin-bottom:0;}',
  'small{color:var(--muted);}',
  'hr{border:0;border-top:1px solid var(--border);margin:14px 0;}',
  'table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums;}',
  'th{text-align:left;font-weight:500;font-size:12px;color:var(--muted);padding:6px 10px;border-bottom:1px solid var(--border);}',
  'td{padding:7px 10px;border-bottom:1px solid var(--border);}',
  'tr:last-child>td{border-bottom:0;}',
  'button,input,select,textarea{font:inherit;color:inherit;}',
  'button{border:0;border-radius:999px;background:var(--surface-2);padding:6px 12px;font-weight:500;cursor:pointer;}',
  'code,pre,kbd{font-family:var(--mono);font-size:12.5px;}',
].join('');

/** What a page may do: run its own inline code and draw what it carries (data: images), nothing that leaves it. */
export const PAGE_HEADERS: Record<string, string> = {
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; form-action 'none'; base-uri 'none'; sandbox allow-scripts",
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
};

/**
 * The page reports its height and its links to the chat (window.parent), tagged with its id, and lays its own outer
 * card flat (`lay`): the page's ground when it is a plain tone of the scheme, then, going in from the body while
 * there is one box round everything, the first box that is drawn (a fill, an edge or a shadow) in such a tone and as
 * wide as what holds it loses its fill, edge, shadow, corners and padding. Left alone: a box with a picture or a
 * colour of its own (a mockup, a poster: its text may count on it), a narrow one (a phone's screen), and boxes side by
 * side (tiles are the page's content). A page that asks for the system's face (as pages made before do) is set in
 * the app's instead; one with a face of its own keeps it. Once, as soon as the page has something in it.
 */
function bootstrap(id: string, theme: PageTheme, still: boolean): string {
  return `<script>(() => {
  const tag = ${JSON.stringify(id)};
  const dark = ${theme === 'dark'};
  // a preview picture of the page (the Files tab's tile, ?still=1): it runs for a moment so it draws itself, then
  // holds still: no frames, timers, animations or sound from a page nobody is reading
  if (${still}) {
    let frozen = false;
    const raf = window.requestAnimationFrame.bind(window), st = window.setTimeout.bind(window), si = window.setInterval.bind(window);
    const loops = new Set();
    window.requestAnimationFrame = (fn) => (frozen ? 0 : raf(fn));
    window.setTimeout = (fn, ms, ...a) => (frozen ? 0 : st(fn, ms, ...a));
    window.setInterval = (fn, ms, ...a) => { if (frozen) return 0; const id = si(fn, ms, ...a); loops.add(id); return id; };
    const freeze = () => {
      if (frozen) return;
      frozen = true;
      for (const id of loops) clearInterval(id);
      const s = document.createElement('style');
      s.textContent = '*,*::before,*::after{animation-play-state:paused!important;transition:none!important}html{overflow:hidden!important}';
      (document.head || document.documentElement).appendChild(s);
      for (const m of document.querySelectorAll('video,audio')) { try { m.pause(); } catch (e) {} }
    };
    addEventListener('load', () => st(freeze, 1200));
    st(freeze, 4000);
  }
  const post = (m) => parent.postMessage(Object.assign({ appubotPage: tag }, m), '*');
  let last = 0;
  const size = () => { const h = Math.ceil(document.documentElement.scrollHeight); if (h !== last) { last = h; post({ height: h }); } };
  // the document's own measure never goes under the frame's height, so a page shorter than its frame (a few lines,
  // or one whose card was laid flat) says how tall its body is by itself: as it is laid flat, and a few times once
  // loaded (the frame may only then have the height the page first asked for). A body as tall as the frame on purpose
  // (min-height: 100vh) never reads shorter, so it stays.
  const fit = () => {
    const b = document.body;
    if (!b) return;
    const h = Math.ceil(b.getBoundingClientRect().top + scrollY + Math.max(b.scrollHeight, b.offsetHeight) + (parseFloat(getComputedStyle(b).marginBottom) || 0));
    if (h > 0 && h < innerHeight - 4 && h !== last) { last = h; post({ height: h }); }
  };
  const rgba = (s) => {
    let m = /^rgba?\\(([^)]+)\\)$/.exec(s);
    if (m) { const p = m[1].split(/[\\s,\\/]+/).filter(Boolean).map(parseFloat); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; }
    m = /^color\\(srgb ([^)]+)\\)$/.exec(s);
    if (m) { const p = m[1].split(/[\\s\\/]+/).filter(Boolean).map(parseFloat); return { r: p[0] * 255, g: p[1] * 255, b: p[2] * 255, a: p.length > 3 ? p[3] : 1 }; }
    return null;
  };
  const tone = (c) => {
    if (Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b) > 28) return false;
    const l = (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;
    return c.a <= 0.35 || (dark ? l < 0.3 : l > 0.82);
  };
  const fill = (cs) => { const c = rgba(cs.backgroundColor); return c && c.a > 0 ? c : null; };
  const drawn = (cs) => !!fill(cs) || cs.backgroundImage !== 'none' || cs.boxShadow !== 'none' || (parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== 'none');
  const plain = (cs) => { if (cs.backgroundImage !== 'none') return false; const c = rgba(cs.backgroundColor); return !!c && (c.a === 0 || tone(c)); };
  const system = /^\\s*["']?(-apple-system|system-ui|ui-sans-serif|BlinkMacSystemFont|Segoe UI|Helvetica Neue|Helvetica|Arial|Roboto|Inter|sans-serif)["']?\\s*(,|$)/i;
  let laid = false;
  const lay = () => {
    // a frame not laid out yet has no width to judge by: the next look (once loaded) finds one
    if (laid || !document.body || innerWidth < 80) return;
    try {
      for (const el of [document.documentElement, document.body]) {
        const cs = getComputedStyle(el), c = fill(cs);
        if (c && cs.backgroundImage === 'none' && tone(c)) el.style.setProperty('background', 'transparent', 'important');
        if (system.test(cs.fontFamily)) el.style.setProperty('font-family', 'var(--font)', 'important');
      }
      let box = document.body;
      for (let depth = 0; depth < 5; depth++) {
        const kids = [...box.children].filter((k) => !/^(SCRIPT|STYLE|LINK|TEMPLATE|NOSCRIPT)$/.test(k.tagName) && k.getClientRects().length);
        if (!kids.length) return;
        const boxes = kids.filter((k) => k instanceof HTMLElement && drawn(getComputedStyle(k)));
        if (boxes.length > 1) { laid = true; return; }
        if (boxes.length === 1) {
          const k = boxes[0];
          laid = true;
          if (!plain(getComputedStyle(k)) || k.offsetWidth < box.clientWidth * 0.8) return;
          for (const p of [['background', 'none'], ['border', '0'], ['box-shadow', 'none'], ['border-radius', '0'], ['backdrop-filter', 'none'], ['padding', '0'], ['margin', '0'], ['max-width', 'none']]) k.style.setProperty(p[0], p[1], 'important');
          k.setAttribute('data-appubot-flat', '');
          fit();
          return;
        }
        if (kids.length !== 1 || !(kids[0] instanceof HTMLElement)) { laid = true; return; }
        box = kids[0];
      }
    } catch (e) { laid = true; }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', lay); else lay();
  addEventListener('load', () => { lay(); size(); fit(); setTimeout(() => { lay(); fit(); }, 250); setTimeout(fit, 900); });
  new ResizeObserver(size).observe(document.documentElement);
  document.addEventListener('click', (e) => {
    const a = e.target instanceof Element ? e.target.closest('a[href]') : null;
    if (!a || (a.getAttribute('href') || '').startsWith('#')) return;
    e.preventDefault();
    if (/^https?:/i.test(a.href)) post({ open: a.href });
  }, true);
})();</script>`;
}

/** base64 as it may go into a stylesheet's url(): nothing else */
const BASE64 = /^[A-Za-z0-9+/=]+$/;

/**
 * The bot's HTML as the chat's frame shows it: the look first (the page's own styles win), then the bootstrap.
 * `font`: the app's own face (a variable WOFF2 as base64, `CoreDeps.pageFont`), for the app that is set in it.
 * `still`: a preview of the page that stops moving a moment after it has drawn itself (the Files tab's tiles).
 */
export function pageDocument(html: string, opts: { id: string; theme: PageTheme; font?: { family: string; woff2: string } | null; still?: boolean }): string {
  const font = opts.font && BASE64.test(opts.font.woff2) && /^[\w ]{1,40}$/.test(opts.font.family) ? opts.font : null;
  const head = `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>`
    + (font ? `@font-face{font-family:"${font.family}";font-style:normal;font-weight:100 900;font-display:block;src:url(data:font/woff2;base64,${font.woff2}) format("woff2");}` : '')
    + `:root{${THEMES[opts.theme]}--font:${font ? `"${font.family}",` : ''}${SYSTEM_FONT};--mono:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;--radius:12px;--radius-sm:8px;}`
    + `${BASE}</style>`
    + bootstrap(opts.id, opts.theme, !!opts.still);
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + head);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => `${m}<head>${head}</head>`);
  return `<!doctype html><html><head>${head}</head><body>${html}</body></html>`;
}
