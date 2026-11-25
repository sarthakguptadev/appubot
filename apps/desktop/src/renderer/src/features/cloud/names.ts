/**
 * What the desktop calls the paid computer. The hosted machine is "your AppuBot computer" in sentences; short UI names
 * it "Sarthak’s Cloud Computer" and a team's "Acme Cloud Computer" with a cloud icon (chat-core `computerDisplayName`,
 * both apps and the backend; the owner's call, 2026-11-06), beside this Mac by its own name ("Sarthak’s MacBook Pro",
 * lib/macName.ts), described in sentences as "Acme's AppuBot computer". Internal code names (`cloud*`,
 * `cloudAccount.*`) stay. The desktop's own words live here; the ones both apps show are in chat-core's `cloud.ts`.
 */
import { CLOUD_ENDED_KEEP_DAYS, CLOUD_KEEP_DAYS, keepDaysText, shortDate } from '@appubot/chat-core';

export const COMPUTER_NAME = 'AppuBot computer';
export const YOUR_COMPUTER = `your ${COMPUTER_NAME}`;
/** "Your AppuBot computer" at the start of a sentence */
export const YOUR_COMPUTER_CAP = `Your ${COMPUTER_NAME}`;

/** "Acme’s AppuBot computer" */
export function teamComputerLong(teamName: string | undefined): string {
  const n = teamName?.trim();
  return n ? `${n}’s ${COMPUTER_NAME}` : `The team’s ${COMPUTER_NAME}`;
}

/** a payment on hold: the stopped computer is kept a day, then deleted (`until`: that day, when the backend said it) */
export function onHoldText(until?: number, now = Date.now()): string {
  return `${YOUR_COMPUTER_CAP} is paused: the payment didn’t go through. Your bots and files are kept ${until ? `until ${shortDate(until, now)}` : `for ${keepDaysText(CLOUD_KEEP_DAYS)}`}, then deleted; update your card in Settings › Billing to carry on.`;
}

/** the plan has ended: "Your Pro plan has ended…" (the plan's name when known); the stopped computer is kept a day, then deleted */
export function exportOnlyText(planName?: string, until?: number, now = Date.now()): string {
  const lead = `Your ${planName ? `${planName} plan` : 'plan'} has ended.`;
  return until
    ? `${lead} Your bots and files are kept until ${shortDate(until, now)}, then deleted: subscribe again in Settings › Billing to get them back.`
    : `${lead} Your bots and files are kept for ${keepDaysText(CLOUD_ENDED_KEEP_DAYS)}, then deleted: subscribe again in Settings › Billing to get them back.`;
}

export const SOLD_OUT_TEXT = `New ${COMPUTER_NAME}s are sold out for now. We’re adding room: check back soon.`;
