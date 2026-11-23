/**
 * Transfer: copying bots, their memory and skills, and the Mac's own shared skills from this Mac to an AppuBot computer
 * (the person's own or a team's). One way only: the Mac packs (`bots.exportable` says what it has and how big,
 * `bots.export` with `include` packs only what was picked, `skills.getShared` reads a shared skill), the desktop app
 * carries each bundle over the cloud's end-to-end channel and the cloud unpacks it with the `bots.import` it has
 * always had, so it works on every cloud image. The Mac keeps its originals. Secrets never travel (agent keys and
 * logins, the Vault, apps' and Telegram's tokens): see `BotBundleManifestSchema`.
 */
import { z } from 'zod';
import { BotSchema, type TransferTakes } from './entities';
import { CharacterSchema } from './characters';

/** What of a bot goes into its bundle; every part absent = included (the Move dialog's whole bot). */
export const BotExportIncludeSchema = z.object({
  /** MEMORY.md in its folder */
  memory: z.boolean().optional(),
  /** its own skills (`.claude/skills/<name>/` in its folder) */
  skills: z.boolean().optional(),
  /** the rest of its folder: inbox, outbox and the user's files (tool scratch is always left out) */
  files: z.boolean().optional(),
  routines: z.boolean().optional(),
  /** its chats, whole, with the files in them */
  chats: z.boolean().optional(),
});
export type BotExportInclude = z.infer<typeof BotExportIncludeSchema>;
export type BotExportPart = keyof BotExportInclude;
export const BOT_EXPORT_PARTS: readonly BotExportPart[] = ['memory', 'skills', 'files', 'routines', 'chats'];

/** what `bots.export` packed: every part as it applied, and the shared skills it added (a Mac from before says nothing) */
export const BotExportIncludedSchema = z.object({
  memory: z.boolean(), skills: z.boolean(), files: z.boolean(), routines: z.boolean(), chats: z.boolean(),
  sharedSkills: z.array(z.string()),
});
export type BotExportIncluded = z.infer<typeof BotExportIncludedSchema>;

/** One of this computer's bots as a transfer would carry it, part by part, with sizes (bytes as stored here). */
export const ExportableBotSchema = z.object({
  bot: z.lazy(() => BotSchema),
  /** the character it wears, so another computer's screen can draw it */
  character: CharacterSchema.optional(),
  memory: z.object({ bytes: z.number().int() }),
  skills: z.object({ names: z.array(z.string()), bytes: z.number().int() }),
  files: z.object({ count: z.number().int(), bytes: z.number().int() }),
  routines: z.object({ count: z.number().int() }),
  chats: z.object({ threads: z.number().int(), messages: z.number().int(), bytes: z.number().int() }),
});
export type ExportableBot = z.infer<typeof ExportableBotSchema>;

/**
 * A skill the person keeps for every agent on this computer, outside any bot: Claude Code's `~/.claude/skills`, the
 * shared `~/.agents/skills` and Codex's `~/.codex/skills` (the first of a name wins).
 */
export const SharedSkillSchema = z.object({
  name: z.string(),
  description: z.string().default(''),
  from: z.enum(['claude', 'agents', 'codex']),
  /** files in its folder, SKILL.md included */
  files: z.number().int(),
  bytes: z.number().int(),
});
export type SharedSkill = z.infer<typeof SharedSkillSchema>;

export const ExportableSchema = z.object({
  hostName: z.string(),
  bots: z.array(ExportableBotSchema),
  sharedSkills: z.array(SharedSkillSchema),
});
export type Exportable = z.infer<typeof ExportableSchema>;

/** `skills.getShared`: one shared skill's text (its other files only travel inside a bot's bundle) */
export const SharedSkillTextSchema = z.object({ name: z.string(), description: z.string(), body: z.string(), files: z.number().int() });
export type SharedSkillText = z.infer<typeof SharedSkillTextSchema>;

/** a bundle the desktop carries at once (the gateway's `/api/files` takes 512 MB) */
export const TRANSFER_BUNDLE_MAX = 500 * 1024 * 1024;

/** the biggest upload a computer takes at once: the gateway's `/api/files` and AppuBot Connect's channel alike */
export const UPLOAD_MAX = 512 * 1024 * 1024;
/**
 * what a computer from before `SystemInfo.transfer` takes: its channel refused a request body over 300 MB (every cloud
 * image up to revision 13), though its `/api/files` took 512 MB
 */
export const UPLOAD_MAX_BEFORE = 300 * 1024 * 1024;
/** room left under a computer's upload limit for the multipart form around the bundle (a few hundred bytes) and rounding */
export const UPLOAD_MARGIN = 4 * 1024 * 1024;

/**
 * The biggest bundle a transfer sends to a computer that says `takes` (its `SystemInfo.transfer`; absent: a computer
 * from before, which takes `UPLOAD_MAX_BEFORE`): within `TRANSFER_BUNDLE_MAX`, with `UPLOAD_MARGIN` to spare.
 */
export function transferLimit(takes?: Pick<TransferTakes, 'uploadMax'> | null): number {
  return Math.min(TRANSFER_BUNDLE_MAX, (takes?.uploadMax ?? UPLOAD_MAX_BEFORE) - UPLOAD_MARGIN);
}
