/** What the channels service (channels.ts) and each Telegram bot's runner (telegramRunner.ts) share: Telegram's errors in words, the retry waits, a bot's profile as Telegram shows it. */
import { randomInt } from 'node:crypto';
import { Agent as HttpsAgent } from 'node:https';
import { GrammyError, HttpError } from 'grammy';
import type { Bot } from '@appubot/protocol';
import { characterKey, type CharacterFigure } from '@appubot/chat-core';
import { errMsg } from '../util';

/** the id of the first Telegram channel (from before there could be several) */
export const FIRST_TELEGRAM = 'telegram';

/** What a Telegram bot whose token another AppuBot computer holds is told (the Mac finds the cloud's webhook, or the other way round). */
export const TOKEN_ELSEWHERE = 'This Telegram bot is connected to another AppuBot computer. Disconnect it there first, then connect it here.';
/** The cloud computer's Telegram bots wait for the backend to tell the computer its public address. */
export const NO_PUBLIC_URL = 'Waiting for this computer’s AppuBot Cloud address.';
/** the updates a webhook is asked for: what the runner handles */
export const WEBHOOK_UPDATES = ['message', 'callback_query'] as const;

export const newCode = (): string => String(randomInt(0, 1_000_000)).padStart(6, '0');

/**
 * One keep-alive connection pool to Telegram for every bot here. grammY keeps one of its own per process that nothing
 * can reach; this one is dropped by `ChannelsService.afterWake` (a sleep checkpoint restored on the cloud, a Mac's
 * wake), since the sockets it held are dead then and the first request on one fails ("socket hang up").
 */
export const telegramAgent = new HttpsAgent({ keepAlive: true });
export const TIMEOUT_TEXT = 'Telegram did not respond (timeout)';
/** a token as it appears in node-fetch's messages (`…/bot<token>/getMe failed…`) or on its own */
const TOKEN_IN_URL = /\/bot[^/\s]+/g;
const BARE_TOKEN = /\b\d{5,}:[A-Za-z0-9_-]{20,}/g;
/** the waits between a start that failed for a passing reason and the next try (then every last one) */
export const START_RETRY_DELAYS_MS = [15_000, 60_000, 300_000];
/** the waits before trying `getMe` again at once when the network failed (not a timeout) */
export const GETME_RETRY_MS = [1000, 3000];

const scrubToken = (s: string): string => s.replace(TOKEN_IN_URL, '/bot…').replace(BARE_TOKEN, '<token>');

/**
 * What a failed Telegram call says, with its cause. grammY's `HttpError` ("Network request for 'getMe' failed!") hides
 * why: the fetch's own error (node-fetch's `code` and "reason", or undici's `cause`), or a `SyntaxError` when Telegram
 * answered something that isn't JSON (a gateway error page). Never a token: node-fetch's messages carry the URL.
 */
export function telegramErrorText(e: unknown): string {
  if (e instanceof HttpError) {
    const cause = e.error;
    let why = '';
    if (cause instanceof SyntaxError) why = 'Telegram answered something that isn’t JSON, likely an error page';
    else if (cause instanceof Error) {
      const c = cause as Error & { code?: unknown; cause?: { code?: unknown; message?: unknown } };
      const code = typeof c.code === 'string' ? c.code : typeof c.cause?.code === 'string' ? c.cause.code : '';
      const reason = /reason: ([\s\S]*)$/.exec(c.message)?.[1]?.trim() ?? (typeof c.cause?.message === 'string' ? c.cause.message : c.message);
      why = code && !reason.includes(code) ? `${code}: ${reason}` : reason;
    } else if (cause !== undefined && cause !== null) why = String(cause);
    return scrubToken(why ? `${e.message} (${why})` : e.message);
  }
  return scrubToken(errMsg(e));
}

/** A failure that may pass by itself: the network, a non-JSON answer, Telegram's 5xx or 429, our own timeout. */
export function isTransientTelegramError(e: unknown): boolean {
  if (e instanceof HttpError) return true;
  if (e instanceof GrammyError) return e.error_code === 429 || e.error_code >= 500;
  return e instanceof Error && e.message === TIMEOUT_TEXT;
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Telegram's limits: name 64, description 512, short description ("about") 120 characters. */
export const cut = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);
/** What the Telegram bot's description says: the bot's job, or a line naming it. */
export const telegramAbout = (bot: Pick<Bot, 'name' | 'job'>): string => bot.job.replace(/\s+/g, ' ').trim() || `${bot.name}, your AppuBot.`;
/**
 * Changes when the avatar would look different (bump the version when the drawing does): the shape and colour, or the
 * character it wears (its id and a hash of its drawing) and the colour. v2: the flat avatar (chat-core `BOT_FLAT`,
 * 2026-11-11). v3: a chief wore a crown (2026-11-28). v4: a chief wears its star badge instead (chat-core chiefBadge.ts,
 * 2026-11-28); other bots' pictures didn't change, so their keys stay.
 */
export const photoKey = (bot: Pick<Bot, 'shape' | 'color' | 'characterId'> & { chief?: boolean }, figure?: CharacterFigure | null): string => {
  const key = figure && bot.characterId ? `v2c:${bot.characterId}:${characterKey(figure)}:${bot.color.toLowerCase()}` : `v2:${bot.shape}:${bot.color.toLowerCase()}`;
  return bot.chief ? `v4:chief:${key}` : key;
};
export const PHOTO_PX = 640;

/** A turn Telegram started: where its reply (and what it asks on the way) goes. */
export interface TelegramTurn {
  runnerId: string;
  chatId: string;
  threadId: string;
  /** the Telegram message it answers (the reply quotes it) */
  replyTo?: number;
  /** files that went out mid-turn (`send_file`), not sent again with the reply */
  sentFiles?: Set<string>;
  /** it was asked by voice: the reply goes out as a voice note too (`settings.voice.telegramVoiceReplies`) */
  voice?: boolean;
  /** the bot sent a voice note itself (`send_voice`): no automatic one at the end */
  spoken?: boolean;
  /** what went out mid-turn and is still sending: the reply waits for it, so it lands after */
  sending?: Promise<void>;
}
