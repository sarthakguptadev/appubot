/**
 * A turn that failed, as something a person can act on (2026-11-17, the owner's "for model errors and other stuff make
 * cards instead of a red error, with the ability to fix, like a model pick"): the agent's own error text read into
 * what went wrong in plain words and what puts it right (another model, a sign-in, a new thread, trying again). The
 * app draws it as a card with those fixes in it; the raw words stay available under it. Pure.
 */

export type FailureKind = 'not-installed' | 'model' | 'limit' | 'context' | 'sign-in' | 'network' | 'stopped' | 'other';
/**
 * What the card offers: `model` the chat's own model picker, `retry` the same message once more, `agents` Settings ›
 * Agents (install, sign in), `new-thread` a fresh thread.
 */
export type FailureFix = 'model' | 'retry' | 'agents' | 'new-thread';

export interface TurnFailure {
  kind: FailureKind;
  title: string;
  /** one line on what to do */
  body: string;
  /** best first */
  fixes: FailureFix[];
  /** what `agents` is called on its button for this failure */
  agentsLabel: string;
  /** the agent's own words, tidied to one short paragraph ('' when it said nothing) */
  detail: string;
}

const RULES: [FailureKind, RegExp][] = [
  ['not-installed', /not installed|isn['’]t installed|command not found|\benoent\b|executable (was )?not found|no such file or directory/],
  // before the rest: "model … unavailable" also reads as a network or permission failure
  ['model', /model[^.\n]{0,60}(not supported|unsupported|unavailable|not available|not found|does(n['’]t| not) exist|invalid|unknown|deprecated|no longer|not allowed|can['’]t be used)|unsupported model|requested model|no such model|model_not_found|invalid model/],
  ['limit', /usage limit|rate.?limit|quota|too many requests|\b429\b|limit (was )?reached|hit (your|the|its) limit|out of credits?|insufficient (credit|balance|funds|quota)|payment required|\b402\b|billing|launch bonus (has ended|is used up)|used up/],
  ['context', /context (length|window|limit)|context_length|maximum context|prompt is too long|too many tokens|token limit|input is too long|conversation is too long/],
  ['sign-in', /sign(ed)? ?(in|out)|log(ged)? ?(in|out)|login|unauthori[sz]ed|authenticat|invalid (api )?key|api key|\b401\b|\b403\b|forbidden|credentials|token (has )?(expired|is invalid)|permission_error/],
  // the agent's own process going away, before a connection that dropped on the way to the model
  ['stopped', /acp connection closed|agent (crashed|exited|stopped)|process exited|exited with (code|signal)|killed|sigterm|sigkill/],
  ['network', /network|econn|enotfound|etimedout|eai_again|timed? ?out|fetch failed|socket|connection (closed|reset|refused|error)|\b50[0234]\b|service unavailable|bad gateway|internal server error|overloaded|offline|dns|upstream/],
];

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** What kind of failure the agent's words describe. */
export function failureKind(error: string | undefined): FailureKind {
  const text = (error ?? '').toLowerCase();
  if (!text.trim()) return 'other';
  return RULES.find(([, re]) => re.test(text))?.[0] ?? 'other';
}

/**
 * The failure as the card says it. `agentName`: what runs the bot ("Claude Code", "OpenCode"), named where it is the
 * thing to fix; `asked`: the turn answered a message of the user's, so it can be sent again.
 */
export function turnFailure(error: string | undefined, who: { botName: string; agentName?: string; asked?: boolean }): TurnFailure {
  const kind = failureKind(error);
  const agent = who.agentName?.trim() || 'Its AI';
  const detail = clip((error ?? '').replace(/\s+/g, ' ').trim(), 400);
  const retry: FailureFix[] = who.asked ? ['retry'] : [];
  const base = { kind, detail, agentsLabel: 'Open Agents' };
  switch (kind) {
    case 'not-installed':
      return { ...base, title: `${agent} isn’t installed on this computer`, body: `Install it, or pick another AI for ${who.botName}.`, fixes: ['agents', 'model'], agentsLabel: 'Install it' };
    case 'model':
      return { ...base, title: 'That model can’t answer right now', body: `Pick another model for ${who.botName}${who.asked ? ', then try again' : ''}.`, fixes: ['model', ...retry] };
    case 'limit':
      return { ...base, title: `${agent} has reached its limit`, body: 'It comes back when the limit resets. Until then, another model or AI can carry on.', fixes: ['model', ...retry] };
    case 'context':
      return { ...base, title: 'This thread has more in it than the model can read', body: `A new thread starts short, and ${who.botName} brings its memory along. A model that reads more at once can also take this one.`, fixes: ['new-thread', 'model'] };
    case 'sign-in':
      return { ...base, title: `${agent} needs you to sign in`, body: `Sign in again, or pick another AI for ${who.botName}.`, fixes: ['agents', 'model', ...retry], agentsLabel: 'Sign in' };
    case 'network':
      // what didn't answer may be the model or something the bot called on its way (an app, a site): neither is blamed
      return { ...base, title: `A connection problem stopped ${who.botName}`, body: 'Something it needed didn’t answer. It usually passes.', fixes: [...retry, 'model'] };
    case 'stopped':
      return { ...base, title: `${agent} stopped before it finished`, body: 'It starts again with your next message.', fixes: [...retry, 'agents'] };
    default:
      return { ...base, title: `${who.botName} couldn’t finish`, body: detail ? '' : 'Something went wrong on the way.', fixes: [...retry, 'model'] };
  }
}
