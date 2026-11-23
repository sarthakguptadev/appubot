/**
 * AppuBot Cloud: the contract between the apps (desktop, phone), the Mac's `cloudAccount` service, the cloud
 * gateway and the backend (account.appubot.com),
 * §5.7, §5.8, §6.2, §6.3, §6.5, §6.6, §6.7. Three kinds of shape live here:
 *
 * - the backend's HTTP API (`/v1/...`), typed for `packages/client/src/cloudApi.ts` and the Worker's handlers;
 * - the control API the backend calls on a cloud computer (`/control/...`, §5.7) and the heartbeat the computer
 *   sends back (§5.8), so both ends validate the same objects;
 * - the gateway methods and events the Mac's core offers the apps (`cloudAccount.*`, `cloud.export`), as schemas
 *   only: `wire.ts` wires them into `Methods` / `Events`.
 *
 * Nothing here carries chat content: the backend is never in the data path.
 */
import { z } from 'zod';
import { CloudTeamLogins } from './entities';
import { withoutRetired } from './freeModels';

/** the backend's public origin (staging: account-staging.appubot.com) */
export const CLOUD_API_URL = 'https://account.appubot.com';
/** the version prefix of every backend route */
export const CLOUD_API_PREFIX = '/v1';
/**
 * The apps send their device's IANA time zone on every account request; the backend keeps the owner's and tells
 * their AppuBot computer (bootstrap, `POST /control/locale`), so its routines and clock run on the owner's day.
 */
export const TIME_ZONE_HEADER = 'x-appubot-time-zone';
/** where the apps' browser sign-in returns to (deep link; §6.5); the phone in Expo Go uses its own `exp://…/--/cloud/signed-in` */
export const CLOUD_SIGNED_IN_LINK = 'appubot://cloud/signed-in';
/** where Dodo's return page sends the user back to the app (§6.6) */
export const CLOUD_CHECKOUT_DONE_LINK = 'appubot://cloud/checkout-done';
/** how long a desktop link (signed noVNC URL) lives: the shortest the flow tolerates (§5.7, V8) */
export const CLOUD_DESKTOP_LINK_TTL_S = 60;
/** the computer sends a heartbeat this often while awake (§5.8 item 3) */
export const CLOUD_HEARTBEAT_EVERY_MS = 60_000;
/** the Mac polls the notice counter this often while its window is hidden (§5.8 item 8) */
export const CLOUD_NOTICES_POLL_MS = 120_000;
/** a client waits this long for the first byte of a request that wakes the computer [A37: ≥3 min] */
export const CLOUD_WAKE_FIRST_BYTE_MS = 180_000;
/** notices the backend keeps per computer (only names and kinds, never text) */
export const CLOUD_NOTICES_KEPT = 50;

const Ms = z.number().int().nonnegative();
const Email = z.string().trim().toLowerCase().email().max(254);

// ---------------------------------------------------------------------------------------------------------------
// Included Claude credit: a limited-time launch bonus. Every paid plan includes
// Claude API credit each month, `CLOUD_CREDIT_SHARE` of what it costs a month rounded to whole dollars
// (`cloudCreditUsd`), spent through the backend's pass-through with the operator's own Anthropic key (never on the
// user's computer). The computer runs Claude Code as the agent "AppuBot AI", a profile pointed at the pass-through;
// it pays for Sonnet and Haiku only, never fast mode (`creditModelAllowed`: the backend refuses the rest, the
// computer lists and picks only these). The backend can end it for everyone (`ended`).

/** the share of a plan's monthly price that comes back as Claude credit every month (a quarter, rounded: Starter $5, Pro $12, Max $22; a team's pool is a quarter of base + seats) */
export const CLOUD_CREDIT_SHARE = 0.25;
/** a month's credit in whole US dollars for a monthly price: `CLOUD_CREDIT_SHARE` of it, to the nearest dollar ($4.75 → $5, $12.25 → $12, $22.25 → $22) */
export const cloudCreditUsd = (monthlyUsd: number): number => Math.round(monthlyUsd * CLOUD_CREDIT_SHARE);
/** the agent that runs on the included credit: a Claude Code profile of AppuBot's own (`providerBase` = `claude-code`) */
export const APPUBOT_AI_PROVIDER_ID = 'claude-code@appubot-ai';
export const APPUBOT_AI_NAME = 'AppuBot AI';
/** what the pickers call it where there is room for the whole line */
export const APPUBOT_AI_LABEL = 'AppuBot AI (Claude launch bonus)';
/** the model a new subscriber's bots start on: Haiku, so the credit lasts (Sonnet can be picked too) */
export const APPUBOT_AI_DEFAULT_MODEL = 'claude-haiku-5-5';
/** the Sonnet AppuBot AI runs where Claude Code asks for a bigger model (its `opus`/`fable` aliases, a subagent's pick) */
export const APPUBOT_AI_BIG_MODEL = 'claude-sonnet-5-5';
/** the model families the launch bonus pays for (Fable, Opus and anything else are refused) */
export const CREDIT_MODEL_FAMILIES = ['sonnet', 'haiku'] as const;
/** what the refusals and pickers say about it */
export const CREDIT_MODELS_TEXT = 'Claude Sonnet and Haiku';

/**
 * Whether the launch bonus pays for a model: a Sonnet or Haiku, by its id (`claude-sonnet-5-5`, with a date, a
 * `[1m]` context suffix or a Bedrock-style prefix) or Claude Code's alias (`sonnet`, `haiku`, `sonnet[1m]`). Claude
 * Code's `default`, `opus`, `fable`, `opusplan` and every other model are not. The backend's pass-through refuses
 * the rest whoever sends them; AppuBot AI's pickers list only these.
 */
export function creditModelAllowed(model: string | null | undefined): boolean {
  if (!model) return false;
  const bare = model.trim().toLowerCase()
    .replace(/\[1m\]$/, '')
    .replace(/^(?:[a-z]{2,4}\.)?anthropic\./, '')
    .replace(/-v\d+(?::\d+)?$/, '')
    .replace(/[@-]\d{8}$/, '');
  return CREDIT_MODEL_FAMILIES.some((f) => bare === f || bare.startsWith(`claude-${f}-`));
}

/**
 * the models an agent's pickers offer: AppuBot AI's narrowed to the ones the launch bonus pays for, any other agent's
 * as they are, less the free models OpenCode's server has retired (a list a chat kept from before still names them)
 */
export function offeredModels<T extends { id: string }>(providerId: string | undefined, models: readonly T[]): T[] {
  return providerId === APPUBOT_AI_PROVIDER_ID ? models.filter((m) => creditModelAllowed(m.id)) : withoutRetired([...models]);
}
/** whether an agent has a fast mode to offer: Claude Code and its profiles, except AppuBot AI (the launch bonus pays for the standard speed only) */
export const offersFastMode = (providerId: string | undefined): boolean => !!providerId && providerId !== APPUBOT_AI_PROVIDER_ID && (providerId === 'claude-code' || providerId.startsWith('claude-code@'));
/** the pass-through's path on the backend: Claude Code's `ANTHROPIC_BASE_URL` is `<backend>${CLOUD_AI_PATH}` and it posts to `<base>/v1/messages` */
export const CLOUD_AI_PATH = '/v1/ai';

/** the included credit as the apps show it (`CloudComputer.credit`; amounts in USD cents, the budget whole dollars; never a token) */
export const CloudCreditSchema = z.object({
  /** this month's credit and what is spent of it */
  budgetCents: z.number().int().nonnegative(), usedCents: z.number().int().nonnegative(),
  currency: z.string().length(3),
  /** when the month's credit comes back in full (the awake-time month's end; no rollover) */
  resetsAt: Ms,
  /** the month's credit is used up (or the launch bonus has `ended`): the pass-through refuses until `resetsAt` */
  exhausted: z.boolean(),
  /** the launch bonus has ended for everyone (switched off, past its end date or its pool spent): refused until it comes back, if ever; absent = running */
  ended: z.boolean().optional(),
  /** when the launch bonus is set to end, if a date is set */
  endsAt: Ms.optional(),
  /** the model bots start on */
  defaultModel: z.string(),
  /** a team: the pool is the whole team's */
  shared: z.boolean().optional(),
});
export type CloudCredit = z.infer<typeof CloudCreditSchema>;
/**
 * What the backend tells the computer about its credit (bootstrap, `/control/state`, the heartbeat answer): the
 * status the apps show plus, when `token` is sent, the credit token the agents authenticate to the pass-through with
 * (`ANTHROPIC_AUTH_TOKEN`) and its `key` (a fingerprint the computer reports in its heartbeat, so the backend sends
 * the token only when it differs). `enabled: false`: no plan, or the plan ended; the agent is taken away.
 */
