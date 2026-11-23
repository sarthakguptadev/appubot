/**
 * The side panel's Details tab: everything a bot is set up with, changed here (there is no editor dialog; the avatar,
 * name and job are in the panel's top, features/bots/BotHero.tsx, and its threads are the tab before this one). One
 * card of one-line rows, the name at the left and its value or control at the end: the model with its effort, the
 * permission mode, computer use (and the way to allow it on a Mac that hasn't), chief, whose logins it uses on a team's
 * computer, its apps, its instructions (a row with a right arrow: it opens their editor in the tab, which saves by
 * itself) and how full the chat's context is. A model or mode picked here is the chat's at once and becomes the bot's
 * own, so its next threads start on it.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { offersFastMode, type Bot } from '@appubot/protocol';
import { botLoginsText } from '@appubot/chat-core';
import { AlertCircle, ChevronLeft, ChevronRight } from '../../components/ui/icons';
import { EmptyState, Icon, MarkdownEditor, Select, SettingsCard, Switch, cn } from '../../components/ui';
import { updateBot } from '../../lib/actions';
import { useAutoSave } from '../../lib/hooks';
import { COMPUTER_USE } from '../../lib/platform';
import { selectSelectedBot, selectSelectedThread, ui, useStore } from '../../lib/store';
import { ModePicker, ThreadModelPicker } from '../chat/ComposerBar';
import { ContextRing } from '../chat/ContextRing';
import { useCloud } from '../cloud/cloudAccount';
import { useCloudLink } from '../cloud/cloudClient';
import { useComputerAccessMissing } from '../computer/PermissionRows';
import { ModelPicker, type ModelPick } from '../providers/ModelPicker';
import { PermissionPicker, genericMode } from '../providers/PermissionPicker';
import { PERMISSIONS_TITLE, settingAnchorId } from '../settings/nav';

const ROW = 'flex min-h-11 items-center gap-3 px-3.5 py-1.5';
const ROW_LABEL = 'shrink-0 text-copy text-fg';
/** a picker at a row's end: its value in the row's own type, its chevron on the row's right edge, a long name cut short */
const ROW_PICKER = '-mr-2 [&>button]:text-ui [&_.truncate]:min-w-0 [&_.truncate]:shrink';

/** One line of a list: what it is at the left, its value or control at the end. */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={ROW}>
      <span className={ROW_LABEL}>{label}</span>
      <span className="flex min-w-0 flex-1 items-center justify-end gap-1.5">{children}</span>
    </div>
  );
}

/**
 * The bot's own agent, model and effort, for a bot with no chat on screen (its chats' picker is `ThreadModelPicker`).
 * Another agent has other models: the one picked there, else its own default (the default agent's default model), and
 * the same permission choice, which the bot keeps as that agent's own.
 */
function BotModel({ bot }: { bot: Bot }) {
  const defaultProviderId = useStore((s) => s.settings?.defaultProviderId ?? 'claude-code');
  const defaultModelId = useStore((s) => s.settings?.defaultModelId ?? '');
  const defaultEffort = useStore((s) => s.settings?.defaultEffort ?? 'medium');
  const defaultModeId = useStore((s) => s.settings?.defaultModeId ?? 'auto');
  const pick = (n: ModelPick) => {
    const patch: Parameters<typeof updateBot>[1] = {};
    if (n.providerId && n.providerId !== bot.providerId) {
      patch.providerId = n.providerId;
      patch.modelId = n.modelId ?? (n.providerId === defaultProviderId ? defaultModelId : '');
      patch.modeId = genericMode(bot.modeId ?? '') || defaultModeId;
    } else if (n.modelId !== undefined) patch.modelId = n.modelId;
    if (n.effort !== undefined) patch.effort = n.effort;
    if (n.fast !== undefined) patch.fast = n.fast;
    if (Object.keys(patch).length) void updateBot(bot, patch, { errorTitle: 'Could not save bot' });
  };
  return (
    <ModelPicker
      context="bot"
      variant="chrome"
      side="bottom"
      align="end"
      className={ROW_PICKER}
      providerId={bot.providerId}
      modelId={bot.modelId ?? ''}
      effort={bot.effort}
      defaultEffort={defaultEffort}
      fast={bot.fast}
      fastAvailable={offersFastMode(bot.providerId)}
      onChange={pick}
    />
  );
}

