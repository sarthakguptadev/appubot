/**
 * The line AppuBot holds on what a bot sends while it works (`send_message`, `agent.say`): short, never its last one
 * again, and no more in one turn than a bot caught in a loop would send. A refusal is the tool's own answer, in words the
 * bot can act on, so holding the line costs no model call beyond the turn that is running.
 */

/** A note's length at most, in characters as people count them (code points). */
export const NOTE_MAX_CHARS = 500;
/** how many one turn may send: far past any job's notes or any "send these as separate messages", so only a loop meets it */
export const NOTE_TURN_MAX = 30;

export interface NoteState {
  /** how many went out this turn */
  sent: number;
  /** the last one sent in this turn, as `sameNote` compares them */
  last?: string;
  /** the user wrote mid-job and the answer hasn't gone out yet: it goes whatever `sent` says */
  owed?: boolean;
}

export const newNoteState = (): NoteState => ({ sent: 0 });

/**
 * What a bot reads when it sends a note on a routine's run. Nobody watches a run that started on schedule, and a note
 * is a bubble of its own: with one, a run that had nothing to say ("✓") would no longer fold away, and would mark the
 * chat unread and notify every time it ran. What the run found goes in its reply.
 */
export const ROUTINE_NOTE_REASON = 'Not sent: this message came from one of the user’s routines, on schedule, so nobody is waiting to hear how it goes. Carry on, and put everything the user should know in your reply at the end.';

/** What two notes are compared by: their letters and digits, whatever the case, spacing, punctuation or emoji. */
export function noteKey(text: string): string {
  const key = text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return key || text.trim();
}

/**
 * Whether `text` may go out now; when it may, `state` counts it. `reason` is what the bot reads when it may not.
 */
export function takeNote(state: NoteState, text: string): { ok: true } | { ok: false; reason: string } {
  const chars = [...text].length;
  if (chars > NOTE_MAX_CHARS) {
    return { ok: false, reason: `Not sent: ${chars} characters is too long for a message sent while you work (${NOTE_MAX_CHARS} at most). Send the short version; the rest belongs in your reply at the end.` };
  }
  const key = noteKey(text);
  if (state.last === key) return { ok: false, reason: 'Not sent: you already told the user exactly that. Carry on, and send another when there is something new to say.' };
  if (state.owed) state.owed = false;
  else if (state.sent >= NOTE_TURN_MAX) {
    return { ok: false, reason: 'Not sent: that is far more messages than one reply needs. Send no more: carry on with the job, and put the rest in your reply at the end.' };
  }
  state.sent += 1;
  state.last = key;
  return { ok: true };
}