export const CloudCreditSettingsSchema = CloudCreditSchema.partial().extend({
  enabled: z.boolean(),
  /** Claude Code's `ANTHROPIC_BASE_URL` (`<backend>/v1/ai`) */
  baseUrl: z.string().url().optional(),
  token: z.string().optional(),
  key: z.string().optional(),
  /** this credit is a free Claude day's (`CloudPromo.id`), not a plan's: what a Mac gets from `POST /v1/promo/start` */
  promo: z.string().optional(),
});
export type CloudCreditSettings = z.infer<typeof CloudCreditSettingsSchema>;

// ---------------------------------------------------------------------------------------------------------------
// The free Claude day, AppuBot's launch gift (2026-11-10, the Product Hunt launch): for a set window every signed-in
// person may use Claude through the pass-through at no cost, on their own computer too, paid from a pool of its own
// (never a plan's month). It runs one model (`PROMO_DEFAULT_MODEL`, `promoModelAllowed`), which the apps never name:
// the agent shows as "Claude" (`PROMO_AGENT_NAME`) under the profile "AppuBot Launch Gift" (`PROMO_PROFILE_NAME`) with
// one model row, "Claude". `GET /v1/promo` (public) says whether one is on; `POST /v1/promo/start` (signed in)
// answers `CloudCreditSettings` with a token of the day's own (`promo` set).

/** the model the gift runs (never named in the apps) */
export const PROMO_DEFAULT_MODEL = 'claude-haiku-5-5';
/** what the gift's agent and its one model are called, and the profile it shows under */
export const PROMO_AGENT_NAME = 'Claude';
export const PROMO_PROFILE_NAME = 'AppuBot Launch Gift';
/** whether the gift pays for a model: its own family only (the id, with a date, a `[1m]` suffix or a prefix, or Claude Code's alias) */
export function promoModelAllowed(model: string | null | undefined): boolean {
  if (!model) return false;
  const bare = model.trim().toLowerCase().replace(/\[1m\]$/, '').replace(/^(?:[a-z]{2,4}\.)?anthropic\./, '').replace(/-v\d+(?::\d+)?$/, '').replace(/[@-]\d{8}$/, '');
  return bare === 'haiku' || bare.startsWith('claude-haiku-');
}
/** what the free day's tokens start with (a plan's credit tokens start `ck_`) */
export const PROMO_TOKEN_PREFIX = 'cp_';
export const CloudPromoSchema = z.object({
  /** which free day this is: an app that showed or finished one doesn't offer it again */
  id: z.string(),
  /** it is running now: started, not over, its pool not spent, not switched off */
  open: z.boolean(),
  model: z.string(),
  startsAt: Ms.optional(),
  endsAt: Ms.optional(),
  /** the launch the day celebrates (its Product Hunt page): the apps' card opens it first; absent = the app's own */
  launchUrl: z.string().url().max(300).optional(),
  /** what the card's X post says; absent = the app's own words */
  postText: z.string().max(270).optional(),
});
export type CloudPromo = z.infer<typeof CloudPromoSchema>;

// ---------------------------------------------------------------------------------------------------------------
// Accounts and sign-in (§6.5)

export const CloudAccountStatus = z.enum(['active', 'past_due', 'on_hold', 'cancelling', 'ended', 'suspended', 'deleted']);
export type CloudAccountStatus = z.infer<typeof CloudAccountStatus>;
/**
 * The plans: each is one cloud computer of a shape, with no limit on awake time
 * (auto-sleep keeps an idle one cheap). Personal plans (Starter, Pro, Max, Ultra) are one person's computer; Work plans
 * (Team, Business, Scale) are one computer a team shares, priced as the plan's base (the first member included) plus a price per extra member. Prices,
 * shapes and names are the backend's config; the apps show what the backend's catalog says
 * (`GET /v1/billing/catalog`), never a number of their own.
 */
export const CloudPersonalPlanId = z.enum(['starter', 'pro', 'max', 'ultra']);
export type CloudPersonalPlanId = z.infer<typeof CloudPersonalPlanId>;
/**
 * The catalog's version the apps ask for (`GET /v1/billing/catalog?v=`). Apps check plan ids strictly, so a plan added
 * later would make an older app refuse the whole catalog: the backend lists only `CATALOG_PLANS_V1` to an app that
 * sends no version (or 1), and every plan from 2 on. Raise it with the next plan id.
 */
export const CLOUD_CATALOG_VERSION = 2;
/** the personal plans an app from before Ultra knows (catalog version 1) */
export const CATALOG_PLANS_V1: readonly CloudPersonalPlanId[] = ['starter', 'pro', 'max'];
export const CloudWorkPlanId = z.enum(['team', 'business', 'scale']);
export type CloudWorkPlanId = z.infer<typeof CloudWorkPlanId>;
export const CloudPlanId = z.enum([...CloudPersonalPlanId.options, ...CloudWorkPlanId.options]);
export type CloudPlanId = z.infer<typeof CloudPlanId>;
/** personal: one person's computer; work: one computer a team shares (base + per extra member) */
export const CloudPlanKind = z.enum(['personal', 'work']);
export type CloudPlanKind = z.infer<typeof CloudPlanKind>;
export const isWorkPlan = (id: string): id is CloudWorkPlanId => (CloudWorkPlanId.options as readonly string[]).includes(id);
/** how many people a team may have: at least 2, at most 30 (each plan has its own most, `maxMembers`); 5 is the pickers' start */
export const CLOUD_TEAM_MEMBERS = { min: 2, max: 30, default: 5 } as const;
/** the people a Work plan's base includes: the first; each one after is a paid seat (the seat add-on) */
export const CLOUD_INCLUDED_MEMBERS = 1;
/** the paid seats (the seat add-on's quantity) for a team of this many people: everyone after the first */
export const cloudPaidSeats = (members: number): number => Math.max(0, members - CLOUD_INCLUDED_MEMBERS);
/** how a plan is paid: every month, or every year (ten months' price, "2 months free") */
export const CloudInterval = z.enum(['monthly', 'yearly']);
export type CloudInterval = z.infer<typeof CloudInterval>;
/** a computer's size: vCPUs, GB of RAM, GB of disk (Agent37's `resources`) */
export const CloudShapeSchema = z.object({ cpu: z.number().int().positive(), memory: z.number().int().positive(), disk: z.number().int().positive() });
export type CloudShape = z.infer<typeof CloudShapeSchema>;
export const CloudRegion = z.enum(['us', 'eu', 'ap-south']);
export type CloudRegion = z.infer<typeof CloudRegion>;
/** what a client is, for the session's label (shown in Settings › Cloud › Devices) */
export const CloudDevicePlatform = z.enum(['macos', 'windows', 'linux', 'ios', 'android', 'web']);
export const CloudDeviceSchema = z.object({ name: z.string().trim().min(1).max(80), platform: CloudDevicePlatform });
export type CloudDevice = z.infer<typeof CloudDeviceSchema>;

export const CloudSubscriptionSchema = z.object({
  /** as last read from Dodo (`features/subscription#subscription-states`) */
  status: z.enum(['pending', 'active', 'past_due', 'on_hold', 'paused', 'cancelled', 'failed', 'expired']),
  plan: CloudPlanId,
  interval: CloudInterval,
  /** the current period, as Dodo reports it (`previous_billing_date` → `next_billing_date`) */
  periodStart: Ms, periodEnd: Ms,
  /** a downgrade (or a move to monthly, or fewer seats) scheduled for the period's end (Dodo `effective_at: next_billing_date`, §6.6) */
  scheduledChange: z.object({ plan: CloudPlanId, interval: CloudInterval, at: Ms, seats: z.number().int().positive().optional() }).optional(),
  /** a Work plan: the seats paid for (the per-member add-on's quantity; the whole team, admins included) */
  seats: z.number().int().positive().optional(),
  /** the user asked the portal to end it at the period's end ("Ends on 3 Dec", Keep my plan) */
  cancelAtPeriodEnd: z.boolean(),
  /** while `past_due`: the grace deadline from the `subscription.past_due` event */
  pastDueEndsAt: Ms.optional(),
  /**
   * On its free trial until then: nothing has been charged yet, and the first charge comes that day (= `periodEnd`)
   * unless the plan is cancelled first. Absent once the trial is over, without one, and from a backend from before trials.
   */
  trialEndsAt: Ms.optional().catch(undefined),
});
export type CloudSubscription = z.infer<typeof CloudSubscriptionSchema>;