/**
 * A team's cloud computer (§6.11): whose logins the bot uses. On "each person uses their own" it is the person whose
 * device made it, and an admin can hand it to someone else; on "shared" every bot uses the team's.
 */
function LoginsRow({ bot }: { bot: Bot }) {
  const cloud = useStore((s) => s.system?.cloud);
  const teamId = useCloudLink((s) => (s.computer === 'cloud' ? s.team : undefined));
  const admin = useCloud((s) => !!s.view?.teams?.find((t) => t.team.id === teamId)?.team.canManage);
  if (!cloud?.logins) return null;
  const members = cloud.members ?? [];
  const value = bot.memberId ?? '';
  const owner = value ? { email: members.find((m) => m.id === value)?.email ?? value } : undefined;
  const canPick = admin && cloud.logins === 'own' && members.length > 0;
  return (
    <Row label="Logins">
      {canPick ? (
        <Select fit value={value} onChange={(e) => void updateBot(bot, { memberId: e.target.value }, { errorTitle: 'Could not save bot' })} aria-label="Whose logins">
          <option value="">No one yet</option>
          {members.map((m) => <option key={m.id} value={m.id}>{m.email}</option>)}
        </Select>
      ) : <span className="min-w-0 truncate text-ui text-muted">{botLoginsText(cloud.logins, owner)}</span>}
    </Row>
  );
}

/**
 * How the bot should work, in its own words: the view behind Details' Instructions row. The code view's card fills the
 * tab under a way back; edits save by themselves a moment after typing stops (`useAutoSave`; ⌘S and going back save
 * now), so there is no Save button.
 */
function Instructions({ bot, onBack }: { bot: Bot; onBack: () => void }) {
  const saved = bot.instructions ?? '';
  const [draft, setDraft] = useState(saved);
  const { queue, flush, busy } = useAutoSave(900);
  // the bot changed them itself (update_bot), or another device did: take it unless an edit is on its way
  const editing = useRef(false);
  editing.current = busy || draft !== saved;
  useEffect(() => { if (!editing.current) setDraft(saved); }, [saved]);
  const edit = (value: string) => {
    setDraft(value);
    // shown at once; a refusal is toasted and put back by updateBot itself
    queue(() => updateBot(bot, { instructions: value }, { errorTitle: 'Could not save the instructions' }));
  };
  return (
    <div className="flex h-full flex-col px-3.5 pt-1 pb-24">
      <div className="mb-2 flex h-8 shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={() => { flush(); onBack(); }}
          className="ab-pill squircle -ml-1.5 inline-flex h-8 items-center gap-1 rounded-control-sm pr-3 pl-1.5 text-copy text-fg outline-none transition-colors hover:bg-fg/5 focus-visible:shadow-[0_0_0_2px_var(--ab-ring)]"
        >
          <Icon icon={ChevronLeft} size={15} className="shrink-0 text-muted" />
          Instructions
        </button>
        <span className="flex-1" />
        {busy ? <span role="status" className="text-note text-muted">Saving…</span> : null}
      </div>
      <MarkdownEditor
        value={draft}
        onChange={edit}
        label="Instructions"
        ariaLabel={`${bot.name}’s instructions`}
        accent={bot.color}
        lineNumbers={false}
        spellCheck
        placeholder="How it should work, what to avoid, who it works for. Plain language is fine."
        onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && (e.key === 'Enter' || e.key.toLowerCase() === 's')) { e.preventDefault(); flush(); } }}
        className="min-h-0 flex-1"
      />
    </div>
  );
}

