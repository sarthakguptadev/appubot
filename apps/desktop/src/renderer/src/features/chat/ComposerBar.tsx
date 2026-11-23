// A chat's own pickers: the permission mode (Approve for me / Full access), and the agent, model and reasoning effort
// in one model picker. They sat in a row under the composer (28px chrome buttons) until 2026-11-17 and are fields of the
// side panel's Details tab now (features/bots/BotPanel.tsx), each the value at the end of its row.
import { memo } from 'react';
import { APPUBOT_AI_PROVIDER_ID, offeredModels, type Thread } from '@appubot/protocol';
import { effortsFor } from '@appubot/chat-core';
import { confirm } from '../../lib/actions';
import { setThreadEffort, setThreadFast, setThreadMode, setThreadModel, switchThreadAgent, useThreadChoices } from '../../lib/choices';
import { getState, useStore } from '../../lib/store';
import { ModelPicker, type ModelPick } from '../providers/ModelPicker';
import { PermissionPicker } from '../providers/PermissionPicker';

/** The chat's permission mode, left of the footer like Synara's permissions trigger. */
export const ModePicker = memo(function ModePicker({ thread: reported, variant = 'chrome', side = 'top', align, className, onMode }: {
  thread?: Thread; variant?: 'chrome' | 'field'; side?: 'top' | 'bottom'; align?: 'start' | 'end'; className?: string;
  /** told a pick after it went to the chat (the side panel saves it as the bot's own too) */
  onMode?: (modeId: string) => void;
}) {
  // what was picked shows at once and stays while the computer catches up (lib/choices.ts)
  const thread = useThreadChoices(reported);
  const modes = thread?.modes ?? [];
  // Approve for me and Full access: the agent's own (Claude Code, Codex) or AppuBot's (every other agent)
  if (!thread || modes.length < 2) return null;
  return (
    <PermissionPicker
      variant={variant}
      side={side}
      align={align}
      className={className}
      label="Permissions"
      providerId={thread.providerId}
      modes={modes}
      value={thread.modeId ?? ''}
      onChange={(id) => { void setThreadMode(thread, id); onMode?.(id); }}
    />
  );
});

/** Another agent's model: the bot moves there (after asking) and this chat continues on it (core's `switchProvider`). */
function switchAgent(thread: Thread, providerId: string, modelId: string): void {
  const s = getState();
  const bot = s.bots.find((b) => b.id === thread.botId);
  if (!bot) return;
  const agent = s.providers.find((p) => p.id === providerId)?.name ?? providerId;
  confirm({
    title: `Switch ${bot.name} to ${agent}?`,
    body: `This chat continues on ${agent}.`,
    confirmLabel: 'Switch',
    onConfirm: () => switchThreadAgent(thread, bot, providerId, modelId, agent),
  });
}

/** The chat's agent, model and reasoning effort, right of the footer beside send; an effort also becomes the bot's own (`threads.setEffort`). */
export const ThreadModelPicker = memo(function ThreadModelPicker({ thread: reported, variant, side, align, className, onModel }: {
  thread?: Thread; variant?: 'chrome' | 'field'; side?: 'top' | 'bottom'; align?: 'start' | 'end'; className?: string;
  /** told a model picked on the same agent after it went to the chat (the side panel saves it as the bot's own too) */
  onModel?: (modelId: string) => void;
}) {
  // what was picked shows at once and stays while the computer catches up (lib/choices.ts)
  const thread = useThreadChoices(reported);
  // reset goes to Settings' effort for new bots (a pick here already becomes the bot's own effort)
  const defaultEffort = useStore((s) => s.settings?.defaultEffort ?? 'medium');
  const threads = useStore((s) => s.threads);
  if (!thread) return null;
  // no lists from the thread yet (its agent hasn't started, or failed to): the agent's own (providers.choices), so the
  // picker stays, and a broken agent can still be switched away from
  const own = thread.models.length || thread.efforts.length;
  const onChange = (n: ModelPick) => {
    if (n.providerId && n.providerId !== thread.providerId) return switchAgent(thread, n.providerId, n.modelId ?? '');
    if (n.modelId !== undefined && n.modelId !== thread.modelId) { void setThreadModel(thread, n.modelId); onModel?.(n.modelId); }
    if (n.effort !== undefined && n.effort !== thread.effortId) void setThreadEffort(thread, n.effort);
    if (n.fast !== undefined && n.fast !== thread.fast) void setThreadFast(thread, n.fast);
  };
  return (
    <ModelPicker
      context="thread"
      variant={variant}
      side={side}
      align={align}
      className={className}
      providerId={thread.providerId}
      modelId={thread.modelId ?? ''}
      effort={thread.effortId ?? ''}
      defaultEffort={defaultEffort}
      models={own ? offeredModels(thread.providerId, thread.models) : undefined}
      // a model switch empties the list until the agent re-reports it: the levels this model reported before stand in
      efforts={own ? effortsFor(thread, threads) : undefined}
      fast={thread.fast}
      fastAvailable={thread.fastAvailable && thread.providerId !== APPUBOT_AI_PROVIDER_ID}
      contextSize={thread.context?.size}
      onChange={onChange}
    />
  );
});