export const CloudAccountSchema = z.object({
  id: z.string(), email: Email, createdAt: Ms,
  /** the person's name from their sign-in (Google; Apple's first); absent otherwise and from older backends */
  name: z.string().max(200).optional().catch(undefined),
  /** the person's profile picture from their Google sign-in (an https URL on Google's photo host); absent otherwise.
   *  One that doesn't read as a URL is dropped rather than failing the whole account. */
  photoUrl: z.string().url().optional().catch(undefined),
  /** absent before the first paid checkout */
  status: CloudAccountStatus.optional(),
  /** the plan and how it is paid, as last read from Dodo's subscription */
  plan: CloudPlanId.optional(), interval: CloudInterval.optional(), region: CloudRegion.optional(),
  subscription: CloudSubscriptionSchema.optional(),
  /** an ended or on-hold account: its stopped computer is kept until then and deleted after (§6.7); the name is historical */
  exportUntil: Ms.optional(),
  /** false when sign-ups are closed ("Sold out for now", §6.7) */
  signupsOpen: z.boolean(),
  /**
   * false for an email + password account whose address isn't verified yet: checkout refuses (`email_unverified`)
   * until it is. Google and Apple addresses count as verified. Absent from a backend from before Firebase sign-in.
   */
  emailVerified: z.boolean().optional(),
  /**
   * The days of free trial this person's first plan would start with (their own, or a team they buy): 0 once they have
   * had a plan. Absent from a backend from before trials (no trial). Signed out, the catalog's `trialDays` says it.
   */
  trialDays: z.number().int().nonnegative().optional().catch(undefined),
  /** the teams this person is in (Work plans, §6.11); absent from a backend from before teams */
  teams: z.array(z.lazy(() => CloudTeamSummarySchema)).optional(),
  /** team invites waiting for this person's email */
  invites: z.array(z.lazy(() => CloudInviteForMeSchema)).optional(),
});
export type CloudAccount = z.infer<typeof CloudAccountSchema>;

export const CloudSessionSchema = z.object({ account: CloudAccountSchema, device: CloudDeviceSchema, expiresAt: Ms });
export type CloudSession = z.infer<typeof CloudSessionSchema>;

export const CloudAuthTokenResponseSchema = z.object({ token: z.string(), session: CloudSessionSchema });
export type CloudAuthTokenResponse = z.infer<typeof CloudAuthTokenResponseSchema>;
/**
 * `POST /v1/auth/firebase`: a Firebase Authentication ID token (Google, Apple, or email + password) for our own
 * session (§6.5). The backend verifies it (RS256 against Google's securetoken keys) and keys the account by the
 * Firebase uid, linking an existing account by its verified email once. Scripts and the dev fakes use it straight;
 * the apps sign in through the web page and PKCE below.
 */
export const CloudAuthFirebaseRequestSchema = z.object({ idToken: z.string().min(20).max(8192), device: CloudDeviceSchema });
/**
 * `POST /v1/auth/token`: an app finishes the browser sign-in with PKCE. The page at `/sign-in` signed in with
 * Firebase, swapped the ID token for a one-time grant and returned to `appubot://cloud/signed-in?code=…&state=…`
 * (or the phone's own return link); the app swaps the `code` with its verifier.
 */
export const CloudAuthPkceRequestSchema = z.object({ code: z.string().min(16).max(200), codeVerifier: z.string().min(43).max(128), device: CloudDeviceSchema });
/** the browser sign-in page's query: `/sign-in?challenge=…&redirect=…&state=…` */
export const CloudSignInQuerySchema = z.object({
  challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/), state: z.string().min(8).max(200),
  redirect: z.string().max(400).optional(),
});

// ---------------------------------------------------------------------------------------------------------------
// The computer, its awake time and its state (§4.4, §6.3)

/** what the apps show on the computer, in its chats and in Settings, read from the backend (never wakes it) */
export const CloudComputerState = z.enum([
  /** no subscription yet, or nothing provisioned */
  'none',
  /** the first payment landed; the instance is being created and bootstrapped ("Setting up…") */
  'provisioning',
  'running', 'asleep', 'waking', 'stopped',
  /** the renewal failed and the grace period ended: stopped, data kept (§6.6) */
  'on-hold',
  /** the plan ended: stopped, kept until `exportUntil`, then deleted; subscribing again brings it back (§6.7). The name is historical: nothing starts it meanwhile */
  'export-only',
  /** stopped by the operator (abuse review, §6.10) */
  'suspended',
  /** provisioning gave up ("Setting up is taking longer than usual"; support is on it) */
  'failed',
  'deleted',
]);
export type CloudComputerState = z.infer<typeof CloudComputerState>;

/** the cloud gateway's own `SystemInfo.cloud.state` (§5.4), which `/control/state` sets */
export const CloudGatewayState = z.enum(['ok', 'on-hold', 'export-only']);
export type CloudGatewayState = z.infer<typeof CloudGatewayState>;

/**
 * @deprecated The awake-time line (§6.3) went on 2026-11-07: plans have no hour cap and nothing counts awake time any
 * more, so no backend sends it. Kept so an older backend's answer still parses.
 */
export const CloudAwakeSchema = z.object({
  /** awake hours this month, two decimals at most */
  used: z.number().nonnegative(),
  usedSeconds: z.number().int().nonnegative(),
  cycleStart: Ms, cycleEnd: Ms,
});
export type CloudAwake = z.infer<typeof CloudAwakeSchema>;

export const CloudWakeReason = z.enum(['routine', 'telegram', 'client', 'backend', 'update', 'export', 'boot', 'unknown']);
export type CloudWakeReason = z.infer<typeof CloudWakeReason>;
export const CloudWakeSchema = z.object({ at: Ms, reason: CloudWakeReason, cold: z.boolean().optional() });

export const CloudPriceSchema = z.object({
  /** in the currency's minor unit, as Dodo's product reports it (the apps show what Dodo charges, §6.2) */
  amount: z.number().int().nonnegative(), currency: z.string().length(3),
  /** "$19", "₹999", ready to show */
  display: z.string(),
  interval: z.enum(['month', 'year', 'once']),
  taxInclusive: z.boolean(),
});
export type CloudPrice = z.infer<typeof CloudPriceSchema>;

/** one plan as the catalog lists it (`GET /v1/billing/catalog`): its shape and the price of each interval Dodo sells */
export const CloudCatalogPlanSchema = z.object({
  id: CloudPlanId, name: z.string(),
  /** one line for the picker ("For a bot or two that work now and then") */
  blurb: z.string(),
  shape: CloudShapeSchema,
  /** absent while that product isn't on sale (no Dodo product id configured, or Dodo didn't answer) */
  monthly: CloudPriceSchema.optional(), yearly: CloudPriceSchema.optional(),
});
export type CloudCatalogPlan = z.infer<typeof CloudCatalogPlanSchema>;
/** a Work plan in the catalog: the base price of each interval, the price per member and how many members it takes */
export const CloudWorkCatalogPlanSchema = z.object({
  id: CloudWorkPlanId, name: z.string(), blurb: z.string(), shape: CloudShapeSchema,
  /** the plan's own price before members (absent while that product isn't on sale) */
  base: z.object({ monthly: CloudPriceSchema.optional(), yearly: CloudPriceSchema.optional() }),
  /** what each member after the first adds (the seat add-on's price at that interval; the base includes the first) */
  perMember: z.object({ monthly: CloudPriceSchema.optional(), yearly: CloudPriceSchema.optional() }),
  minMembers: z.number().int().positive(), maxMembers: z.number().int().positive(),
});
export type CloudWorkCatalogPlan = z.infer<typeof CloudWorkCatalogPlanSchema>;
/**
 * The plans on sale, in order (Starter first), with Dodo's prices (cached an hour on the backend). `plans` are the
 * personal ones (an app from before Work plans reads only those); `work` the team ones, absent from a backend from
 * before teams.
 */
export const CloudCatalogSchema = z.object({
  plans: z.array(CloudCatalogPlanSchema), asOf: Ms,
  work: z.object({ plans: z.array(CloudWorkCatalogPlanSchema), members: z.object({ min: z.number().int(), max: z.number().int(), default: z.number().int() }) }).optional(),
  /**
   * The free trial a first plan starts with, in days (every plan, a card on file, the first charge when it ends);
   * 0 or absent: none. What a signed-out visitor is offered; a signed-in person's own is `CloudAccount.trialDays`.
   */
  trialDays: z.number().int().nonnegative().optional().catch(undefined),
  /**
   * What those trial days cost, charged as the trial starts (2026-11-19: $1, so a card that can't pay never starts
   * one); the plan's own price is charged when they end. Absent: the trial is free (or from a backend from before).
   */
  trialPrice: CloudPriceSchema.optional().catch(undefined),
});
export type CloudCatalog = z.infer<typeof CloudCatalogSchema>;
/**
 * A catalog as this app can read it: plans whose id it doesn't know (one added after this build) are left out instead of
 * failing the whole catalog. Read the backend's answer through it (`CloudApi.catalog`).
 */
