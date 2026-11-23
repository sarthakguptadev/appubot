/**
 * Goals (protocol `GoalSchema`): a bot works toward one on its own in a thread, turn after turn, until it says it's
 * done or stuck (`finish_goal`), or its turns or time run out. The words of its card, the prompt that sends it on
 * after each turn, and the line the apps show above the composer.
 */
import { GOAL_TURNS_DEFAULT, type FormField, type Goal } from '@appubot/protocol';

/** What a goal's budget counts: a bot's turns in its chat, or the bots' messages in a group. */
export type GoalUnit = 'turns' | 'messages';
import { formatDuration } from './format';

/** A goal card's fields: the objective (the user may sharpen it) and how many turns it may take. */
export function goalCardFields(objective: string, maxTurns = GOAL_TURNS_DEFAULT, unit: GoalUnit = 'turns'): FormField[] {
  return [
    { id: 'objective', label: 'Goal', type: 'longtext', required: true, options: [], value: objective },
    { id: 'turns', label: unit === 'messages' ? 'Messages between the bots, at most' : 'Turns at most', type: 'number', required: true, options: [], value: String(maxTurns), placeholder: String(maxTurns) },
  ];
}

/**
 * What the bot is told after each turn while its goal is on (a hidden prompt: it never shows as a message). Turn
 * numbers count from 1.
 */
export function goalPrompt(goal: Pick<Goal, 'objective' | 'turns' | 'maxTurns'>): string {
  const next = goal.turns + 1;
  const left = goal.maxTurns - goal.turns;
  return [
    `(Goal, turn ${next} of ${goal.maxTurns}: nobody wrote this, AppuBot sends it after each of your turns while the goal is on.)`,
    `Keep working toward the goal: ${goal.objective}`,
    'Do the next step yourself; say what you did in a line or two. Don\'t ask the user to confirm routine steps.',
    'When the goal is achieved, call finish_goal with status "done" and a short note of what you did.',
    'If you can\'t go on without the user (a decision, a login, something only they have), call finish_goal with status "blocked" and say exactly what you need.',
    left <= 2 ? `Only ${left} turn${left === 1 ? '' : 's'} left: wrap up, or finish as blocked with what remains.` : '',
  ].filter(Boolean).join('\n');
}

/** The goal bar's status line: "Turn 3 of 20 · 4m", "Done", "Paused · out of turns"… */
export function goalStatusLine(goal: Goal, now: number, unit: GoalUnit = 'turns'): string {
  const ran = formatDuration(Math.max(0, (goal.status === 'active' ? now : goal.updatedAt) - goal.startedAt));
  const one = unit === 'messages' ? 'message' : 'turn';
  const n = (k: number) => `${k} ${one}${k === 1 ? '' : 's'}`;
  switch (goal.status) {
    case 'active': return unit === 'messages' ? `${goal.turns} of ${goal.maxTurns} messages · ${ran}` : `Turn ${Math.min(goal.turns + 1, goal.maxTurns)} of ${goal.maxTurns} · ${ran}`;
    case 'paused': return `Paused after ${n(goal.turns)}${goal.note ? ` · ${goal.note}` : ''}`;
    case 'done': return `Done in ${n(goal.turns)} · ${ran}`;
    case 'blocked': return 'Needs you';
    case 'stopped': return 'Stopped';
  }
}
