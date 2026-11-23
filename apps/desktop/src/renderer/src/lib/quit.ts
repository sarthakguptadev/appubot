import { useEffect } from 'react';
import { native } from './native';
import { THIS_MACHINE } from './platform';
import { getState, setState, useStore } from './store';

const overlayUp = (conn: string): boolean => conn === 'closed' || conn === 'unauthorized';

/**
 * Main asks before AppuBot quits (the tray's Quit, Dock › Quit): QuitDialog in ModalHost shows it. Without an ack
 * (the splash or the connection overlay is up) main asks with a native dialog instead.
 */
export function useQuitPrompt(): void {
  useEffect(() => native().onQuitRequest(({ id, working }) => {
    const s = getState();
    if (!s.hydrated || overlayUp(s.conn)) return;
    native().quitAck(id);
    setState({ quitPrompt: { id, working } });
  }), []);
  // main gave up on it (a late ack, a hang): its answer would go nowhere
  useEffect(() => native().onQuitCancel((id) => {
    if (getState().quitPrompt?.id === id) setState({ quitPrompt: null });
  }), []);

  // the overlay would cover the dialog: count it as Cancel (quitting again asks natively)
  const conn = useStore((s) => s.conn);
  useEffect(() => { if (overlayUp(conn)) answerQuit(false); }, [conn]);
}

export function answerQuit(ok: boolean): void {
  const p = getState().quitPrompt;
  if (!p) return;
  setState({ quitPrompt: null });
  native().answerQuit(p.id, ok);
}

export function quitBody(working: number): string {
  const now = working ? `${working} bot${working === 1 ? ' is' : 's are'} working right now and will stop. ` : '';
  return `${now}Your bots and routines stop, your phone can’t reach ${THIS_MACHINE}, and Telegram goes quiet until you open AppuBot again.`;
}