export function knownCatalogPlans(json: unknown): unknown {
  if (!json || typeof json !== 'object') return json;
  const c = json as { plans?: unknown; work?: { plans?: unknown } };
  const keep = (list: unknown, ids: readonly string[]) => (Array.isArray(list) ? list.filter((p) => ids.includes((p as { id?: string })?.id ?? '')) : list);
  return {
    ...c,
    plans: keep(c.plans, CloudPersonalPlanId.options),
    ...(c.work && typeof c.work === 'object' ? { work: { ...c.work, plans: keep(c.work.plans, CloudWorkPlanId.options) } } : {}),
  };
}

/** the account's plan as `GET /v1/computer` describes it: the one the computer is sized for */
export const CloudPlanInfoSchema = z.object({
  id: CloudPlanId, name: z.string(), interval: CloudInterval, region: CloudRegion,
  /** the plan's shape; `computer.shape` is what the instance actually has (a downgrade keeps a larger disk) */
  shape: CloudShapeSchema,
  /** what this plan costs at this interval, when the catalog knows (a Work plan: base + (seats − 1) × per member) */
  price: CloudPriceSchema.optional(),
  /** a Work plan: the seats paid for */
  seats: z.number().int().positive().optional(),
  kind: CloudPlanKind.optional(),
});
export type CloudPlanInfo = z.infer<typeof CloudPlanInfoSchema>;

// ---------------------------------------------------------------------------------------------------------------
// Fixing the computer (plan §6.9 "Self-service repair", D34): Update, Recover, Reset. All three run on the same
// Agent37 instance (its id, address, public port and backups stay): `update` rebuilds the system from the latest image
// keeping `/home/node`, `restore` puts a saved copy of `/home/node` back in place. Nothing is ever deleted, because
// Agent37 deletes an instance's backups with it.

/**
 * `update`: the latest version, everything kept. `recover`: save what it can, rebuild on the latest version, put the
 * saved copy back (for a computer that is stuck or can't be reached). `reset`: rebuild from a chosen saved copy (the
 * newest nightly by default); what changed after it is lost.
 */
export const CloudRepairKind = z.enum(['update', 'recover', 'reset']);
export type CloudRepairKind = z.infer<typeof CloudRepairKind>;
/** where it is: waiting its turn, saving a copy (bots paused first), rebuilding the system, restoring the files, starting AppuBot, done or failed */
export const CloudRepairState = z.enum(['queued', 'backing-up', 'rebuilding', 'restoring', 'starting', 'done', 'failed']);
export type CloudRepairState = z.infer<typeof CloudRepairState>;
/** a saved copy of the computer's files: `nightly` (seven, rotating) or `manual` (one, taken on demand: before an update or a fix) */
export const CloudBackupSchema = z.object({ id: z.string(), kind: z.enum(['nightly', 'manual']), createdAt: Ms, sizeBytes: z.number().int().nonnegative().optional() });
export type CloudBackup = z.infer<typeof CloudBackupSchema>;
/** `GET /v1/computer/backups` (owners; a team's admins): newest first */
export const CloudBackupListSchema = z.object({ backups: z.array(CloudBackupSchema), asOf: Ms });
export type CloudBackupList = z.infer<typeof CloudBackupListSchema>;

export const CloudRepairSchema = z.object({
  id: z.string(),
  kind: CloudRepairKind,
  state: CloudRepairState,
  startedAt: Ms, updatedAt: Ms, finishedAt: Ms.optional(),
  /** the saved copy its files come back from (recover, reset) */
  backup: CloudBackupSchema.optional(),
  /** the version it was on and the one it moves to */
  fromVersion: z.number().int().optional(), toVersion: z.number().int().optional(),
  /** lines for the user about what happened along the way ("Couldn’t save a fresh copy first, so…") */
  notes: z.array(z.string()),
  /** `failed`: why, in a sentence; `done`: the result line */
  message: z.string().optional(),
});
export type CloudRepair = z.infer<typeof CloudRepairSchema>;

/**
 * `POST /v1/computer/repair` (owners; a team's admins, never its members). `requestId`: the client's own id for this
 * press, so a retry is the same repair. Reset needs `confirm: 'reset'` (the typed confirmation) and takes `backupId`
 * (default: the newest nightly).
 */
export const CloudRepairRequestSchema = z.object({
  kind: CloudRepairKind,
  backupId: z.string().min(1).max(80).optional(),
  confirm: z.literal('reset').optional(),
  requestId: z.string().min(8).max(80).optional(),
});
export type CloudRepairRequest = z.infer<typeof CloudRepairRequestSchema>;
/** the repair it started (or the same one again), or none with why (Update on a computer already up to date) */
export const CloudRepairResponseSchema = z.object({ repair: CloudRepairSchema.nullable(), message: z.string().optional() });
export type CloudRepairResponse = z.infer<typeof CloudRepairResponseSchema>;

/** `GET /v1/computer` */
export const CloudComputerSchema = z.object({
  state: CloudComputerState,
  /** `on-hold`: the grace deadline if known */
  resetsAt: Ms.optional(),
  /** @deprecated no backend sends it since 2026-11-07 (nothing counts awake time); an older one still may */
  awake: CloudAwakeSchema.optional(),
  /** the included Claude credit this month (absent before a plan, and from a backend from before credit) */
  credit: CloudCreditSchema.optional(),
  /** absent before the first paid checkout (the catalog says what is on sale) */
  plan: CloudPlanInfoSchema.optional(),
  /** absent until provisioned */
  computer: z.object({
    id: z.string(), region: CloudRegion, version: z.number().int().optional(),
    /** the instance's size now; while a plan change's resize is pending it still says the old one */
    shape: CloudShapeSchema.optional(),
    /** a plan change is being applied to the instance (resize) */
    resizing: z.boolean().optional(),
    /** the public port's origin, `https://<slug>.agent37.app`: `/secure` and `/telegram/:id` live there */
    publicUrl: z.string().url(),
    hostName: z.string(),
    nextWakeAt: Ms.optional(), lastHeartbeatAt: Ms.optional(),
    /** always empty since 2026-11-07 (the wake history went with the meter); kept for older apps' schema */
    recentWakes: z.array(CloudWakeSchema),
  }).optional(),
  /** `provisioning`: how far ("Creating your computer", "Starting AppuBot"…) */
  progress: z.string().optional(),
  /** `failed` / `provisioning`: a line for the user */
  message: z.string().optional(),
  /** `export-only`: until when */
  exportUntil: Ms.optional(),
  /** the notice counter (§5.8 item 8), so one read tells whether to fetch notices */
  noticeSeq: z.number().int().nonnegative(),
  /** a team's computer: which team (`GET /v1/teams/:id/computer`) */
  team: z.object({ id: z.string(), name: z.string() }).optional(),
  /**
   * Fixing the computer (Update / Recover / Reset, plan §6.9): the one running now, else the last one for a day after it
   * ended (so its result shows). Absent from a backend from before repairs, and while there has been none.
   */
  repair: CloudRepairSchema.optional(),
  /**
   * What Fix your computer can offer: present from a backend that has repairs (an app hides the section without it).
   * `latestVersion`: the image the backend rolls out; `upToDate`: the computer is on it (Update has nothing to do).
   */
  fix: z.object({ latestVersion: z.number().int().optional(), upToDate: z.boolean() }).optional(),
});
export type CloudComputer = z.infer<typeof CloudComputerSchema>;


/**
 * `GET /v1/computer/devices` and `POST /v1/computer/devices/remove {id}` (a team's under `/v1/teams/:id/...`): the
 * devices paired with the computer, read and removed through the account, for a device the computer refuses because
 * it already keeps the most it allows (`PAIRED_DEVICES_MAX`): the only other place to remove one is the computer
 * itself, which that device can't reach. On a team's computer a person sees and removes only their own. Both wake it.
 */
export const CloudPairedDeviceSchema = z.object({
  id: z.string(), name: z.string(), platform: z.string(),
  pairedAt: Ms.optional(), lastSeenAt: Ms.optional(), appVersion: z.string().optional(),
});
export type CloudPairedDevice = z.infer<typeof CloudPairedDeviceSchema>;
export const CloudPairedDevicesSchema = z.object({ devices: z.array(CloudPairedDeviceSchema), max: z.number().int().positive() });
export type CloudPairedDevices = z.infer<typeof CloudPairedDevicesSchema>;
export const CloudDeviceRemoveRequestSchema = z.object({ id: z.string().min(1).max(80) });

