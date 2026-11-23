# Performance pass, 2026-11-16

`before-final` is the code at 8c269843, `after-final` this pass; both measured with this pass's benches (`results/`,
`node bench/compare.mjs before-final after-final`), on the same Apple M5, other apps running. The mock behind the
renderer and scroll benches was fixed first: since 2026-11-15 its routine chat was Appu's current one, so `?long=600`
benches had been timing a 64-message chat (`dev/MockGateway.ts` now makes the long chat current). The launch rows of a
run made after another drift with the machine's load (main's own module load moved +28 ms between the two runs above,
with nothing changed there), so launches were also measured interleaved, before/after/before… six rounds (6 cold and 18
warm launches each, `startup.mjs`); those are the launch numbers here.

| Area | Metric | before | after |
| --- | --- | ---: | ---: |
| Bundle | initial JS (minified) | 2356 KB | 1777 KB |
| Bundle | initial JS (gzip) | 737 KB | 574 KB |
| Bundle | initial CSS (what the first chunk imports) | 224 KB | 197 KB |
| Launch, cold (interleaved median) | snapshot in (hydrated) | 685 ms | 621 ms |
| Launch, cold (interleaved median) | chat painted | 804 ms | 721 ms |
| Launch, warm (interleaved, from window created) | snapshot in | 227 ms | 190 ms |
| Launch, warm (interleaved, from window created) | chat painted | 346 ms | 290 ms |
| Launch | first paint | unchanged within noise | |
| Renderer (mock) | open a 600-message chat | 58 ms | 36 ms |
| Renderer (mock) | switch bots | 40 ms | 31 ms |
| Renderer (mock) | load: total blocking time | 23 ms | 4 ms |
| Streaming 1200 tokens while typing | component renders | 6049 | 2985 |
| Scroll up a 600-message chat | reached its first message | 0 of 3 runs (stuck at 80 rows) | 3 of 3 |
| Scroll up a 600-message chat | time stuck at the top waiting | the whole 2 min | 0 ms |
| Scroll up a 600-message chat | main-thread time | 15.2 s (stuck) | 6.4 s |
| Idle, Reduce motion | CPU, all processes | 0.87% | 0.25% |

## What changed

- **Older messages never loaded when scrolling up** (`Transcript.tsx`): the top sentinel's observer reported "in view"
  ~16 px before the effect's own `scrollTop <= 800` check passed, and an observer reports edges only, so a reader whose
  scroll crossed that band between two notifications sat at the top with nothing loading until they scrolled away and
  back (every run of the bench). Now the scroll handler checks too. With only that fixed, a reader still waited at the
  top 4-6 times (~0.6 s) while each page was fetched, and drawing 100 rows at once dropped 4-6 frames (worst 83 ms).
  Now older rows are drawn 30 at a time (`GROW`), the computer's next page is fetched as soon as the rows left undrawn
  drop under a page (so it is in memory before the reader gets there: 0 ms waiting), the reading position is anchored
  on the first drawn row's place in the content (a page awaited no longer pulls the reader back), and a background page
  can't fill spare window slots above the reader unanchored (that skipped 10 rows once a run). The first window is 30
  rows, not 80: opening a long chat 58 → 36 ms. Checked by `scroll.mjs`'s jump/skip detector (0 / 0).
- **The transcript's edge fades** were a `mask-image` on the scroller: every scroll frame composited a masked layer.
  Two gradient overlays in `--ab-content` look the same over the chat's flat colour (the Messages theme, with a
  wallpaper behind the rows, keeps the mask): main thread scrolling up −17%, down −13%.
