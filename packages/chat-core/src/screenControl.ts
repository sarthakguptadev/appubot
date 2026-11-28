/**
 * Live view's Watching / Take control, as every app shows it (the phone's live view, the desktop app's screen viewer;
 * only the AppuBot apps: nothing of it is drawn on the computer's own screen or served as a page): a pill at the bottom of the screen with what you
 * are doing and one button, and the line a chat shows while its bot's computer step waits. One person at a time has
 * control; while they do, every bot's computer use waits, and control goes back on Watching, on leaving, or after
 * CONTROL_IDLE_MS without input (the last CONTROL_WARN_MS count down, with Keep control).
 */
import { CONTROL_WARN_MS, type ComputerStatus, type ScreenControl, type ScreenWait } from '@appubot/protocol';

/**
 * The screen a thread's bot uses the computer on: its own (your AppuBot computer, `ComputerStatus.screens`) while it
 * works or waits there, else the computer's main one. A chat's "working", its wait line and who has control are that
 * screen's.
 */
export function threadScreen(st: ComputerStatus | null | undefined, threadId: string | undefined): Pick<ComputerStatus, 'activeThreadId' | 'waits' | 'control'> | undefined {
  if (!st) return undefined;
  return ownScreen(st, threadId) ?? st;
}

/** The bot whose own screen a thread works or waits on (a chat's Watch opens that one); undefined: the computer's own. */
export function threadScreenBot(st: ComputerStatus | null | undefined, threadId: string | undefined): string | undefined {
  return st ? ownScreen(st, threadId)?.botId : undefined;
}

function ownScreen(st: ComputerStatus, threadId: string | undefined) {
  return threadId ? st.screens?.find((x) => x.activeThreadId === threadId || !!x.waits?.some((w) => w.threadId === threadId)) : undefined;
}

export type ControlAction = 'take' | 'give' | 'keep';
export interface ControlPill {
  /** `watching`: nobody has control; `other`: someone else has it; `mine`: you have it */
  mode: 'watching' | 'other' | 'mine';
  /** the pill's words beside the button */
  label: string;
  /** its button (null: none, e.g. a view-only device) */
  action: { kind: ControlAction; label: string; disabled?: boolean } | null;
  /** seconds left before control goes back by itself, while counting down */
  countdown?: number;
}

/** When control goes back by itself, on this view's clock: when the control was heard plus what was left then. */
export function controlDeadline(control: Pick<ScreenControl, 'left'>, heardAt: number): number {
  return heardAt + control.left;
}

/**
 * The pill: Watching + Take control by default; "<name> has control" with Take control off while someone else has
 * it; "You’re in control" + Give back while you have it, counting down (+ Keep control) near the end.
 * `canControl`: this device may use the screen (a limited one only watches). `deadline`: controlDeadline's.
 */
export function controlPill(o: { control: ScreenControl | null | undefined; mine: boolean; canControl: boolean; deadline?: number; now: number }): ControlPill {
  if (o.control && o.mine) {
    const left = o.deadline !== undefined ? Math.max(0, o.deadline - o.now) : o.control.left;
    if (left <= CONTROL_WARN_MS) {
      const s = Math.max(0, Math.ceil(left / 1000));
      return { mode: 'mine', label: `Giving back in ${s} s`, action: { kind: 'keep', label: 'Keep control' }, countdown: s };
    }
    return { mode: 'mine', label: 'You’re in control', action: { kind: 'give', label: 'Give back' } };
  }
  if (o.control) return { mode: 'other', label: `${o.control.name} has control`, action: o.canControl ? { kind: 'take', label: 'Take control', disabled: true } : null };
  return { mode: 'watching', label: 'Watching', action: o.canControl ? { kind: 'take', label: 'Take control' } : null };
}

/** A line under the pill saying what control means for the bots (null: nothing to add). */
export function controlNote(pill: ControlPill): string | null {
  if (pill.mode === 'mine') return pill.countdown !== undefined ? 'No input for a while: control goes back to your bots.' : 'Your bots wait until you give control back.';
  if (pill.mode === 'other') return 'Their bots wait until they give it back.';
  return null;
}

/**
 * What a chat says while its bot's computer step waits: for the person in control ("Paused while you’re in control"
 * on the view that has it), or for its turn on the screen ("Waiting for the screen: Ada is using it").
 */
export function screenWaitText(o: { wait: Pick<ScreenWait, 'for'>; control?: Pick<ScreenControl, 'name'> | null; mine: boolean; holderBot?: string }): string {
  if (o.wait.for === 'control') return o.mine ? 'Paused while you’re in control' : o.control ? `Paused while ${o.control.name} has control` : 'Paused while someone has control';
  return o.holderBot ? `Waiting for the screen: ${o.holderBot} is using it` : 'Waiting for the screen';
}