/** `POST /v1/connect/ticket`: a relay pass for this computer's AppuBot Connect key (protocol connectTicket.ts). */
export const ConnectTicketRequestSchema = z.object({ publicKey: z.string().min(40).max(64) });
export const ConnectTicketResponseSchema = z.object({ ticket: z.string().min(1).max(512), expiresAt: z.number() });
export type ConnectTicketResponse = z.infer<typeof ConnectTicketResponseSchema>;

/**
 * `POST /v1/computer/pair`: the backend asks the computer's control API for a pairing (§6.7 step 4). `identity`: the
 * id this device pairs as (the `device.id` it then sends the computer), so the backend can tell a device coming back
 * to its own place from a new one. A computer that already keeps the most devices it allows makes room for a new one
 * by itself: the one unused longest is removed (`replaced` in the answer), so nobody is locked out of their own
 * computer by devices they no longer have.
 */
export const CloudPairRequestSchema = z.object({ device: CloudDeviceSchema, role: z.enum(['owner', 'full']).optional(), identity: z.string().min(1).max(120).optional() });
export const CloudPairResponseSchema = z.object({
  /** the pairing code the client sends to `POST /api/pair` over `/secure` */
  code: z.string(), hosts: z.array(z.string()), port: z.number().int(), hostName: z.string(),
  /** the computer's X25519 public key (base64url), pinned by the client */
  key: z.string(),
  /** the same as an `appubot://pair?…` link (`buildPairUrl`), for clients that take one */
  url: z.string(),
  role: z.enum(['owner', 'full']),
  expiresAt: Ms,
  /** devices removed from the computer to make room for this one (the ones unused longest) */
  replaced: z.array(CloudPairedDeviceSchema).optional(),
});

export type CloudPairResponse = z.infer<typeof CloudPairResponseSchema>;

/** `POST /v1/computer/desktop`: a 60 s signed noVNC link (§4.4 Open desktop) */
/** the screen port's VNC socket for the AppuBot apps' own viewer; there is no page for a browser */
export const CloudDesktopLinkSchema = z.object({
  /** the VNC socket (`/websockify`) with the token */
  websocketUrl: z.string(),
  expiresAt: Ms,
});
export type CloudDesktopLink = z.infer<typeof CloudDesktopLinkSchema>;

/** what the backend keeps of a notice: the bot's name and the kind, never text (§5.8 item 8) */
export const CloudNoticeKind = z.enum(['done', 'failed', 'needs-you']);
export const CloudNoticeSchema = z.object({ seq: z.number().int().positive(), at: Ms, bot: z.string().max(80), kind: CloudNoticeKind, threadId: z.string().optional() });
export type CloudNotice = z.infer<typeof CloudNoticeSchema>;
/** `GET /v1/computer/notices?after=<seq>` */
export const CloudNoticesSchema = z.object({ seq: z.number().int().nonnegative(), items: z.array(CloudNoticeSchema) });
export type CloudNotices = z.infer<typeof CloudNoticesSchema>;

/** `GET /v1/computer/access-log`: every Agent37 call that touched the user's computer (§6.4 `audit`, D11) */
export const CloudAccessEntrySchema = z.object({ at: Ms, action: z.string(), actor: z.enum(['system', 'user', 'support']), reason: z.string().optional() });
export const CloudAccessLogSchema = z.object({ items: z.array(CloudAccessEntrySchema) });
export type CloudAccessLog = z.infer<typeof CloudAccessLogSchema>;

// ---------------------------------------------------------------------------------------------------------------
// Billing (§6.6)

/**
 * `POST /v1/billing/checkout`: a hosted checkout for one plan at one interval. A Work plan takes `members` (the
 * seats, within the plan's limits) and may name the team; the buyer becomes its first admin.
 */
export const CloudCheckoutRequestSchema = z.object({
  plan: CloudPlanId, interval: CloudInterval, region: CloudRegion.optional(),
  members: z.number().int().min(CLOUD_TEAM_MEMBERS.min).max(CLOUD_TEAM_MEMBERS.max).optional(),
  teamName: z.string().trim().min(1).max(60).optional(),
});
export type CloudCheckoutRequest = z.infer<typeof CloudCheckoutRequestSchema>;
export const CloudCheckoutResponseSchema = z.object({
  checkoutUrl: z.string().url(), sessionId: z.string(),
  /** this checkout starts with a free trial of that many days (absent: charged at once) */
  trialDays: z.number().int().positive().optional().catch(undefined),
});
export type CloudCheckoutResponse = z.infer<typeof CloudCheckoutResponseSchema>;
/**
 * `POST /v1/billing/change-plan` (and `/preview`): another plan or interval for a running subscription (§6.6). An
 * upgrade applies at once with proration (Dodo `prorated_immediately`); a downgrade, or a move to monthly, waits for
 * the period's end (`effective_at: next_billing_date`) and shows as `subscription.scheduledChange` meanwhile.
 */
export const CloudPlanChangeRequestSchema = z.object({
  plan: CloudPlanId, interval: CloudInterval,
  /** a team: the seats wanted (more now, fewer at the period's end); absent keeps them */
  seats: z.number().int().min(CLOUD_TEAM_MEMBERS.min).max(CLOUD_TEAM_MEMBERS.max).optional(),
});
export type CloudPlanChangeRequest = z.infer<typeof CloudPlanChangeRequestSchema>;
export const CloudPlanChangeKind = z.enum(['upgrade', 'downgrade']);
export const CloudPlanChangePreviewSchema = z.object({
  kind: CloudPlanChangeKind,
  /** `immediate` (an upgrade: charged and resized now) or `scheduled` (at the period's end) */
  when: z.enum(['immediate', 'scheduled']),
  effectiveAt: Ms,
  /** what is charged now (an upgrade: the new plan's cycle minus the unused part of the old one); absent when nothing is */
  chargeNow: CloudPriceSchema.optional(),
  /** the plan's price from then on */
  recurring: CloudPriceSchema.optional(),
  /** the shape the computer gets (a downgrade keeps a larger disk: disk never shrinks) */
  shape: CloudShapeSchema,
  /** a team: the seats after the change */
  seats: z.number().int().positive().optional(),
});
export type CloudPlanChangePreview = z.infer<typeof CloudPlanChangePreviewSchema>;
export const CloudPlanChangeResponseSchema = CloudPlanChangePreviewSchema.extend({
  /** the subscription as it is now (an upgrade already shows the new plan; a downgrade its `scheduledChange`) */
  subscription: CloudSubscriptionSchema,
});
export type CloudPlanChangeResponse = z.infer<typeof CloudPlanChangeResponseSchema>;
/** `POST /v1/billing/portal` */
export const CloudPortalResponseSchema = z.object({ url: z.string().url(), expiresAt: Ms });
export type CloudPortalResponse = z.infer<typeof CloudPortalResponseSchema>;

// ---------------------------------------------------------------------------------------------------------------
// Teams (Work plans): one cloud computer a team shares. The buyer is the first admin;
// admins invite and remove people, manage billing and the plan; members use the team's bots, routines and apps but
// can't change the plan or billing. Everyone signs in with their own email; a removed member's devices lose the
// team's computer at once; what a member made stays with the team.

export const CloudTeamRole = z.enum(['admin', 'member']);
export type CloudTeamRole = z.infer<typeof CloudTeamRole>;
export const CloudMemberStatus = z.enum(['invited', 'active']);
export type CloudMemberStatus = z.infer<typeof CloudMemberStatus>;

/** one person on a team, or one invite still open (`status: 'invited'`, `id` is then the invite's) */
export const CloudTeamMemberSchema = z.object({
  id: z.string(), email: Email, role: CloudTeamRole, status: CloudMemberStatus,
  /** when they joined (active) or were invited */
  since: Ms,
  /** an invite: when it lapses */
  expiresAt: Ms.optional(),
  /** an invite: who sent it */
  invitedBy: z.string().optional(),
  /** this row is the person asking */
  you: z.boolean().optional(),
});
export type CloudTeamMember = z.infer<typeof CloudTeamMemberSchema>;

/** a team as a person's account lists it (`CloudAccount.teams`) */
export const CloudTeamSummarySchema = z.object({
  id: z.string(), name: z.string(), role: CloudTeamRole,
  /** how the team's computer signs agents in (§6.11, admins' setting; `own` when absent: a backend from before it) */
  logins: CloudTeamLogins.optional(),
  plan: CloudWorkPlanId.optional(), interval: CloudInterval.optional(), status: CloudAccountStatus.optional(),
  /** seats paid for, and people on the team (active members) */
  seats: z.number().int().nonnegative().optional(), members: z.number().int().nonnegative(),
});
export type CloudTeamSummary = z.infer<typeof CloudTeamSummarySchema>;

