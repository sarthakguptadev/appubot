# Desktop performance benches

Repeatable measurements of the desktop app. Every run writes `results/<label>.json`; `compare.mjs` turns two of them
into a before/after table.

```sh
cd apps/desktop
node bench/run.mjs after --against before      # all four benches (~15 min), then the table
node bench/run.mjs quick --only renderer --renderer-runs 2
node bench/compare.mjs before after             # just the table
```

`run.mjs` builds what it measures (`electron-vite build` into `out/` for the startup bench, its own builds for the
others). Close other heavy work first: launch times move by tens of ms with the machine's load, so compare medians of
runs made one after the other.

| Script | What it measures | How |
| --- | --- | --- |
| `bundle.mjs` | The renderer's initial JS and CSS (what the window loads before it can draw), the lazy chunks, and what the initial chunk is made of per package/folder | `vite build` of the renderer into a temp folder, same plugins as electron-vite |
| `startup.mjs` | Launch: main's own steps (module loaded, app ready, core started, window created) and the renderer's (first paint, snapshot in, main layout painted, chat painted), from the spawn. Three launches without Chromium's code cache (as after an install or update), then six with it; medians of each. Then idle CPU per process kind over 30 s, again with Reduce motion emulated (the avatars hold still, so it is the app's own work at rest), RSS, and RSS/heap once a 600-message chat is fully drawn | `electron .` on the production build with a data folder of its own (two bots, a 600-message chat, the agents' model lists as if read a moment ago, so no agent starts), its own port, an invisible window (`APPUBOT_DEV_CAPTURE`) and `APPUBOT_STARTUP_TRACE` (main's marks, `src/main/core/startupTrace.ts`); the renderer's marks (`src/renderer/src/lib/perfMarks.ts`) over the DevTools protocol |
| `renderer.mjs` | Bundle evaluation, opening a long chat, drawing all 600 messages, switching bots, opening Settings, JS heap, and a 1200-token reply streamed at 100 tokens/s into the long chat: React commits and component renders, slow and long animation frames, key → frame latency of typing into the composer meanwhile | The renderer built for production in mock mode (`VITE_APPUBOT_MOCK=1`, `?long=600&bench=1`: `src/renderer/src/dev/benchThread.ts`, `mockBench.ts`), served on 127.0.0.1:5299, in headless Chrome; render counts from a stand-in React DevTools hook (`lib/renderCounter.js`) on a non-minified build |
| `scroll.mjs` | Reading back through a long chat: wheeling up from the end of a 600-message chat to its first message (time stuck at the top while older messages load, the view jumping back or skipping rows, frames over 34 ms, main-thread time), then down through it all drawn, and the main thread's time at rest | The same mock build as `renderer.mjs` (every call ~150-400 ms), headless Chrome at 2x, real wheel events over the DevTools protocol (paced by its round trip, ~55 ms each: `--speed` px per event), Chrome's own `Performance.getMetrics` |

Never touches the user's own app: its own data folder, ports (gateway 7991, DevTools 8991, static server 5299) and
window, and it stops what it starts. Needs Google Chrome for the renderer bench (`CHROME_PATH` to point elsewhere).

Numbers are from one Mac (`machine` in each results file); the startup bench runs `electron .`, so it includes what only
an unpackaged run does (no asar) and leaves out what only the packaged app does (the updater, login item, analytics).
