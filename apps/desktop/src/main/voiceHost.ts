/**
 * The voice host: a child process that runs the speech models (sherpa-onnx's addon, `voiceHostCore`), so a 2 GB
 * model and its CPU-heavy passes never sit in the app's own process. Started by `voiceEngine.ts` with `fork` under
 * Electron-as-Node (`ELECTRON_RUN_AS_NODE=1`, advanced serialization so PCM arrives as an Int16Array); each request
 * says what to do, each answer carries its id. Ends when the app lets go of it (IPC disconnect).
 * Built to out/main/voiceHost.js (electron.vite.config.ts); no Electron, no app code but the host core.
 */
import { VoiceHostCore, type HostRequest } from './core/services/voiceHostCore';

const core = new VoiceHostCore();

process.on('message', (req: HostRequest) => {
  void core.handle(req).then((res) => {
    // the app may have gone meanwhile
    if (process.connected) process.send?.(res);
  });
});
process.on('disconnect', () => process.exit(0));