export function BotPanel() {
  const bot = useStore(selectSelectedBot);
  const thread = useStore(selectSelectedThread);
  const accessMissing = useComputerAccessMissing();
  /** the bot whose instructions are open (the row's right arrow) */
  const [instructionsFor, setInstructionsFor] = useState<string | null>(null);
  if (!bot) return <EmptyState title="No bot" body="Pick a bot to see what it runs on." />;
  // the chat on screen, when it is this bot's
  const chat = thread?.botId === bot.id ? thread : undefined;
  const ctx = chat?.context;
  const pct = ctx ? Math.round(Math.min(1, ctx.used / ctx.size) * 100) : 0;
  const save = (patch: Parameters<typeof updateBot>[1]) => void updateBot(bot, patch, { errorTitle: 'Could not save bot' });
  // the Instructions row's own view (keyed by the bot, so another bot on screen starts on the list with its own text)
  if (instructionsFor === bot.id) return <Instructions key={bot.id} bot={bot} onBack={() => setInstructionsFor(null)} />;

  return (
    // room under the last row for the support bubble in the window's corner
    <div className="flex h-full flex-col gap-3 overflow-y-auto px-3.5 pt-1 pb-24">
      {/* a container: the model's row drops its effort and context size where the panel is narrow (ModelPicker).
          shrink-0 on every card: a card clips its content, so in a short window it would shrink instead of the tab scrolling */}
      <SettingsCard className="@container shrink-0">
        <Row label="Model">
          {chat
            // the chat's at once, and the bot's own from then on
            ? <ThreadModelPicker thread={chat} side="bottom" align="end" className={ROW_PICKER} onModel={(modelId) => save({ modelId })} />
            : <BotModel bot={bot} />}
        </Row>
        {chat ? (
          chat.modes.length > 1 ? (
            <Row label="Permissions">
              <ModePicker thread={chat} side="bottom" align="end" className={ROW_PICKER} onMode={(modeId) => save({ modeId })} />
            </Row>
          ) : null
        ) : (
          <Row label="Permissions">
            <PermissionPicker variant="chrome" side="bottom" align="end" className={ROW_PICKER} providerId={bot.providerId} value={bot.modeId ?? ''} onChange={(modeId) => save({ modeId })} />
          </Row>
        )}
        {COMPUTER_USE ? (
          <Row label="Computer use">
            <Switch checked={bot.computerUse} onChange={(v) => save({ computerUse: v })} label="Computer use" />
          </Row>
        ) : null}
        {/* macOS hasn't let AppuBot see and control the screen yet: a row like the others, its value the way to allow it */}
        {COMPUTER_USE && bot.computerUse && accessMissing ? (
          <Row label="Mac access">
            <button
              type="button"
              onClick={() => ui.openSettings('permissions', settingAnchorId(PERMISSIONS_TITLE))}
              aria-label="macOS hasn’t given AppuBot Accessibility and Screen Recording yet. Allow"
              className="ab-pill squircle -mr-2 inline-flex h-7 shrink-0 items-center gap-1.5 rounded-control-sm px-2 text-ui text-warning outline-none transition-colors hover:bg-fg/5 focus-visible:shadow-[0_0_0_2px_var(--ab-ring)]"
            >
              <Icon icon={AlertCircle} size={14} className="shrink-0" />
              Allow
              <Icon icon={ChevronRight} size={13} className="shrink-0 opacity-70" />
            </button>
          </Row>
        ) : null}
        {/* a chief may message every bot at once and leads the groups it is in */}
        <Row label="Chief">
          <Switch checked={!!bot.chief} onChange={(v) => save({ chief: v })} label="Chief: can message every bot and leads its groups" />
        </Row>
        <LoginsRow bot={bot} />
        <button
          type="button"
          onClick={() => ui.openApps()}
          className={cn(ROW, 'w-full text-left outline-none transition-colors hover:bg-fg/[.04] focus-visible:bg-fg/[.04]')}
        >
          <span className={ROW_LABEL}>Apps</span>
          <span className="flex-1" />
          <Icon icon={ChevronRight} size={15} className="shrink-0 text-muted" />
        </button>
        <button
          type="button"
          onClick={() => setInstructionsFor(bot.id)}
          className={cn(ROW, 'w-full text-left outline-none transition-colors hover:bg-fg/[.04] focus-visible:bg-fg/[.04]')}
        >
          <span className={ROW_LABEL}>Instructions</span>
          <span className="min-w-0 flex-1 truncate text-right text-ui text-muted">{bot.instructions?.trim() ? '' : 'None yet'}</span>
          <Icon icon={ChevronRight} size={15} className="shrink-0 text-muted" />
        </button>
        {ctx ? (
          <Row label="Context">
            <span className="text-ui tabular-nums text-muted">{pct}% full</span>
            <span className="-mr-1.5 inline-flex"><ContextRing thread={chat} bot={bot} /></span>
          </Row>
        ) : null}
      </SettingsCard>
    </div>
  );
}
