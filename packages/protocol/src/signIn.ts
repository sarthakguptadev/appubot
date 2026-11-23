/**
 * Pairing a phone and AppuBot Connect are for people signed in to AppuBot. Each app checks its own sign-in: the
 * computer before it shows a pairing code or dials the relay, the phone before it pairs or joins the relay.
 */

/** What the phone says when it isn't signed in and tries to pair. */
export const PAIR_SIGN_IN_TEXT = 'Sign in to AppuBot on this phone first, then pair again.';
/** What either app says when AppuBot Connect is wanted while signed out. */
export const CONNECT_SIGN_IN_TEXT = 'AppuBot Connect needs you signed in to AppuBot. Sign in (Settings › Account), then try again.';