/** `GET /v1/teams/:id`: the team, its plan and seats, and its people (members see the list read-only) */
export const CloudTeamSchema = CloudTeamSummarySchema.extend({
  subscription: CloudSubscriptionSchema.optional(),
  /** people on the team plus open invites: what a seat count may not go below */
  used: z.number().int().nonnegative(),
  /** the plan's most members, and the least a team has */
  minMembers: z.number().int().positive(), maxMembers: z.number().int().positive(),
  /** seats after a scheduled change (fewer seats wait for the period's end) */
  scheduledSeats: z.number().int().positive().optional(),
  people: z.array(CloudTeamMemberSchema),
  /** true for admins: invite, remove, roles, seats, plan, billing */
  canManage: z.boolean(),
  /** a team's account page on the web (members, seats, plan) */
  accountUrl: z.string().url().optional(),
});
export type CloudTeam = z.infer<typeof CloudTeamSchema>;

/**
 * `GET /v1/overview`: everything the apps' account views read, in one request (one session check on the backend):
 * the account, the person's own computer, and each team they are on with its computer (a team that failed to read is
 * left out of `teams` and named in `failedTeams`, so the apps keep what they read before). A backend from before it
 * answers 404 `not_found`; the clients then read `/account`, `/computer` and each team as before.
 */
export const CloudOverviewSchema = z.object({
  account: CloudAccountSchema,
  computer: CloudComputerSchema,
  teams: z.array(z.object({ team: CloudTeamSchema, computer: CloudComputerSchema.optional() })),
  failedTeams: z.array(z.string()).optional(),
});
export type CloudOverview = z.infer<typeof CloudOverviewSchema>;

/** an invite waiting for the signed-in person's email (`CloudAccount.invites`) */
export const CloudInviteForMeSchema = z.object({
  id: z.string(), teamId: z.string(), teamName: z.string(), role: CloudTeamRole,
  invitedBy: z.string().optional(), expiresAt: Ms,
});
export type CloudInviteForMe = z.infer<typeof CloudInviteForMeSchema>;

/** `POST /v1/teams/:id/invites` */
export const CloudInviteRequestSchema = z.object({ email: Email, role: CloudTeamRole.optional() });
/**
 * `POST /v1/teams/:id/members/:memberId/remove` and `/invites/:inviteId/revoke`: `dropSeat` also lowers the seats by
 * one at the next billing date (the same scheduled, cancellable change as a seat decrease), in the same call. Refused
 * (`seat_limit`, nothing done) when that would go below the team's least seats or the people and open invites left.
 * Calling it again for someone already gone changes nothing.
 */
export const CloudSeatDropRequestSchema = z.object({ dropSeat: z.boolean().optional() });
/** `POST /v1/teams/:id/members/:memberId/role` */
export const CloudMemberRoleRequestSchema = z.object({ role: CloudTeamRole });
/** `POST /v1/teams/:id/rename` */
export const CloudTeamRenameRequestSchema = z.object({ name: z.string().trim().min(1).max(60) });
/** `POST /v1/teams/:id/logins` (admins): each person's own logins, or one shared set for the whole team */
export const CloudTeamLoginsRequestSchema = z.object({ logins: CloudTeamLogins });
export type CloudTeamLoginsRequest = z.infer<typeof CloudTeamLoginsRequestSchema>;
/** `POST /v1/invites/accept`: by the invite's id (the apps list it) or the link's token (the email) */
export const CloudInviteAcceptRequestSchema = z.object({ inviteId: z.string().optional(), token: z.string().min(16).max(200).optional() }).refine((v) => !!v.inviteId || !!v.token, 'inviteId or token');
/** how long an invite lives */
export const CLOUD_INVITE_TTL_DAYS = 14;

// ---------------------------------------------------------------------------------------------------------------
// The computer ↔ backend edge (§5.7 control API, §5.8 heartbeat). Both ends validate these.

/** the computer's heartbeat, every minute while awake (`POST /v1/computer/heartbeat`, bearer = its backend token) */
export const CloudHeartbeatSchema = z.object({
  /** a turn runs or is queued, computer use is active, a transfer is in flight, or a user has taken over */
  busy: z.boolean(),
  /** the earliest routine run, so the backend wakes it in time (§5.8 item 5) */
  nextWakeAt: Ms.nullable().optional(),
  /** connected clients (desktop, phones) */
  clients: z.number().int().nonnegative(),
  takeover: z.boolean(),
  /** running agent sessions (V2's cap) */
  liveSessions: z.number().int().nonnegative().optional(),
  /** devices watching the screen (a phone's live view, the apps' viewer on the screen port): part of `busy` */
  viewers: z.number().int().nonnegative().optional(),
  noticeSeq: z.number().int().nonnegative(),
  /** notices since the last heartbeat the backend acknowledged (≤ CLOUD_NOTICES_KEPT) */
  notices: z.array(CloudNoticeSchema).max(CLOUD_NOTICES_KEPT).optional(),
  /** why and how the gateway last came up (§5.8 item 7); sent on the first heartbeat after a start */
  wake: CloudWakeSchema.optional(),
  /** the gateway's app version and the image revision it runs */
  version: z.string().optional(), revision: z.number().int().optional(),
  /** this process's run (`EventBus.bootId`) and when it started: the backend's logs tell restarts apart */
  bootId: z.string().optional(), startedAt: Ms.optional(),
  /** what keeps it awake, in words ("2 turns", "routine due"); empty when idle */
  busyWhy: z.array(z.string()).optional(),
  /** the state the gateway is on (what `/control/state` set last), so a missed call shows in the backend's logs */
  state: CloudGatewayState.optional(), resetsAt: Ms.optional(),
  /** a team's computer: the logins setting it is on (what `/control/state` or an answer set last) */
  logins: CloudTeamLogins.optional(),
  /** the fingerprint of the credit token it holds (`CloudCreditSettings.key`; '' for none): the answer carries the token when it differs */
  creditKey: z.string().max(64).optional(),
});
export type CloudHeartbeat = z.infer<typeof CloudHeartbeatSchema>;
/** what the backend answers: the state to show, so the gateway needs no second call */
export const CloudHeartbeatResponseSchema = z.object({
  state: CloudGatewayState, resetsAt: Ms.optional(),
  /** the backend will ask for sleep after this many idle seconds (so the gateway can say "sleeping soon") */
  idleSleepSeconds: z.number().int().nonnegative(),
  /** the notice seq the backend has stored up to */
  noticeSeq: z.number().int().nonnegative(),
  /**
   * A team's computer: members removed from the team. The computer revokes any device still paired for them (the
   * backend also calls `/control/members/revoke` at once; this catches a computer that was asleep then).
   */
  revokedMembers: z.array(z.string()).max(500).optional(),
  /** a team's computer: the admins' logins setting (§6.11); applied like `/control/state`'s, so a change made while it slept lands */
  logins: CloudTeamLogins.optional(),
  /** the included credit (§6.13): its status every minute, the token when the computer's `creditKey` isn't the current one */
  credit: CloudCreditSettingsSchema.optional(),
});
export type CloudHeartbeatResponse = z.infer<typeof CloudHeartbeatResponseSchema>;

/**
 * The owner's time zone (IANA, "Asia/Kolkata") and locale (BCP 47, "en-IN"): the cloud computer's clock, routines'
 * times, the desktop's clock and date formats follow them (it runs in UTC until told). The backend sends them with
 * `bootstrap` and `POST /control/locale` when the owner's devices report a change.
 */
export const ControlLocaleRequestSchema = z.object({ timeZone: z.string().min(1).max(64).optional(), locale: z.string().min(2).max(35).optional() });
export type ControlLocaleRequest = z.infer<typeof ControlLocaleRequestSchema>;
export const ControlLocaleResponseSchema = z.object({ timeZone: z.string(), locale: z.string(), posixLocale: z.string() });

/** `POST /control/bootstrap` (§5.7, §6.7 step 3): the backend hands the computer its public URL once (and the owner's time zone and locale, when it knows them) */
export const ControlBootstrapRequestSchema = z.object({ publicUrl: z.string().url(), backendUrl: z.string().url(), hostName: z.string(), /** a team's computer: its logins setting (§6.11) */ logins: CloudTeamLogins.optional(), /** the included Claude credit with its token (§6.13) */ credit: CloudCreditSettingsSchema.optional() }).extend(ControlLocaleRequestSchema.shape);
export const ControlBootstrapResponseSchema = z.object({
  /** the computer's X25519 public key (base64url), pinned by every client */
  key: z.string(),
  /** its Ed25519 public key (base64url): what its phone pushes are signed with */
  pushKey: z.string().optional(),
  version: z.string(), revision: z.number().int().optional(),
  publicUrl: z.string().url(),
});
export type ControlBootstrapResponse = z.infer<typeof ControlBootstrapResponseSchema>;

