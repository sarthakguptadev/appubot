import { z } from 'zod';
import { Id, Timestamp } from './entities';

/**
 * What a person's own computer lends their AppuBot computer (Settings › Transfer), beside bots:
 *
 *  - **Git and GitHub** (`github.*`): the name and email git signs commits with and the GitHub sign-in, carried by
 *    the computer's own window from one to the other. The private SSH key never travels: the other computer makes a
 *    key of its own.
 *  - **Files on this computer** (`macLink.*` here, `macFiles.*` there): the bots on the AppuBot computer may read
 *    the folders the person picks on this one, while it is on. This computer hands the other a token and where to
 *    find it on AppuBot Connect; the other dials in when a bot asks, through the same end-to-end channel a phone uses.
 *    The picked folders only, checked on this computer. Read-only unless the person switches a folder to "Bots can
 *    save changes here" (`macLink.setWritable`): then a bot may create a file there or replace one (`/api/link/put`),
 *    the old version going to this computer's Trash. Never a delete, rename or move.
 */

/* ---------- git and GitHub ---------- */

/** what this computer's git has, never the token itself */
export const GitLocalSchema = z.object({
  /** git is installed here */
  git: z.boolean(),
  name: z.string().optional(),
  email: z.string().optional(),
  /** a GitHub sign-in was found: in the GitHub CLI (`gh`) or git's own saved credentials */
  hasToken: z.boolean(),
  via: z.enum(['gh', 'git']).optional(),
});
export type GitLocal = z.infer<typeof GitLocalSchema>;

/** how git and GitHub stand on a computer */
export const GitSetupSchema = z.object({
  git: z.boolean(),
  name: z.string().optional(),
  email: z.string().optional(),
  /** the GitHub account git signs in as here */
  login: z.string().optional(),
  /** this computer's own SSH public key (`~/.ssh/id_ed25519.pub`), to add at GitHub or another host */
  sshKey: z.string().optional(),
});
export type GitSetup = z.infer<typeof GitSetupSchema>;

export const GitSetupParamsSchema = z.object({
  name: z.string().trim().max(200).optional(),
  email: z.string().trim().max(200).optional(),
  /** a GitHub token: checked with GitHub, then saved for git over https */
  token: z.string().trim().min(1).max(400).optional(),
  /** make this computer an SSH key of its own if it has none */
  sshKey: z.boolean().optional(),
});

/* ---------- files on this computer, for the bots on another ---------- */

/** the most folders a person may lend */
export const MAC_LINK_FOLDERS_MAX = 20;
/** the largest file a bot may bring over in one go */
export const MAC_FILE_MAX_BYTES = 100 * 1024 * 1024;
/** entries one listing answers with */
export const MAC_LIST_MAX = 500;
/** results one search answers with */
export const MAC_FIND_MAX = 100;

/** the gateway's paths for the linked computer (its token as a Bearer; never the owner's or a phone's) */
export const LINK_ROOTS_PATH = '/api/link/roots';
export const LINK_LIST_PATH = '/api/link/list';
export const LINK_FIND_PATH = '/api/link/find';
export const LINK_FILE_PATH = '/api/link/file';
/** `POST ?path=` with the file's bytes: creates or replaces it, only in a folder switched to take changes */
export const LINK_PUT_PATH = '/api/link/put';
/** the most text a bot may save in one go without a file of its own (`agent.mac.put {text}`) */
export const MAC_PUT_TEXT_MAX = 1024 * 1024;

/** a computer that may read this one's folders */
export const MacLinkSchema = z.object({
  id: Id,
  /** what it is, in the person's words ("Sarthak’s Cloud Computer") */
  name: z.string(),
  createdAt: Timestamp,
  lastUsedAt: Timestamp.optional(),
  /** when a bot there last saved a file here, and its name */
  lastSavedAt: Timestamp.optional(),
  lastSavedName: z.string().optional(),
});
export type MacLink = z.infer<typeof MacLinkSchema>;

export const MacLinkStatusSchema = z.object({
  /** the folders lent, as absolute paths */
  folders: z.array(z.string()),
  /** the lent folders whose files the bots may also change (create or replace; never delete): off for each by default */
  writable: z.array(z.string()).optional(),
  links: z.array(MacLinkSchema),
  /** why the other computer can't reach this one right now (AppuBot Connect off, signed out…); absent when it can */
  blocked: z.string().optional(),
});
export type MacLinkStatus = z.infer<typeof MacLinkStatusSchema>;

/** what `macLink.create` hands the window to give the other computer; the token is shown this once */
export const MacLinkGrantSchema = z.object({
  id: Id,
  token: z.string(),
  /** this computer's room on AppuBot Connect and the key that pins it */
  connectId: z.string(),
  connectKey: z.string(),
  hostName: z.string(),
});
export type MacLinkGrant = z.infer<typeof MacLinkGrantSchema>;

export const MacFilesLinkParamsSchema = z.object({
  linkId: Id,
  token: z.string().min(16).max(200),
  connectId: z.string().min(8).max(80),
  connectKey: z.string().min(16).max(120),
  /** the lending computer's name ("Sarthak’s MacBook Pro") */
  name: z.string().trim().min(1).max(120),
});

/** the lending computer as the reading one knows it (never the token) */
export const MacFilesStatusSchema = z.object({
  linked: z.object({ linkId: Id, name: z.string(), since: Timestamp }).optional(),
});
export type MacFilesStatus = z.infer<typeof MacFilesStatusSchema>;

export const MacFolderSchema = z.object({
  name: z.string(),
  path: z.string(),
  /** the bots may save changes in it (absent: read-only, and from a computer from before) */
  writable: z.boolean().optional(),
});
export type MacFolder = z.infer<typeof MacFolderSchema>;

export const MacEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  dir: z.boolean(),
  /** bytes (a file) */
  size: z.number().optional(),
  modified: Timestamp.optional(),
});
export type MacEntry = z.infer<typeof MacEntrySchema>;

/** `GET /api/link/roots` */
export const LinkRootsSchema = z.object({
  hostName: z.string(),
  folders: z.array(MacFolderSchema),
  /** the lending computer takes saves (`LINK_PUT_PATH`) in the folders marked `writable`; absent from one from before */
  saves: z.boolean().optional(),
});
/** `GET /api/link/list?path=` and `/api/link/find?q=&path=` */
export const LinkEntriesSchema = z.object({ path: z.string().optional(), entries: z.array(MacEntrySchema), truncated: z.boolean().optional() });
/** `POST /api/link/put?path=`: what was saved; a file replaced kept its old version in the Trash (`trash`) or in AppuBot's own folder (`kept`) */
export const LinkPutSchema = z.object({
  path: z.string(),
  bytes: z.number(),
  replaced: z.boolean(),
  oldVersion: z.enum(['trash', 'kept']).optional(),
});
export type LinkPut = z.infer<typeof LinkPutSchema>;

/** whether the lending computer answers right now (the reading computer asked it) */
export const MacFilesCheckSchema = z.object({
  ok: z.boolean(),
  name: z.string().optional(),
  folders: z.array(MacFolderSchema).optional(),
  error: z.string().optional(),
});
