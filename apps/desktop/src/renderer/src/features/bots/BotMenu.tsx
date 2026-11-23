import type { Bot } from '@appubot/protocol';
import { FolderOpen, GraduationCap, MoreHorizontal, Move, Pencil, Pin, Trash2, Users } from '../../components/ui/icons';
import { Button, Menu } from '../../components/ui';
import { call, deleteBot, openBotDetails, setPinned } from '../../lib/actions';
import { TEACH } from '../../lib/platform';
import { useCloudLacks } from '../cloud/useCloudLacks';
import { useCloud } from '../cloud/cloudAccount';
import { useCloudLink } from '../cloud/cloudClient';
import { moveTargets, openMoveBot } from './MoveBotDialog';
import { activeComputer } from '../../lib/gateway';
import { ui, useStore } from '../../lib/store';

/** Overflow menu for a bot: pin, its details (the side panel), open workspace, teach, delete. */
export function BotMenu({ bot, size = 'icon-sm' }: { bot: Bot; size?: 'icon' | 'icon-sm' }) {
  const lacks = useCloudLacks();
  const view = useCloud((s) => s.view);
  const team = useCloudLink((s) => s.team);
  const from = activeComputer() === 'cloud' ? (team ? `cloud:${team}` as const : 'cloud' as const) : 'local' as const;
  const canMove = moveTargets(from, view).length > 0;
  const groupsSupported = useStore((s) => s.groupsSupported);
  return (
    <Menu
      trigger={(p) => (
        <Button
          variant="ghost"
          size={size}
          icon={MoreHorizontal}
          aria-label="Bot options"
          aria-haspopup="menu"
          aria-expanded={p['aria-expanded']}
          onClick={(e) => { e.stopPropagation(); p.onClick(); }}
        />
      )}
      items={[
        { label: bot.pinned ? 'Unpin' : 'Pin to top', icon: Pin, onSelect: () => setPinned(bot, !bot.pinned) },
        { label: 'Bot details', icon: Pencil, onSelect: () => openBotDetails(bot.id) },
        // a group starts here (the sidebar's + makes bots only): this bot in it, the others picked in the editor
        ...(groupsSupported ? [{ label: 'Make a group', icon: Users, onSelect: () => ui.openModal({ kind: 'group', withBotId: bot.id }) }] : []),
        // its folder in Finder: on this Mac (a remote computer's opens on that computer's own screen, not here)
        ...(from === 'local' ? [{
          label: 'Open workspace folder',
          icon: FolderOpen,
          onSelect: () => void call('system.openPath', { path: bot.workspace }, { errorTitle: 'Could not open folder' }),
        }] : []),
        // to your AppuBot computer, or between AppuBot computers; never back to this Mac (features/bots/MoveBotDialog)
        ...(canMove ? [{ label: 'Move to another computer…', icon: Move, onSelect: () => openMoveBot(bot) }] : []),
        // teach mode: a bot watches the user do a task (lib/platform TEACH)
        ...(TEACH && !lacks.teach ? [{
          label: 'Teach a task',
          icon: GraduationCap,
          onSelect: () => { ui.selectBot(bot.id); ui.openModal({ kind: 'teach' }); },
        }] : []),
        'separator',
        {
          label: 'Delete bot',
          icon: Trash2,
          danger: true,
          onSelect: () => deleteBot(bot, { body: 'Its chats, skills and routines will be removed. The workspace folder stays on disk.', confirmLabel: 'Delete bot', deleteWorkspace: false }),
        },
      ]}
    />
  );
}