/**
 * A team member a pairing is for (§6.11): the device row on the computer keeps who it belongs to, so removing them
 * revokes every device of theirs (`/control/members/revoke`). Absent on a personal computer.
 */
export const ControlMemberSchema = z.object({ id: z.string().min(1).max(80), email: Email });
export type ControlMember = z.infer<typeof ControlMemberSchema>;
/** `POST /control/pairing`: `ttlSec` how long the code lives (default 300) */
export const ControlPairingRequestSchema = z.object({ role: z.enum(['owner', 'full']), device: CloudDeviceSchema, ttlSec: z.number().int().min(30).max(3600).optional(), member: ControlMemberSchema.optional() });
/** `POST /control/members/revoke`: a removed member's devices lose the computer at once (sockets closed, tokens refused) */
export const ControlMemberRevokeRequestSchema = z.object({ memberId: z.string().min(1).max(80) });
export const ControlMemberRevokeResponseSchema = z.object({ revoked: z.number().int().nonnegative() });
/** `POST /control/members/role`: an admin is an owner device, a member a full one (their devices follow a role change) */
export const ControlMemberRoleRequestSchema = z.object({ memberId: z.string().min(1).max(80), role: z.enum(['owner', 'full']) });
export const ControlMemberRoleResponseSchema = z.object({ updated: z.number().int().nonnegative() });
export const ControlPairingResponseSchema = z.object({ code: z.string(), key: z.string(), hosts: z.array(z.string()), port: z.number().int(), hostName: z.string(), expiresAt: Ms });

/** `POST /control/state` (§5.4 `SystemInfo.cloud`): what the computer may do now */
export const ControlStateRequestSchema = z.object({ state: CloudGatewayState, resetsAt: Ms.optional(), /** a team's computer: the logins setting (§6.11); absent leaves it as it is */ logins: CloudTeamLogins.optional(), /** the included Claude credit (§6.13; with the token when it is new); absent leaves it as it is */ credit: CloudCreditSettingsSchema.optional() });
export const ControlStateResponseSchema = z.object({ state: CloudGatewayState, resetsAt: Ms.optional(), logins: CloudTeamLogins.optional(), /** the credit's fingerprint the computer holds now */ creditKey: z.string().optional() });

/**
 * `POST /control/prepare` (§5.7): drain turns, pause routines, remove Telegram webhooks, push the phones, flush.
 * `update`: an image update or a plan change's resize (the container is recreated: the computer comes back as it was,
 * state `ok`); `stop`: a payment on hold or an ended plan.
 */
export const ControlPrepareRequestSchema = z.object({ reason: z.enum(['update', 'stop']), graceMs: Ms });
export const ControlPrepareResponseSchema = z.object({
  /** nothing runs any more: safe to stop/update now */
  drained: z.boolean(),
  /** turns still running (they get the grace) */
  busyThreads: z.number().int().nonnegative(),
});

/**
 * `POST /control/devices/save` and `/control/devices/restore` (a repair, plan §6.9): the paired devices as the
 * computer keeps them (each with its token's hash, never a token), read before a restore and merged back after it, so
 * a computer put back to an older copy keeps every phone, Mac and team member paired since. Revoked tokens and removed
 * members stay revoked. The backend only holds it sealed while the repair runs.
 */
export const ControlDevicesSnapshotSchema = z.object({
  devices: z.array(z.record(z.string(), z.unknown())).max(500),
  revoked: z.array(z.string()).max(1000),
  removedMembers: z.array(z.string()).max(1000).optional(),
  at: Ms,
});
export type ControlDevicesSnapshot = z.infer<typeof ControlDevicesSnapshotSchema>;
export const ControlDevicesRestoreRequestSchema = z.object({ snapshot: ControlDevicesSnapshotSchema });
export const ControlDevicesRestoreResponseSchema = z.object({ added: z.number().int().nonnegative(), removed: z.number().int().nonnegative() });

/** `GET /control/status` */
export const ControlStatusResponseSchema = z.object({
  busy: z.boolean(), nextWakeAt: Ms.nullable(), liveSessions: z.number().int().nonnegative(), clients: z.number().int().nonnegative(), takeover: z.boolean(),
  viewers: z.number().int().nonnegative().optional(),
  version: z.string(), revision: z.number().int().optional(), uptimeMs: Ms,
});

/** `GET /v1/health` on the computer's default port (the edge keeps `/health`) */
export const ControlHealthSchema = z.object({ ok: z.boolean(), healthy: z.boolean(), version: z.string().optional() });

// ---------------------------------------------------------------------------------------------------------------
// Gateway methods and events on the Mac (`services/cloudAccount.ts`, owner only) and the cloud gateway. Schemas only:
// `wire.ts` spreads them into `Methods` / `Events`.

/** what the Mac's core knows: signed in or not, then the account and the computer as last read */
export const CloudAccountViewSchema = z.object({
  signedIn: z.boolean(),
  account: CloudAccountSchema.optional(),
  computer: CloudComputerSchema.optional(),
  catalog: CloudCatalogSchema.optional(),
  /** the Mac is paired to the cloud computer (as owner) */
  paired: z.boolean(),
  /** the last backend error, for Settings › Cloud */
  error: z.string().optional(),
  readAt: Ms.optional(),
  /** a browser sign-in was started and hasn't come back yet */
  signingIn: z.boolean().optional(),
  /**
   * The teams this person is in, each with its shared computer as last read and whether this Mac is paired to it
   * (the switcher shows This Mac / My cloud / each team by name). Absent from a core from before teams.
   */
  teams: z.array(z.object({ team: CloudTeamSchema, computer: CloudComputerSchema.optional(), paired: z.boolean() })).optional(),
});
export type CloudAccountView = z.infer<typeof CloudAccountViewSchema>;
export type CloudTeamView = NonNullable<CloudAccountView['teams']>[number];

/**
 * What the Mac's window needs to open the cloud computer's end-to-end channel as this Mac's owner device
 * (`cloudAccount.connection`, owner only, never in an event): the public address, the pinned X25519 key (base64url)
 * and the device token this Mac's pairing got (`cloudAccount.pair`).
 */
export const CloudConnectionSchema = z.object({
  publicUrl: z.string().url(), key: z.string(), token: z.string(), deviceId: z.string(), hostName: z.string(),
  role: z.enum(['owner', 'full']), pairedAt: Ms,
  /** a team's computer: which team (absent: the person's own cloud computer) */
  team: z.string().optional(),
});
export type CloudConnection = z.infer<typeof CloudConnectionSchema>;

/** which cloud computer a method is about: absent = the person's own, else a team's id (`CloudTeamSummary.id`) */
const Target = { team: z.string().min(1).max(80).optional() };
/** the most a window's saved copy of a cloud computer may hold (`cloudAccount.cacheSet`) */
export const CLOUD_CACHE_MAX_CHARS = 8_000_000;
/** the most one kept page may hold (`cloudAccount.pageSet`: a bot's page with its pictures built in, ≤24 MB of them) */
export const CLOUD_PAGE_MAX_CHARS = 40_000_000;
/** a page id on its computer (a file id) */
const PageId = z.string().regex(/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/);
/** a kept page: where this Mac's gateway frames it (`/cloud-pages/…?v=`), when it was kept and last checked, its hash */
const KeptPageSchema = z.object({ path: z.string(), savedAt: Ms, checkedAt: Ms, hash: z.string() });
const ok = z.object({ ok: z.literal(true) });

