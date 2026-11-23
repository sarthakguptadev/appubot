/**
 * "Chat with Sarthak", the support chat: a widget like the website's, a bubble at the bottom right of the window that
 * expands into Crisp's chat (`SupportWidget`; Crisp's hosted page is main's own view laid over the panel,
 * electron/supportChat.ts, so Crisp's script never runs in this window, which holds the gateway's owner token).
 * Opened from the bubble, the quick switcher, Settings › About, the Help menu and the tray.
 */
import { getState, setState } from '../../lib/store';
import { native } from '../../lib/native';

/** for those who'd rather write an email */
export const SUPPORT_EMAIL = 'sarthak@appubot.com';

/** the email left in the old support chat (before Crisp), passed on so Crisp doesn't ask for it again */
const OLD_EMAIL_KEY = 'appubot:supportEmail';

/** Who is writing, as far as this app knows (the chat is made once, with it). */
export function supportUser(): { email?: string } {
  try {
    const email = localStorage.getItem(OLD_EMAIL_KEY);
    return email ? { email } : {};
  } catch { return {}; }
}

export function openSupport(): void { setState({ supportOpen: true }); }
export function closeSupport(): void { setState({ supportOpen: false }); }
export function toggleSupport(): void { setState({ supportOpen: !getState().supportOpen }); }

export function emailSupport(): void {
  void native().openExternal(`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent('AppuBot support')}`);
}
