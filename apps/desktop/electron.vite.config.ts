import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';
import { noticesPlugin } from './scripts/notices.mjs';

// Everything we ship is minified and has no source maps (a map carries the whole original source, and electron-builder.yml's
// `!**/*.map` didn't keep main's out of the installer): the app's own code isn't readable in it, like other production
// Electron apps.
// That also drops the license comments, so each build notes the packages it bundled and the renderer's, built last,
// writes THIRD_PARTY_NOTICES.txt (scripts/notices.mjs), which electron-builder.yml ships as a plain file.
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ['@appubot/protocol', '@appubot/agent-runtime', '@appubot/client', '@appubot/theme', '@appubot/chat-core', '@modelcontextprotocol/sdk'] }), noticesPlugin('main')],
    resolve: { alias: { '@main': resolve('src/main') } },
    // voiceHost: the process that runs the speech models (core/services/voiceEngine.ts forks out/main/voiceHost.js)
    build: { rollupOptions: { input: { index: resolve('src/main/index.ts'), voiceHost: resolve('src/main/voiceHost.ts') } }, minify: true },
  },
  preload: {
    plugins: [externalizeDepsPlugin(), noticesPlugin('preload')],
    build: { rollupOptions: { input: { index: resolve('src/preload/index.ts') } }, minify: true },
  },
  renderer: {
    plugins: [react(), tailwindcss(), noticesPlugin('renderer', { write: true })],
    resolve: { alias: { '@': resolve('src/renderer/src') } },
    build: { rollupOptions: { input: { index: resolve('src/renderer/index.html') } }, minify: true },
  },
});
