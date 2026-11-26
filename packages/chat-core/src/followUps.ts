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

/**
 * A reply's text as it streams in, with its follow-ups block held back. `push` returns what may be shown now: the
 * text up to a block, less whatever at its end could still turn into one (white space, the first letters of the tag).
 * `end` says what the text ended with: the block's lines, or the held text when it was no block after all.
 *
 * A block only counts as the reply's last words: when the bot goes on writing after it, the block is dropped and
 * what follows is shown.
 */
export class FollowUpsStream {
  /** not shown yet: white space and the start of a tag at the text's end, or (`block`) the block and what leads to it */
  private held = '';
  private block = false;

  push(delta: string): string {
    this.held += delta;
    return this.block ? this.pastBlock() : this.scan();
  }

  end(): { text: string; followUps: string[] } {
    const held = this.held;
    this.held = '';
    if (!this.block) return { text: held, followUps: [] };
    this.block = false;
    const open = OPEN.exec(held)!;
    let body = held.slice(open.index + open[0].length);
    const close = CLOSE.exec(body);
    // cut short (the turn ran out of words): what there is of it, without the half-written closing tag
    body = close ? body.slice(0, close.index) : body.replace(/<\/?[a-z_-]*$/i, '');
    // a tag round each line (<followup>…</followup>) is only another way to separate them
    return { text: '', followUps: cleanFollowUps(body.replace(/<\/?[a-z][^>\n]*>/gi, '\n').split(/\r?\n/)) };
  }

  /** Not in a block: show what can no longer be the start of one. */
  private scan(): string {
    const buf = this.held;
    const open = OPEN.exec(buf);
    if (open) {
      const shown = buf.slice(0, open.index).trimEnd();
      this.held = buf.slice(shown.length);
      this.block = true;
      return shown + this.pastBlock();
    }
    let keep = buf.length;
    const lt = buf.lastIndexOf('<');
    if (lt >= 0 && TAGS.some((t) => t.startsWith(buf.slice(lt).toLowerCase()))) keep = lt;
    keep = buf.slice(0, keep).trimEnd().length;
    this.held = buf.slice(keep);
    return buf.slice(0, keep);
  }

  /** In a block: nothing shows, unless the bot wrote on after closing it; then the block goes and that text shows. */
  private pastBlock(): string {
    const close = CLOSE.exec(this.held);
    if (!close) return '';
    const after = this.held.slice(close.index + close[0].length);
    if (!after.trim()) return '';
    const lead = /^\s*/.exec(this.held)![0];
    this.block = false;
    this.held = lead + after.trimStart();
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
