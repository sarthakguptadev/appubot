/**
 * A routine in the chat (shared by the desktop's and the phone's transcripts): its prompt is one compact line named after
 * the routine, never a full bubble, and its runs that had nothing to say ("✓", "No new items") fold into one line,
 * "Asana check ran 14 times · last 13:50", that opens to show them. A run with a real answer, a failure, one still
 * working or waiting on the person, or anything else between two runs (a message of yours, another turn, a new day)
 * shows as it is, so nothing is lost. The computer uses the same rule (`isNothingNewRun`) to keep such a run from
 * notifying, marking the chat unread or becoming the roster's preview.
 */
import { stripMarkdown, type Message, type Part } from '@appubot/protocol';
import { clockTime } from './format';
import { answerOnly, layoutTurn } from './turn';

/** what a prompt from before routines were named on their messages (or from an older computer) is called */
export const ROUTINE_NAME_FALLBACK = 'Routine';
/** a reply longer than this always has something to say */
export const NOTHING_NEW_MAX_CHARS = 48;
/** nor does one with more words than this ("No new tasks in the marketing project" is still nothing) */
const NOTHING_NEW_MAX_WORDS = 7;

/** The fields the fold reads (older messages have no `routine`; a stub reply none of the optional ones). */
export type FoldMessage = Pick<Message, 'id' | 'role' | 'via' | 'parts' | 'status' | 'createdAt'> & Partial<Pick<Message, 'routine' | 'error' | 'stopReason' | 'reactions'>>;

/** Which routine sent a prompt: `key` tells runs of one routine from another's (by id, else by the prompt's words). */
export interface RoutineRef { key: string; name: string; id?: string }

const textOf = (parts: readonly Part[]) => parts.map((p) => (p.type === 'text' ? p.text : '')).join('\n').trim();

/** A routine's prompt (a user message it sent), or null for any other message. */
export function routineOf(m: Pick<FoldMessage, 'role' | 'via' | 'parts' | 'routine'>): RoutineRef | null {
  if (m.role !== 'user' || m.via !== 'routine') return null;
  if (m.routine?.id) return { key: `id:${m.routine.id}`, name: m.routine.name.trim() || ROUTINE_NAME_FALLBACK, id: m.routine.id };
  // from before routines were named on their messages: the same words are the same routine
  return { key: `prompt:${textOf(m.parts)}`, name: ROUTINE_NAME_FALLBACK };
}

/**
 * Exact replies (lower case, punctuation and emoji gone) and the openings of short ones that say there is nothing new.
 * English first; then the app's other common languages. A reply in a language not here simply isn't folded.
 */
