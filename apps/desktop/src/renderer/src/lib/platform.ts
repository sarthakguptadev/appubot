// What differs by OS in the window: the machine's name in copy ("this Mac" / "this PC"), the file manager, shortcut
// labels (⌘ on macOS, Ctrl elsewhere), computer use's permissions (macOS only) and the macOS-only features (lid mode).
import { computerUseSupported, fileManagerName, machineName } from '@appubot/protocol';
import { native } from './native';

export const PLATFORM = native().platform;
export const IS_MAC = PLATFORM === 'darwin';
/** "Mac", "PC" or "computer" */
export const MACHINE = machineName(PLATFORM);
/** "this Mac", "this PC", "this computer" */
export const THIS_MACHINE = `this ${MACHINE}`;
/** bots see and use the user's apps: macOS, Windows and Linux */
export const COMPUTER_USE = computerUseSupported(PLATFORM);
/** teach mode (a bot watches the user do a task and saves it as a skill): wherever computer use is */
export const TEACH = COMPUTER_USE;
/** computer use needs the user's grants (Accessibility, Screen Recording): macOS only, Windows and Linux ask for none */
export const COMPUTER_PERMISSIONS = COMPUTER_USE && IS_MAC;
/** "Show in Finder", "Show in File Explorer", "Show in folder" */
export const SHOW_IN_FOLDER = PLATFORM === 'linux' ? 'Show in folder' : `Show in ${fileManagerName(PLATFORM)}`;
/** a shortcut's label: `shortcut('N')` is ⌘N on macOS, Ctrl+N elsewhere */
export const shortcut = (key: string): string => (IS_MAC ? `⌘${key}` : `Ctrl+${key}`);
/** where agent logins and installs run: macOS's Terminal app, a terminal window elsewhere */
export const TERMINAL = IS_MAC ? 'Terminal' : 'the terminal';