- **Every animated element in every visible message re-rendered with the chat card** (`ThreadView.tsx`,
  `RightPanel.tsx`): the chat sits in an `AnimatePresence` whose default `presenceAffectsLayout` makes framer-motion
  hand a fresh presence context down on every render, so each code block's copy button and each reaction button redrew
  its motion tree (~1000 renders in one streamed reply, found with `renderCounter.js`'s new `owners`). Off: renders
  6049 → 2985. The code block's copy button is also a memo that reads its code through a ref, and its header lost a
  `backdrop-blur` over its own opaque frame (a filter per block, no visible effect).
- **The first chunk** (`bundle.mjs`): every language's strings (~240 KB minified) are a chunk loaded only for another
  language, before the first render (chat-core `addTranslations`/`hasTranslations`; the phone registers them at once);
  KaTeX and its CSS (~280 KB) load when a text with `$$` shows up, or in a quiet moment after launch (a text without
  `$$` holds no maths here, so it skips remark-math/rehype-katex and parses quicker); the bot editor, teach, skill,
  routine, group and pair dialogs, the cloud welcome and the Apps page load when first opened (`lib/lazyComponent.tsx`,
  preloaded on idle). `React.lazy` was tried first: React 19 holds a resolved Suspense boundary back up to 300 ms, so a
  dialog opened before its chunk was preloaded took ~310 ms; `lazyComponent` has no boundary (7-24 ms). Settings moved
  to it too.
- **The window's hello** no longer waits for computer use to start (`gateway.ts`; phones and bots still do): its
  snapshot says computer use isn't up yet (the permission notices need it up, so nothing shows) and `computer.status`
  follows ~50 ms later.

## Measured, not changed

- **The avatars' idle motion is still ~30-40% of a core at rest** (renderer + GPU; 0.25% with Reduce motion). The
  resting breath is continuous, so Chromium produces every frame; nothing short of pausing it (for example while the
  window isn't focused) brings that down. A design call.
- **Bundle evaluation** (~45 ms of script in the mock) is mostly module setup (zod schemas ~13 ms, tailwind-merge's
  class map, icons), not parsing: the 25% smaller chunk didn't move first paint.
- **Renderer RSS with all 600 messages drawn** read 397 → 429 MB in the interleaved runs (idle 322 → 236 MB, JS heap
  lower): the preloaded chunks are resident by then; RSS swings by tens of MB run to run.

# Performance pass, 2026-11-06

`before` is the code before the pass (9b35295: only the benches and their marks added), `after` the pass's last commit.
Both were measured back to back with the same bench scripts on an Apple M5 (10 cores, 16 GB), macOS, Electron 44,
other apps running (`results/before.json`, `results/after.json`; `node bench/compare.mjs before after`).

| Area | Metric | before (9b35295) | after (d00944a) |
| --- | --- | ---: | ---: |
| Bundle | initial JS (minified) | 1906 KB | 1656 KB |
| Bundle | initial JS (gzip) | 595 KB | 520 KB |
| Bundle | initial CSS | 205 KB | 205 KB |
| Startup (cold, median) | window created | 537 ms | 337 ms |
| Startup (cold, median) | first paint | 608 ms | 486 ms |
| Startup (cold, median) | chat painted (interactive) | 729 ms | 606 ms |
| Startup (warm, median) | main module loaded | 206 ms | 210 ms |
| Startup (warm, median) | core started | 478 ms | 269 ms |
| Startup (warm, median) | window created | 533 ms | 329 ms |
| Startup (warm, median) | first paint | 608 ms | 479 ms |
| Startup (warm, median) | snapshot in (hydrated) | 639 ms | 511 ms |
| Startup (warm, median) | chat painted (interactive) | 730 ms | 603 ms |
| Idle | CPU, all processes | 75.61% | 73.91% |
| Idle | CPU, renderer | 33.34% | 31.58% |
| Idle | CPU, GPU process | 41.5% | 41.7% |
| Idle | CPU, main | 0.77% | 0.63% |
| Idle, Reduce motion | CPU, all processes | 4.72% | 1.13% |
| Idle, Reduce motion | CPU, renderer | 3.52% | 1.06% |
| Memory | RSS total, idle | 783.9 MB | 784.8 MB |
| Memory | RSS main, idle | 278 MB | 277.8 MB |
| Memory | RSS renderer, idle | 313.9 MB | 306.5 MB |
| Memory | RSS renderer, 600 messages drawn | 387.3 MB | 398.6 MB |
| Memory | JS heap, 600 messages drawn | 29.2 MB | 28.7 MB |
| Renderer (mock, median) | load: total blocking time | 36 ms | 31 ms |
| Renderer (mock, median) | load: longest task | 75 ms | 67 ms |
| Renderer (mock, median) | bundle evaluated | 68.6 ms | 59.6 ms |
| Renderer (mock, median) | open long chat (80-row window) | 66.6 ms | 67.6 ms |
| Renderer (mock, median) | draw all 600 messages | 237.5 ms | 241.6 ms |
| Renderer (mock, median) | switch bots | 45 ms | 44 ms |
| Renderer (mock, median) | open Settings (first) | 44.5 ms | 43.1 ms |
| Renderer (mock, median) | open Settings (again) | 37.4 ms | 37.3 ms |
| Renderer (mock, median) | JS heap, 600 messages drawn | 31 MB | 30.8 MB |
| Streaming 1200 tokens | React commits | 529 | 529 |
| Streaming 1200 tokens | component renders | 6918 | 2046 |
| Streaming 1200 tokens | frames over 34 ms | 0 | 0 |
| Streaming 1200 tokens | long animation frames | 0 | 0 |
| Streaming 1200 tokens | key → frame p50 | 8.4 ms | 7.8 ms |
| Streaming 1200 tokens | key → frame p95 | 15.6 ms | 14.3 ms |

Idle CPU is per cent of one core, summed over AppuBot's processes, while the window shows a chat with two bots in the
sidebar; most of it is the bots' always-moving avatars (see below). "Reduce motion" is the same window with macOS's
Reduce motion emulated, so the avatars hold still and what is left is the app's own work at rest.

## What changed

- **The support bubble's layout loop** (`SupportWidget.tsx`): its ResizeObserver was disconnected and re-observed on
  every pass, and `observe()` always reports once, so it re-ran every frame for as long as the chat showed (a
  requestAnimationFrame loop with a forced layout). Idle with Reduce motion 4.7% → 1.1%.
- **Launch** (`index.ts`, `core/app.ts`, `ComputerService`, gateway hello): the window no longer waits for computer
  use. Cua's module loads from the top of `main()`; the backend starts once the window's page has committed
  (`did-navigate`, measured against starting at once and at `dom-ready`); the hello waits for it (≤3 s) so the first
  snapshot is unchanged; the Input Monitoring check (the native helper, ~0.15 s) follows on its own; the window is made
  before the menu and tray. Window created −200 ms, chat painted −125 ms.
- **Code highlighting** (`highlight.ts`): one block per task, newest (on-screen) first, unmounted ones skipped, instead
  of every block of a freshly opened chat in one ~120 ms task (measured in the app's renderer profile).
- **Renders while streaming/typing**: the live turn's working row and the composer's pickers, ring and menus are memos.
  Component renders for a 1200-token reply with typing 6918 → 2046 (commits unchanged).
- **Bundle**: Settings (all its pages, Billing, Team, the paywall), onboarding, the menu bar call bar and the QR encoder
  are lazy chunks (Settings preloads when idle and stays mounted). Initial JS −13%.

## Measured, not changed

- **The avatars' motion is most of the idle CPU** (~74% here: renderer ~32%, GPU process ~42%; 1.1% when still). Their
  breathing never pauses, and transforms on SVG `<g>` layers can't run on the compositor, so every frame is styled,
  painted, rastered and composited. One avatar costs as much as three. Making it cheap means changing what the user sees
  or how it is drawn: pausing the motion while AppuBot isn't the focused app, or drawing the layers as HTML elements
  (compositor animations, but bitmap scaling and different transform origins). Left for a design call.
- **KaTeX in the first bundle** (585 KB of source, ~250 KB minified): ~4 ms of bundle evaluation. Loading it lazily
  would show raw `$$…$$` for a frame on chats with maths. Not worth it.
- **Drawing all 600 messages** (⌘F's "every message") ~240 ms; the chat normally draws an 80-row window.
  `content-visibility` would cut it, but rows above the view would change height as they draw, which fights the
  transcript's own scroll anchoring.
- **Markdown per token**: the answers view (the only one shown) draws a reply's text when the turn ends, so streaming
  doesn't re-parse markdown; per delta only the row, the turn and its live part render.
- **Main-process requires**: electron-updater (~19 ms on its own) is needed at launch by the packaged app to know whether
  it can update; grammy (~11 ms) and the ACP SDK (~23 ms with zod) could load on first use (left: small, packaged runs
  read them from asar).
- **Leaving a long chat** spends ~15 ms in one `removeChild` (dropping ~4k nodes); a switch paints in ~30-45 ms.
- **Memory**: main's JS heap is ~29 MB (its ~280 MB RSS is mostly Electron's browser process); the renderer holds ~17 MB
  of JS heap at idle, ~29 MB with 600 messages drawn. No idle gateway chatter (one event in 20 s), no idle agent starts
  once the agents' model lists are known.
