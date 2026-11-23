/**
 * AppuBot's launch gift (2026-11-10, the Product Hunt launch): the card that opens on a person's own computer while
 * the free Claude day is on (`SystemInfo.promo`, protocol `PromoStatus`). Three steps, in order: see the launch on
 * Product Hunt, share it on X (a post written for them), then the gift itself (signing in to AppuBot if needed):
 * Claude, free and unlimited until the day ends, for the bots the person picks (none moves by itself). The steps are taken on the person's word: opening the
 * page is what the card can see, nothing checks a vote or a post.
 *
 * Wording: the first step asks people to support the launch by upvoting and replying (the owner's call, 2026-11-10,
 * made knowing Product Hunt's launch rules say "Don't ask for upvotes" and "Don't run contests that require
 * upvotes or reward people for upvotes": change the words here if that risk stops being worth it). The X post
 * never asks for a vote. The model behind the gift is never named: it is "Claude".
 */

/** the launch's page, unless the backend names another (`PromoStatus.launchUrl`) */
export const LAUNCH_URL = 'https://www.producthunt.com/products/appubot';
/**
 * The posts the card writes, one picked at random for each person (so X doesn't fill with the same words), unless
 * the backend sends its own (`PromoStatus.postText`). Each says the same true things in its own way: AppuBot is
 * live on Product Hunt today, what it is, and the day's gift. None asks for a vote, names the model or speaks of an
 * experience the person may not have had. With X's 23-character link each fits a post (a test counts).
 */
export const LAUNCH_POSTS: readonly string[] = [
  'AppuBot is live on Product Hunt today 🚀\n\nAI bots that work on your own computer, and for launch day everyone gets unlimited Claude, free for 24 hours.\n\n@AppuBot_',
  '@AppuBot_ just launched on Product Hunt.\n\nYou give a bot a job and it does it on your computer. Today only: unlimited Claude for every user, free for 24 hours.',
  'Launch day for @AppuBot_ on Product Hunt 🎉\n\nBots that click, type and get work done on your Mac or PC. They’re giving everyone 24 hours of unlimited Claude to celebrate.',
  'Free unlimited Claude for 24 hours? @AppuBot_ is doing it for their Product Hunt launch.\n\nIt’s an app where AI bots do jobs on your own computer.',
  'If you’ve wanted an AI that actually uses your computer for you, @AppuBot_ launched on Product Hunt today.\n\nLaunch gift: unlimited Claude, free for 24 hours.',
  '@AppuBot_ is on Product Hunt today.\n\n• AI bots with their own jobs\n• They work in the apps on your computer\n• Unlimited Claude, free for 24 hours\n\nWorth a look 👇',
  'Today on Product Hunt: @AppuBot_ 🤖\n\nA crew of AI bots that work on your computer while you do something else. Every user gets unlimited Claude free for the next 24 hours.',
  'The @AppuBot_ team launched on Product Hunt today and unlocked unlimited Claude for everyone for 24 hours.\n\nGive a bot a job, it gets it done on your computer.',
  'Trying out @AppuBot_ on its Product Hunt launch day.\n\nAI bots that run on my own computer, plus 24 hours of unlimited Claude for free. Good day to try it.',
  'PSA: @AppuBot_ is giving every user unlimited Claude, free, for 24 hours.\n\nIt’s their Product Hunt launch day. The app puts AI bots to work on your own computer.',
  '@AppuBot_ went live on Product Hunt 🚀\n\nBots you can message from your phone that do the work on your computer at home. Unlimited Claude is free for 24 hours for launch.',
  'New on Product Hunt today: @AppuBot_\n\nGive each bot a job, a schedule and the apps it needs, and it works on your computer. Launch day gift: 24 hours of unlimited Claude.',
  'Big day for @AppuBot_: live on Product Hunt 🎉\n\nAI bots that work on your Mac, Windows or Linux computer. For the next 24 hours, everyone gets unlimited Claude for free.',
  'Launch gift alert 🎁\n\n@AppuBot_ is live on Product Hunt and every user gets unlimited Claude, free for 24 hours. AI bots that do real work on your own computer.',
  '@AppuBot_ is live on Product Hunt today.\n\nThink of it as a team of AI bots that live on your computer. To celebrate, everyone gets unlimited Claude, free for 24 hours.',
  'One for the AI agent crowd: @AppuBot_ launched on Product Hunt today.\n\nBots that use your computer the way you do. Unlimited Claude, free for 24 hours while the launch is on.',
  'It’s launch day for @AppuBot_ 🚀\n\nLive on Product Hunt now, with unlimited Claude free for every user for 24 hours. AI bots that get jobs done on your own computer.',
  '@AppuBot_ on Product Hunt today 👀\n\nYour own AI bots, working on your own computer, reachable from your phone. Launch day comes with 24 hours of unlimited Claude, free.',
  '24 hours of unlimited Claude, free, from @AppuBot_.\n\nThey’re live on Product Hunt today. AI bots that take a job and do it on your computer.',
  'Go check out @AppuBot_ on Product Hunt today.\n\nAI bots that work on your computer for you, and unlimited Claude free for 24 hours as a launch gift 🎁',
];
/** the first of them: what shows where no pick was made */
export const LAUNCH_POST_TEXT = LAUNCH_POSTS[0]!;
/** a post's number for a new person (`random`: 0..1, `Math.random` in the apps) */
export function randomLaunchPost(random: () => number = Math.random): number {
  return Math.min(LAUNCH_POSTS.length - 1, Math.max(0, Math.floor(random() * LAUNCH_POSTS.length)));
}
/** the post to show: the backend's own words when it sent any, else the person's pick (any number wraps into the list) */
export function launchPostText(sent: string | undefined, pick: number): string {
  const own = sent?.trim();
  if (own) return own;
  const n = Number.isFinite(pick) ? Math.abs(Math.trunc(pick)) % LAUNCH_POSTS.length : 0;
  return LAUNCH_POSTS[n]!;
}

