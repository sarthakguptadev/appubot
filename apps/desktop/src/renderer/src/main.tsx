import React, { lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
// the app's face, upright and italic (Geist, OFL: latin, latin-ext, cyrillic, vietnamese; other scripts fall back to the system's)
import '@fontsource-variable/geist';
import '@fontsource-variable/geist/wght-italic.css';
import '@fontsource-variable/jetbrains-mono';
import App from './App';
import './index.css';
import { markOnce } from './lib/perfMarks';
import { applyLanguage, i18nReady } from './lib/i18n';

markOnce('appubot:bundle-evaluated');

// the menu bar's call window only: the main window never loads the call bar
const VoiceBarApp = lazy(() => import('./features/voice/bar/VoiceBarApp').then((m) => ({ default: m.VoiceBarApp })));

// the menu bar's voice call opens this page in a window of its own: `?view=voicebar&bot=<id>`
const view = new URLSearchParams(window.location.search);
const bar = view.get('view') === 'voicebar' ? view.get('bot') : null;

const render = () => createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {bar ? <Suspense fallback={null}><VoiceBarApp botId={bar} /></Suspense> : <App />}
  </React.StrictMode>,
);
// a language other than English: its strings (a chunk of their own) first, so the window never starts in English
const start = () => { applyLanguage(); render(); };
const ready = i18nReady();
if (ready) void ready.then(start); else start();
