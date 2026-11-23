import { useEffect, useState } from 'react';
import { applyEvent } from './events';
import { activeComputer, errorMessage, initGateway } from './gateway';
import { watchCloud } from '../features/cloud/cloudAccount';
import { getState, isVoiceBarView, setState } from './store';
import { LOCAL_SEND_WAIT_MS, MAC_KEY, failWaiting, pumpOutbox, setMacOutboxLink } from './outbox';

/** Create the gateway client, wire every event into the store, and connect. */
export function useGatewayBoot(): { error?: string } {
  const [error, setError] = useState<string>();
  useEffect(() => {
    let offs: (() => void)[] = [];
    let cancelled = false;
    void initGateway()
      .then((client) => {
        if (cancelled) return;
        offs = [
          // while the cloud computer is on screen (features/cloud), this Mac's events wait: switching back reconnects
          client.onAny((event, payload) => {
            if (activeComputer() !== 'local') return;
            applyEvent(event, payload);
            // messages sent while it was away go now (lib/outbox.ts)
            if ((event as string) === 'hello') pumpOutbox();
          }),
          client.onState((state, err) => {
            if (activeComputer() !== 'local') return;
            setState({ conn: state, connError: err });
            // a gateway that refuses this window (or a stopped version) takes nothing: what waits shows "Not sent"
            if (state === 'unauthorized' || state === 'incompatible') failWaiting(err ?? 'AppuBot refused this message.', MAC_KEY);
            // after a reconnect, cached messages may be stale: mark them for reload
            if (state === 'reconnecting') {
              const convo = getState().convo;
              const next = Object.fromEntries(Object.entries(convo).map(([k, v]) => [k, { ...v, loaded: false, loading: false }]));
              setState({ convo: next });
            }
          }),
        ];
        setState({ conn: client.state });
        // messages to this Mac go through the same queue as a cloud computer's: shown at once, sent once it's connected
        if (!isVoiceBarView()) {
          setMacOutboxLink({
            onScreen: () => (activeComputer() === 'local' ? MAC_KEY : null),
            ready: () => (client.state === 'connected' && getState().hydrated ? client : null),
            wake: () => { if (client.state === 'idle' || client.state === 'closed') client.connect(); },
            waitMs: LOCAL_SEND_WAIT_MS,
          });
        }
        // the cloud account lives on this Mac (`cloudAccount.*`, whichever computer is on screen)
        if (!isVoiceBarView()) offs.push(watchCloud());
        if (client.snapshot) applyEvent('hello', client.snapshot);
        if (client.state === 'idle' || client.state === 'closed') client.connect();
      })
      .catch((e: unknown) => setError(errorMessage(e)));
    return () => { cancelled = true; offs.forEach((f) => f()); };
  }, []);
  return { error };
}