export type GiftStep = 'launch' | 'post' | 'gift';
export const GIFT_STEPS: readonly GiftStep[] = ['launch', 'post', 'gift'];

export const LAUNCH_GIFT = {
  eyebrow: 'AppuBot Launch Gift',
  /** the tracker's three steps */
  steps: { launch: 'Support the launch', post: 'Share it', gift: 'Open your gift' },
  launch: {
    title: 'We’re live on Product Hunt today',
    body: 'To celebrate, everyone gets unlimited Claude in AppuBot, free for 24 hours. First, support the launch by upvoting and replying.',
    open: 'Open Product Hunt',
    done: 'Done, next',
    again: 'Open Product Hunt again',
  },
  post: {
    title: 'Tell people about it',
    body: 'Share the launch on X. The post is written for you; change it however you like.',
    open: 'Post on X',
    done: 'Posted, next',
    again: 'Open the post again',
  },
  gift: {
    title: 'Your gift: unlimited Claude, free',
    body: 'Claude is added to AppuBot until the gift ends. You choose which bots use it. Nothing to pay and no key to enter.',
    signIn: 'Sign in to AppuBot',
    signInLine: 'Sign in so the gift is yours: with Google, Apple or your email, in your browser.',
    waiting: 'Finish signing in in your browser. AppuBot comes back here by itself.',
    start: 'Open my gift',
    note: 'Fair use applies. It ends early if the gift runs out.',
  },
  on: {
    title: 'Claude is yours until it ends',
    body: 'Turn it on for the bots you like. You can also pick “AppuBot Launch Gift” in any bot’s model picker, and they go back to what they used when the gift ends.',
    choose: 'Use Claude',
    close: 'Done',
  },
  over: {
    title: 'The launch gift has ended',
    usedUpTitle: 'You’ve reached the gift’s fair-use limit',
    body: 'The bots you put on it are back on what they used before. To keep using Claude, sign in with your own Claude account in Settings › Agents.',
    close: 'OK',
    agents: 'Open Agents',
  },
  /** the ✕'s label */
  later: 'Not now',
  back: 'Back',
} as const;

/** what the card says while Start runs (`PromoStatus.step`) */
export function giftProgressText(step: 'account' | 'install' | undefined): string {
  return step === 'install' ? 'Setting up Claude… this can take a minute' : 'Getting your gift…';
}

/** the X compose page with the post written: the words, then the launch's link */
export function launchPostUrl(text: string | undefined, url: string | undefined): string {
  const q = new URLSearchParams({ text: (text?.trim() || LAUNCH_POST_TEXT), url: url?.trim() || LAUNCH_URL });
  return `https://x.com/intent/post?${q.toString()}`;
}

/** "Ends in 21 hours", "Ends in 40 minutes", "Ends soon"; '' without an end */
export function giftEndsText(endsAt: number | undefined, now: number): string {
  if (endsAt === undefined) return '';
  const left = endsAt - now;
  if (left <= 60_000) return 'Ends soon';
  const hours = Math.floor(left / 3_600_000);
  if (hours >= 1) return `Ends in ${hours} hour${hours === 1 ? '' : 's'}`;
  const minutes = Math.max(1, Math.floor(left / 60_000));
  return `Ends in ${minutes} minute${minutes === 1 ? '' : 's'}`;
}

/** the step after one is done; the gift is the last */
export function nextGiftStep(step: GiftStep): GiftStep {
  return GIFT_STEPS[Math.min(GIFT_STEPS.indexOf(step) + 1, GIFT_STEPS.length - 1)]!;
}

/**
 * Whether the card opens by itself now: an offer (or its "it's over" note) on this computer, the app set up, loaded
 * and in front, nothing else covering the window, and not put away this run (the ✕ closes it until the next
 * launch; the offer itself stands until the day ends).
 */
export function giftCardOpensNow(s: { state: 'offer' | 'starting' | 'on' | 'over' | undefined; onboarded: boolean; loaded: boolean; inFront: boolean; covered: boolean; thisComputer: boolean; putAway: boolean }): boolean {
  if (!s.state || !s.onboarded || !s.loaded || !s.thisComputer) return false;
  // Start is running: the card stays whatever else happens
  if (s.state === 'starting') return true;
  if (s.state === 'on') return false;
  return s.inFront && !s.covered && !s.putAway;
}
