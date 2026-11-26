/**
 * The line AppuBot holds on what a bot sends while it works (`send_message`, `agent.say`): a few lines, not too
 * often, never its last one again. A refusal is the tool's own answer, in words the bot can act on, so holding the line
 * costs no model call beyond the turn that is running.
 */

/** A note's length at most, in characters as people count them (code points). */
export const NOTE_MAX_CHARS = 500;
/** how many may go out in a row */
export const NOTE_BURST = 3;
/** after those, one more each */
export const NOTE_EVERY_MS = 60_000;

export interface NoteState {
  /** what it has saved up, in milliseconds: a note costs `NOTE_EVERY_MS`, a millisecond earns one, `NOTE_BURST` notes' worth at most */
  credit: number;
  /** when `credit` was last counted */
  at: number;
  /** the last one sent in this turn, as `sameNote` compares them */
  last?: string;
  /** the user wrote mid-job and the answer hasn't gone out yet: it goes whatever `credit` says */
  owed?: boolean;
}

export const newNoteState = (now: number): NoteState => ({ credit: NOTE_BURST * NOTE_EVERY_MS, at: now });

/** What two notes are compared by: their letters and digits, whatever the case, spacing, punctuation or emoji. */
export function noteKey(text: string): string {
  const key = text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return key || text.trim();
}

/**
 * Whether `text` may go out now; when it may, `state` counts it. `reason` is what the bot reads when it may not.
 */
export function takeNote(state: NoteState, text: string, now: number): { ok: true } | { ok: false; reason: string } {
  const chars = [...text].length;
  if (chars > NOTE_MAX_CHARS) {
    return { ok: false, reason: `Not sent: ${chars} characters is too long for a message sent while you work (${NOTE_MAX_CHARS} at most). Send the short version; the rest belongs in your reply at the end.` };
  }
  const key = noteKey(text);
  if (state.last === key) return { ok: false, reason: 'Not sent: you already told the user exactly that. Carry on, and send another when there is something new to say.' };
  state.credit = Math.min(NOTE_BURST * NOTE_EVERY_MS, state.credit + Math.max(0, now - state.at));
  state.at = now;
  if (state.owed) state.owed = false;
  else if (state.credit < NOTE_EVERY_MS) {
    // it is never told how long until the next one: told "in 53 seconds", a model slept 56 and sent it (2026-11-26)
    return { ok: false, reason: `Not sent: that is too many messages in a row (${NOTE_BURST}, then one a minute). Don't wait and don't send it again: carry on with the job, and put what you found in your reply at the end.` };
  } else state.credit -= NOTE_EVERY_MS;
  state.last = key;
  return { ok: true };
}
