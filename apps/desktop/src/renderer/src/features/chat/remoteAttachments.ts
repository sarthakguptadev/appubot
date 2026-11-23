/**
 * Files you attach for a bot on a remote computer (your AppuBot computer, a team's). On this Mac an attachment is its
 * path in the prompt (`withFileLines`: the bot reads the file where it is); a bot elsewhere can't read this Mac's disk,
 * so the file goes over first (`POST /api/files` through the computer's channel, the phone's way, uploaded in the
 * background by lib/outbox.ts) and the message carries it (`chat.send {attachments}`): the computer puts it in the
 * bot's inbox and the bot gets its path there. Composer.tsx keeps the picked files as `File`s on a remote computer, never paths.
 */

/** at most this big over the channel (the relay pauses what's bigger; the phone keeps to 300 MB) */
export const ATTACH_MAX_BYTES = 200 * 1024 * 1024;

export function tooBig(files: readonly File[]): File | undefined {
  return files.find((f) => f.size > ATTACH_MAX_BYTES);
}
