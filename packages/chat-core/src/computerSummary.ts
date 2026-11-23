import type { ComputerAction } from '@appubot/protocol';
import { truncate } from './format';

const MOD: Record<string, string> = { cmd: '⌘', command: '⌘', shift: '⇧', alt: '⌥', option: '⌥', ctrl: '⌃', control: '⌃', fn: 'fn' };
const KEYS: Record<string, string> = { enter: '↵', return: '↵', tab: '⇥', escape: 'Esc', esc: 'Esc', space: 'Space', backspace: '⌫', delete: '⌦', up: '↑', down: '↓', left: '←', right: '→' };

export function prettyKey(key: string): string {
  return key.split('+').map((k) => MOD[k.toLowerCase()] ?? KEYS[k.toLowerCase()] ?? (k.length === 1 ? k.toUpperCase() : k)).join('');
}

const pt = (x?: number, y?: number) => (x !== undefined && y !== undefined ? ` (${Math.round(x)}, ${Math.round(y)})` : '');
/** Where a background window action landed: " in Safari" (element clicks carry no coordinates). */
const inApp = (a: ComputerAction) => (a.app && a.pid !== undefined ? ` in ${a.app}` : '');
const where = (a: ComputerAction) => (a.element ? inApp(a) : `${pt(a.x, a.y)}${inApp(a)}`);

/** `detail` is JSON from the bridge (or a bare string); pull one field out of it. */
function detailField(a: ComputerAction, key: string): string | undefined {
  if (!a.detail) return undefined;
  try {
    const v = (JSON.parse(a.detail) as Record<string, unknown>)[key];
    return typeof v === 'string' ? v : undefined;
  } catch { return undefined; }
}

/** Human summary of a computer-use action, e.g. "Click (412, 88)". */
export function actionSummary(a: ComputerAction): string {
  switch (a.type) {
    case 'screenshot': return 'Look at the screen';
    case 'window': return a.app ? `Look at ${a.app}` : 'Look at a window';
    case 'click': return `Click${where(a)}`;
    case 'double_click': return `Double-click${where(a)}`;
    case 'right_click': return `Right-click${where(a)}`;
    case 'move': return `Move pointer${pt(a.x, a.y)}`;
    case 'drag': return `Drag${pt(a.x, a.y)} → ${pt(a.toX, a.toY).trim()}`;
    case 'type': return a.text ? `Type “${truncate(a.text, 40)}”${inApp(a)}` : 'Type';
    case 'key': return a.key ? `Press ${prettyKey(a.key)}` : 'Press key';
    case 'hotkey': return a.key ? `Press ${prettyKey(a.key)}` : 'Press shortcut';
    case 'scroll': return `Scroll ${detailField(a, 'direction') ?? ''}${where(a)}`.replace(/\s+/g, ' ').trim();
    case 'open_app': return a.app ? `Open ${a.app}` : 'Open app';
    case 'focus_window': return a.app ? `Switch to ${a.app}` : 'Focus window';
    case 'wait': return 'Wait for the screen to settle';
    case 'accessibility': return a.app ? `Read ${a.app}’s controls` : 'Read app controls';
    case 'clipboard': return detailField(a, 'op') === 'write' ? 'Write the clipboard' : 'Read the clipboard';
    default: return detailField(a, 'cmd')?.replace(/_/g, ' ') ?? 'Computer action';
  }
}

/** Transcript sentence for an action, past tense when done ("Clicked (412, 88)") or in progress ("Clicking …"). */
export function actionSentence(a: ComputerAction, running: boolean): string {
  const t = (done: string, doing: string) => (running ? doing : done);
  const at = where(a);
  switch (a.type) {
    case 'screenshot': return t('Looked at the screen', 'Looking at the screen');
    case 'window': return `${t('Looked at', 'Looking at')} ${a.app ?? 'a window'}`;
    case 'click': return `${t('Clicked', 'Clicking')}${at}`;
    case 'double_click': return `${t('Double-clicked', 'Double-clicking')}${at}`;
    case 'right_click': return `${t('Right-clicked', 'Right-clicking')}${at}`;
    case 'move': return `${t('Moved the pointer', 'Moving the pointer')}${at}`;
    case 'drag': return `${t('Dragged', 'Dragging')}${at} → ${pt(a.toX, a.toY).trim()}`;
    case 'type': return a.text ? `${t('Typed', 'Typing')} “${truncate(a.text, 40)}”${inApp(a)}` : t('Typed', 'Typing');
    case 'key': case 'hotkey': return a.key ? `${t('Pressed', 'Pressing')} ${prettyKey(a.key)}` : t('Pressed a key', 'Pressing a key');
    case 'scroll': return `${t('Scrolled', 'Scrolling')} ${detailField(a, 'direction') ?? ''}${at}`.replace(/\s+/g, ' ').trim();
    case 'open_app': return `${t('Opened', 'Opening')} ${a.app ?? 'an app'}`;
    case 'focus_window': return `${t('Switched to', 'Switching to')} ${a.app ?? 'a window'}`;
    case 'wait': return t('Waited for the screen', 'Waiting for the screen');
    case 'accessibility': return a.app ? `${t('Read', 'Reading')} ${a.app}’s controls` : t('Read the app’s controls', 'Reading the app’s controls');
    case 'clipboard': return detailField(a, 'op') === 'write' ? t('Wrote the clipboard', 'Writing the clipboard') : t('Read the clipboard', 'Reading the clipboard');
    default: {
      const cmd = detailField(a, 'cmd');
      return cmd === 'list_apps' ? t('Listed apps', 'Listing apps') : cmd === 'list_windows' ? t('Listed windows', 'Listing windows') : t('Used the computer', 'Using the computer');
    }
  }
}
