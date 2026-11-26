/**
 * A bot's own follow-ups (2026-11-26, the owner's ask: "add like agent gen some with its final message as well like
 * helpful things user would wanna follow up with"): up to four short things the person would likely ask next, which
 * the apps offer as pills under the chat's newest message, where a tap sends the line as the person's next message.
 *
 * The bot writes them at the very end of its reply, one per line, in a block the computer takes out of the text:
 *
 *     <followups>
 *     Email it to the team
 *     Make it shorter
 *     </followups>
 *
 * In the reply and not through a tool on purpose: a tool call ends a model step and the agent then calls the model
 * once more with the whole conversation, so a tool would cost a model request on every turn that used it. The block
 * costs a few words of the request the bot is already making, and works with every agent that reads its instructions.
 *
 * Pure: the computer feeds a reply's text through `FollowUpsStream` as it arrives, so the block is never shown,
 * stored as text, read aloud or sent on to Telegram.
 */

/** How many follow-ups one reply may carry. */
export const FOLLOW_UPS_MAX = 4;
/** The longest a follow-up may be, in characters: a few words, a pill's worth. A longer line is left out. */
export const FOLLOW_UP_MAX_CHARS = 60;

/** One line as the person would send it: no bullet or number before it, no quotes or emphasis round it. */
function cleanLine(line: string): string {
  return line
    .replace(/\s+/g, ' ').trim()
    .replace(/^(?:[-*•–—]|\d{1,2}[.)])\s+/, '')
    .replace(/^["'“”‘’«»`*_]+|["'“”‘’«»`*_]+$/g, '')
    .trim();
}

/** The same line however it was written (capitals, spaces): two of these are one follow-up. */
export const followUpKey = (line: string): string => line.replace(/\s+/g, ' ').trim().toLocaleLowerCase();

/**
 * The follow-ups worth showing of the lines a bot gave: cleaned, without empty ones, ones too long to be a pill and
 * ones said twice, and no more than `FOLLOW_UPS_MAX`.
 */
export function cleanFollowUps(lines: readonly unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of lines) {
    if (out.length >= FOLLOW_UPS_MAX) break;
    if (typeof raw !== 'string') continue;
    const line = cleanLine(raw);
    if (!line || [...line].length > FOLLOW_UP_MAX_CHARS) continue;
    const key = followUpKey(line);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out;
}

/** how a bot may spell the tag */
const TAGS = ['<followups>', '<follow-ups>', '<follow_ups>'];
const OPEN = /<follow[-_]?ups>/i;
const CLOSE = /<\/follow[-_]?ups>/i;
/** a line that opens or closes a code fence */
const FENCE = /^[ \t]*(?:`{3,}|~{3,})[\w+.#-]*[ \t]*$/;
/** the same, or the first marks of one still arriving */
const FENCE_SO_FAR = /^[ \t]*(?:[`~]{1,2}|`{3,}[\w+.#-]*|~{3,}[\w+.#-]*)[ \t]*$/;
/** of two gaps between paragraphs, the one with more line breaks */
const wider = (a: string, b: string): string => (b.split('\n').length > a.split('\n').length ? b : a);

/** Where shown text stands after `text` more of it: its last line so far, and whether a code fence is left open before that line. */
function fenceAfter(line: string, open: boolean, text: string): { line: string; open: boolean } {
  const lines = (line + text).split('\n');
  const last = lines.pop()!;
  for (const l of lines) if (FENCE.test(l)) open = !open;
  return { line: last, open };
}

/**
 * A reply's text as it streams in, with its follow-ups block held back. `push` returns what may be shown now: the
 * text up to a block, less whatever at its end could still turn into one (white space, the first letters of the tag).
 * `end` says what the text ended with: the block's lines, or the held text when it was no block after all.
 *
 * A block only counts as the reply's last words: when the bot goes on writing after it, the block is dropped and
 * what follows is shown. Whatever becomes of its lines, the block itself is never shown: not cut short (in its
 * tag or in a line), not in the middle of a reply, not twice, not wrapped in a code fence (the fence a bot put round
 * its block goes with it).
 */
export class FollowUpsStream {
  /**
   * not shown yet: white space, the start of a tag or a line opening a code fence at the text's end, or (`block`) the
   * block and what leads to it
   */
  private held = '';
  private block = false;
  /** the block came in a code fence of its own, whose opening line waits in `held` with it */
  private fenced = false;
  /** the last line shown, not yet ended, and whether the lines shown before it leave a code fence open */
  private line = '';
  private inFence = false;

  push(delta: string): string {
    this.held += delta;
    return this.block ? this.pastBlock() : this.scan();
  }

  end(): { text: string; followUps: string[] } {
    const held = this.held;
    this.held = '';
    if (!this.block) {
      // cut off in the opening tag's first letters: they go, with the white space and the fence line that led to them
      const lt = held.lastIndexOf('<');
      const tag = lt >= 0 && held.length - lt > 1 && TAGS.some((t) => t.startsWith(held.slice(lt).toLowerCase()));
      return { text: tag ? '' : held, followUps: [] };
    }
    this.block = false;
    this.fenced = false;
    const open = OPEN.exec(held)!;
    let body = held.slice(open.index + open[0].length);
    const close = CLOSE.exec(body);
    if (close) body = body.slice(0, close.index);
    else {
      // cut short (the turn ran out of words): the lines that were finished, each by a line break or a tag after it.
      // A last line still being written is left out: half of one is nothing the person would send.
      const tag = /<\/?[a-z_-]*$/i.exec(body);
      if (tag) body = body.slice(0, tag.index);
      else body = body.slice(0, Math.max(body.lastIndexOf('\n'), body.lastIndexOf('>')) + 1);
    }
    // a tag round each line (<followup>…</followup>) is only another way to separate them
    return { text: '', followUps: cleanFollowUps(body.replace(/<\/?[a-z][^>\n]*>/gi, '\n').split(/\r?\n/)) };
  }

  /** Not in a block: show what can no longer be the start of one. */
  private scan(): string {
    const buf = this.held;
    const open = OPEN.exec(buf);
    let end = open ? open.index : buf.length;
    if (!open) {
      const lt = buf.lastIndexOf('<');
      if (lt >= 0 && TAGS.some((t) => t.startsWith(buf.slice(lt).toLowerCase()))) end = lt;
    }
    let keep = buf.slice(0, end).trimEnd().length;
    // the text's last line opens a code fence: a bot may be wrapping its block in one, so that line waits as well
    const nl = keep > 0 ? buf.lastIndexOf('\n', keep - 1) : -1;
    const fence = keep > 0 && (nl >= 0 || this.line === '') && FENCE_SO_FAR.test(buf.slice(nl + 1, keep))
      && !fenceAfter(this.line, this.inFence, buf.slice(0, nl + 1)).open;
    if (fence) keep = buf.slice(0, nl + 1).trimEnd().length;
    this.held = buf.slice(keep);
    const shown = buf.slice(0, keep);
    ({ line: this.line, open: this.inFence } = fenceAfter(this.line, this.inFence, shown));
    if (!open) return shown;
    this.block = true;
    this.fenced = fence;
    return shown + this.pastBlock();
  }

  /** In a block: nothing shows, unless the bot wrote on after closing it; then the block goes and that text shows. */
  private pastBlock(): string {
    const close = CLOSE.exec(this.held);
    if (!close) return '';
    const after = this.held.slice(close.index + close[0].length);
    // nothing after it, or only the end of the fence it came in (as much of that as has arrived)
    if (!after.trim() || (this.fenced && /^\s*[`~]*\s*$/.test(after))) return '';
    const head = this.held.slice(0, OPEN.exec(this.held)!.index);
    // the fence held only the block: it goes with it. One with more in it after the block is the bot's own code.
    const closing = this.fenced ? /^\s*(?:`{3,}|~{3,})[ \t]*(?=\n|$)/.exec(after) : null;
    const rest = closing ? after.slice(closing[0].length) : after;
    const gap = /^\s*/.exec(rest)![0];
    this.held = this.fenced && !closing ? head + rest.slice(gap.length) : wider(/^\s*/.exec(head)![0], gap) + rest.slice(gap.length);
    this.block = false;
    this.fenced = false;
    return this.scan();
  }
}

/** A whole reply's text and its follow-ups, apart. */
export function splitFollowUps(text: string): { text: string; followUps: string[] } {
  const stream = new FollowUpsStream();
  const shown = stream.push(text);
  const end = stream.end();
  return { text: shown + end.text, followUps: end.followUps };
}