const ACKS = new Set([
  'ok', 'okay', 'done', 'checked', 'nothing', 'none', 'nope', 'no reply', 'no_reply', 'noreply',
  'kész', 'rendben', 'nincs', 'erledigt', 'nichts', 'fait', 'rien', 'hecho', 'nada', 'fatto', 'niente', 'feito', 'klaar', 'niets', 'gotowe', 'nic', 'готово', 'ничего',
]);
const LEADS = [
  'no new', 'nothing new', 'no news', 'no update', 'no updates', 'no change', 'no changes', 'nothing changed', 'nothing to report',
  'nothing to do', 'nothing found', 'nothing to see', 'no notifications', 'no unread', 'no mentions', 'no messages', 'no emails',
  'no tasks', 'no alerts', 'all clear', 'all good', 'all quiet', 'all caught up', 'up to date', 'still nothing',
  // Hungarian, German, French, Spanish, Italian, Portuguese, Dutch, Polish, Russian, Turkish
  'nincs új', 'nincs újdonság', 'nincs semmi', 'nichts neues', 'keine neuen', 'keine neuigkeiten', 'keine änderungen',
  'rien de nouveau', 'rien à signaler', 'aucune nouveauté', 'aucun nouveau', 'aucune nouvelle', 'nada nuevo', 'sin novedades', 'nada que reportar',
  'niente di nuovo', 'nessuna novità', 'nessun nuovo', 'nada de novo', 'sem novidades', 'nenhuma novidade', 'niets nieuws', 'geen nieuwe', 'geen nieuws',
  'brak nowości', 'brak nowych', 'nic nowego', 'ничего нового', 'нет новостей', 'нет новых', 'yeni bir şey yok', 'yeni yok',
];
/** a clause that carries on after "nothing new" ("…, but Anna asked about the logo") is news */
const CARRIES_ON = /[,;:(]|\s(?:but|except|however|though|aber|außer|mais|sauf|pero|excepto|tranne|exceto|maar|behalve|ale|oprócz|но|кроме|kivéve|ama)\s/i;

/**
 * Whether a reply's words say there is nothing new: nothing at all, only marks ("✓", "✅", "👍", "—"), an
 * acknowledgement ("OK", "Done") or a short "nothing new" in a few words ("No new notifications.", "Nincs újdonság").
 * Never with a number, a link, a second line, more than `NOTHING_NEW_MAX_CHARS` or a clause that carries on.
 */
export function isNothingNewText(text: string): boolean {
  const t = stripMarkdown(text).trim();
  if (!t) return true;
  if (t.length > NOTHING_NEW_MAX_CHARS) return false;
  // only marks: no letter or digit in any script
  if (!/[\p{L}\p{N}]/u.test(t)) return true;
  if (/\n/.test(t) || /\p{N}/u.test(t) || /https?:\/\/|www\.|@\w/i.test(t) || CARRIES_ON.test(t)) return false;
  const words = t.toLowerCase().replace(/[^\p{L}\s_]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!words || words.split(' ').length > NOTHING_NEW_MAX_WORDS) return false;
  if (ACKS.has(words)) return true;
  return LEADS.some((lead) => words === lead || words.startsWith(`${lead} `));
}

/**
 * Whether a finished reply has nothing to say: complete (not failed, cancelled or still going), no reaction on it,
 * nothing in it but its words, thoughts and tool calls that changed no file (no question, card, file, picture, voice,
 * page, plan or notice), and what the answers view shows of it (`answerOnly`: the narration before its tool calls
 * doesn't count) passes `isNothingNewText`.
 */
export function isNothingNewReply(reply: Pick<FoldMessage, 'role' | 'parts' | 'status'> & Partial<Pick<Message, 'error' | 'stopReason' | 'reactions'>>): boolean {
  if (reply.role !== 'agent' || reply.status !== 'complete' || reply.error || reply.stopReason === 'cloud_paused' || reply.reactions?.length) return false;
  for (const p of reply.parts) {
    if (p.type === 'text' || p.type === 'thought') continue;
    if (p.type === 'tool_call' && !p.content?.some((c) => c.type === 'diff')) continue;
    return false;
  }
  const answer = answerOnly(layoutTurn(reply.parts as Part[]));
  const texts = answer.flatMap((x) => (x.part.type === 'text' && x.part.text.trim() ? [x.part.text] : []));
  if (texts.length > 1) return false;
  return isNothingNewText(texts[0] ?? '');
}

/** A routine's run (its prompt and the replies to it) that had nothing to say: exactly one reply, and that one empty of news. */
export function isNothingNewRun(prompt: Pick<FoldMessage, 'role' | 'via' | 'parts' | 'routine'>, replies: readonly Parameters<typeof isNothingNewReply>[0][]): boolean {
  if (!routineOf(prompt) || prompt.parts.some((p) => p.type !== 'text')) return false;
  return replies.length === 1 && isNothingNewReply(replies[0]!);
}

/**
 * Whether the reply `replyId` in a chat's messages (in order) ends a routine's run that had nothing to say: what an app
 * reads when the computer's `message.completed` says nothing (an older computer), to keep it from marking the chat unread.
 */
export function endsNothingNewRun(messages: readonly FoldMessage[], replyId: string): boolean {
  const at = messages.findIndex((m) => m.id === replyId);
  if (at < 0 || messages[at]!.role !== 'agent') return false;
  let start = at;
  while (start > 0 && messages[start - 1]!.role === 'agent') start--;
  const prompt = messages[start - 1];
  if (!prompt) return false;
  let end = at + 1;
  while (end < messages.length && messages[end]!.role === 'agent') end++;
  return isNothingNewRun(prompt, messages.slice(start, end));
}

/** One run in a fold: its prompt, its reply, when it ran and what it said. */
export interface RoutineRun { promptId: string; replyId: string; at: number; reply: string }

/** Runs of one routine with nothing to say, in a row: one line in the chat. */
export interface RoutineFold {
  kind: 'routine-fold';
  /** stays the same as runs join it (its first run's), so the row isn't drawn anew */
  key: string;
  routine: RoutineRef;
  runs: RoutineRun[];
  /** every message it holds, in order */
  ids: string[];
  /** where its first message sits in the list given */
  index: number;
  lastAt: number;
}
export interface MessageItem { kind: 'message'; key: string; id: string; index: number }
export type TranscriptItem = MessageItem | RoutineFold;

export interface FoldOptions {
  /** a message's row key (the apps' `rowKeyOf`, so a sent copy keeps its row); its id by default */
  keyOf?: (id: string) => string;
  /**
   * the separators above each message (`conversationSeparators`): a run under one starts a fold of its own, and a run
   * with one inside it isn't folded, so a new day or a sitting's start always shows
   */
  separators?: readonly (string | null)[];
}

/** The reply's words as the fold line shows them ("✓"), one line, short. */
function replyWords(reply: Pick<FoldMessage, 'parts'>): string {
  const answer = answerOnly(layoutTurn(reply.parts as Part[]));
  const text = answer.map((x) => (x.part.type === 'text' ? x.part.text : '')).join(' ');
  return stripMarkdown(text).replace(/\s+/g, ' ').trim().slice(0, NOTHING_NEW_MAX_CHARS);
}

/**
 * The transcript's rows: each message as itself, except runs of one routine in a row that had nothing to say, which
 * become one `RoutineFold`. Any other message between two runs (yours, another turn, a run with news or still going)
 * ends the fold; so does a separator (`opts.separators`). Pure: the apps call it on what they hold.
 */
export function foldRoutineRuns(messages: readonly FoldMessage[], opts: FoldOptions = {}): TranscriptItem[] {
  const keyOf = opts.keyOf ?? ((id: string) => id);
  const seps = opts.separators;
  const out: TranscriptItem[] = [];
  let fold: RoutineFold | null = null;
  let i = 0;
  while (i < messages.length) {
    const m = messages[i]!;
    const routine = routineOf(m);
    if (routine) {
      let j = i + 1;
      while (j < messages.length && messages[j]!.role === 'agent') j++;
      const replies = messages.slice(i + 1, j);
      const split = !!seps && replies.some((_, k) => !!seps[i + 1 + k]);
      if (!split && isNothingNewRun(m, replies)) {
        const reply = replies[0]!;
        if (!fold || fold.routine.key !== routine.key || seps?.[i]) {
          fold = { kind: 'routine-fold', key: `routine-fold:${keyOf(m.id)}`, routine, runs: [], ids: [], index: i, lastAt: m.createdAt };
          out.push(fold);
        }
        // the newest name wins (a routine renamed between runs)
        if (routine.id) fold.routine = routine;
        fold.runs.push({ promptId: m.id, replyId: reply.id, at: m.createdAt, reply: replyWords(reply) });
        fold.ids.push(m.id, reply.id);
        fold.lastAt = m.createdAt;
        i = j;
        continue;
      }
    }
    fold = null;
    out.push({ kind: 'message', key: keyOf(m.id), id: m.id, index: i });
    i++;
  }
  return out;
}

/** A fold's line: "Asana check ran 14 times · last 13:50" ("Asana check ran at 13:50" for one), and its last reply ("✓"). */
export function routineFoldText(f: Pick<RoutineFold, 'routine' | 'runs' | 'lastAt'>): { label: string; reply: string; a11y: string } {
  const n = f.runs.length;
  const label = n === 1 ? `${f.routine.name} ran at ${clockTime(f.lastAt)}` : `${f.routine.name} ran ${n} times · last ${clockTime(f.lastAt)}`;
  const reply = f.runs[n - 1]?.reply ?? '';
  return { label, reply, a11y: `${label}, nothing new${reply ? ` (${reply})` : ''}` };
}

/** A routine's prompt as its compact line: the routine's name and when it ran ("Asana check · 13:50"). */
export function routinePromptText(m: Pick<FoldMessage, 'role' | 'via' | 'parts' | 'routine' | 'createdAt'>): { name: string; time: string; prompt: string } {
  return { name: routineOf(m)?.name ?? ROUTINE_NAME_FALLBACK, time: clockTime(m.createdAt), prompt: textOf(m.parts) };
}