export const CloudGatewayMethods = {
  /** the view as last read (and a fresh read when `refresh`) */
  'cloudAccount.status': { params: z.object({ refresh: z.boolean().optional() }), result: CloudAccountViewSchema },
  /** starts the browser sign-in (PKCE): opens `account.appubot.com/sign-in` and waits for the deep link */
  'cloudAccount.signIn': { params: z.object({}), result: z.object({ url: z.string().url(), state: z.string() }) },
  /** the deep link came back (`appubot://cloud/signed-in?code&state`); main calls this itself */
  'cloudAccount.finishSignIn': { params: z.object({ code: z.string(), state: z.string() }), result: CloudAccountViewSchema },
  'cloudAccount.signOut': { params: z.object({}), result: ok },
  /** a Dodo checkout link for a plan (a Work plan with its `members`), opened in the browser */
  'cloudAccount.checkout': { params: CloudCheckoutRequestSchema, result: CloudCheckoutResponseSchema },
  /** a Dodo customer-portal link (a team's: admins only) */
  'cloudAccount.portal': { params: z.object(Target), result: CloudPortalResponseSchema },
  /** the web account page (`account.appubot.com/account`, or a team's page), opened in the browser */
  'cloudAccount.accountPage': { params: z.object(Target), result: z.object({ url: z.string().url() }) },
  /** what a plan change would do (charge now, when it applies, the shape; a team's seats too) */
  'cloudAccount.previewPlanChange': { params: CloudPlanChangeRequestSchema.extend(Target), result: CloudPlanChangePreviewSchema },
  /** change the plan (an upgrade or more seats now, a downgrade or fewer seats at the period's end) */
  'cloudAccount.changePlan': { params: CloudPlanChangeRequestSchema.extend(Target), result: CloudPlanChangeResponseSchema },
  /** call a scheduled downgrade off */
  'cloudAccount.cancelPlanChange': { params: z.object(Target), result: ok },
  /** pair this Mac to a cloud computer through the backend, then over `/secure` (a team's: as this person) */
  'cloudAccount.pair': { params: z.object(Target), result: z.object({ paired: z.literal(true), deviceId: z.string(), replaced: z.array(CloudPairedDeviceSchema).optional() }) },
  /**
   * The cloud computer's paired devices, read and removed through the account (`CloudPairedDevicesSchema`): what the
   * window shows when `cloudAccount.pair` fails with `device_limit` (the computer already keeps the most it allows).
   */
  'cloudAccount.devices': { params: z.object(Target), result: CloudPairedDevicesSchema },
  'cloudAccount.removeDevice': { params: z.object({ ...Target, id: z.string().min(1).max(80) }), result: CloudPairedDevicesSchema },
  /** how the window reaches a cloud computer's channel (null until paired); owner only */
  'cloudAccount.connection': { params: z.object(Target), result: CloudConnectionSchema.nullable() },
  /**
   * The window's saved copy of a cloud computer's chats (its own JSON: bots, threads, recent messages, never a secret),
   * shown at once on switching there while the computer wakes. Kept on this Mac sealed with the OS keychain
   * (`<dataDir>/cloud-cache/`), bound to the signed-in account and dropped when the computer stops being the person's
   * (chat-core `lostCloudCaches`). Reading it never calls the backend or the computer. Owner only; null when none.
   */
  'cloudAccount.cacheGet': { params: z.object(Target), result: z.object({ data: z.string(), savedAt: Ms }).nullable() },
  /** keep the window's copy (`data: ''` drops it); refused while signed out */
  'cloudAccount.cacheSet': { params: z.object({ ...Target, data: z.string().max(CLOUD_CACHE_MAX_CHARS) }), result: ok },
  /**
   * This Mac's copy of a page a bot showed on a cloud computer (`show_page`), kept so its chat shows it at once, even
   * while the computer sleeps (core services/cloudPages.ts: sealed like the copies, the least recently shown dropped
   * past `settings.storage.cloudCopyMb`, gone with them). Never calls the backend or the computer. Owner only.
   */
  'cloudAccount.pageGet': { params: z.object({ ...Target, id: PageId }), result: KeptPageSchema.nullable() },
  /** keep a page's HTML as brought through the computer's channel; `changed`: it differs from the copy kept before */
  'cloudAccount.pageSet': { params: z.object({ ...Target, id: PageId, html: z.string().min(1).max(CLOUD_PAGE_MAX_CHARS) }), result: KeptPageSchema.extend({ changed: z.boolean() }) },
  /** a 60 s signed noVNC link for Open desktop */
  'cloudAccount.desktopLink': { params: z.object(Target), result: CloudDesktopLinkSchema },
  /** wake the cloud computer now (refused on hold / after the plan ended) */
  'cloudAccount.start': { params: z.object(Target), result: CloudComputerSchema },
  'cloudAccount.notices': { params: z.object({ after: z.number().int().nonnegative(), ...Target }), result: CloudNoticesSchema },
  'cloudAccount.accessLog': { params: z.object(Target), result: CloudAccessLogSchema },
  /** wakes a live computer for "Download my bots"; refused on hold or after the plan ended (`on_hold` / `export_only`) */
  'cloudAccount.exportStart': { params: z.object(Target), result: CloudComputerSchema },
  /** the computer's saved copies, newest first (owners; a team's admins) */
  'cloudAccount.backups': { params: z.object(Target), result: CloudBackupListSchema },
  /** Fix your computer: Update, Recover or Reset (owners; a team's admins); it runs on the backend, its progress rides `computer.repair` */
  'cloudAccount.repair': { params: CloudRepairRequestSchema.extend(Target), result: CloudRepairResponseSchema },
  /** end the plan and delete the computer (asks the backend; the portal cancels billing) */
  // --- teams (§6.11) ---
  /** a team, fresh from the backend */
  'cloudAccount.team': { params: z.object({ team: z.string() }), result: CloudTeamSchema },
  /** admins: invite someone by email (a free seat is needed) */
  'cloudAccount.invite': { params: CloudInviteRequestSchema.extend({ team: z.string() }), result: CloudTeamSchema },
  'cloudAccount.resendInvite': { params: z.object({ team: z.string(), inviteId: z.string() }), result: CloudTeamSchema },
  'cloudAccount.revokeInvite': { params: z.object({ team: z.string(), inviteId: z.string(), dropSeat: z.boolean().optional() }), result: CloudTeamSchema },
  /** admins: make someone an admin or a member (a team always keeps one admin) */
  'cloudAccount.setMemberRole': { params: CloudMemberRoleRequestSchema.extend({ team: z.string(), memberId: z.string() }), result: CloudTeamSchema },
  /** admins: remove someone (their devices lose the team's computer at once) */
  'cloudAccount.removeMember': { params: z.object({ team: z.string(), memberId: z.string(), dropSeat: z.boolean().optional() }), result: CloudTeamSchema },
  'cloudAccount.renameTeam': { params: CloudTeamRenameRequestSchema.extend({ team: z.string() }), result: CloudTeamSchema },
  /** admins: how the team's computer signs agents in: each person's own logins, or one shared set (§6.11) */
  'cloudAccount.setTeamLogins': { params: CloudTeamLoginsRequestSchema.extend({ team: z.string() }), result: CloudTeamSchema },
  /** leave a team (the last admin can't) */
  'cloudAccount.leaveTeam': { params: z.object({ team: z.string() }), result: ok },
  /** accept or decline an invite addressed to this person's email */
  'cloudAccount.acceptInvite': { params: z.object({ inviteId: z.string() }), result: CloudTeamSchema },
  'cloudAccount.declineInvite': { params: z.object({ inviteId: z.string() }), result: ok },
  /** on the cloud gateway: a zip of `~/AppuBot` and the store (secrets left out), as a file to download over `/files/:id` */
  'cloud.export': { params: z.object({}), result: z.object({ fileId: z.string(), name: z.string(), size: z.number().int().nonnegative() }) },
} as const;

export const CloudGatewayEvents = {
  /** the view changed (a poll, a sign-in, a checkout landing) */
  'cloudAccount.updated': CloudAccountViewSchema,
  /** a cloud notice while the window is hidden (§5.8 item 8): the Mac raises an OS notification */
  'cloudAccount.notice': CloudNoticeSchema,
} as const;

// ---------------------------------------------------------------------------------------------------------------
// Errors the backend answers with (`{ error: { code, message } }`), branched on by the apps

export const CloudErrorCode = z.enum([
  'unauthorized', 'invalid_request', 'not_found', 'rate_limited', 'signups_closed', 'no_subscription', 'not_ready',
  'on_hold', 'export_only', 'suspended', 'catalog_missing', 'provider_error', 'conflict', 'internal',
  /** an email + password account must verify its address before checkout (§6.5) */
  'email_unverified',
  /** teams (§6.11): only an admin may; no free seat for an invite (or seats below the people on the team); more people than the plan takes (move up); the last admin can't go; the invite is gone or for another email */
  'not_admin', 'seat_limit', 'plan_limit', 'last_admin', 'invite_invalid',
  /** a fix (Update / Recover / Reset) is already running on this computer, or one is running and blocks this */
  'repair_running',
]);
export type CloudErrorCode = z.infer<typeof CloudErrorCode>;
export const CloudErrorSchema = z.object({ error: z.object({ code: CloudErrorCode, message: z.string(), retryAfter: z.number().optional() }) });
export type CloudError = z.infer<typeof CloudErrorSchema>;

/** seconds as hours for the awake line: two decimals at most */
export function secondsToHours(seconds: number): number { return Math.round((seconds / 3600) * 100) / 100; }
