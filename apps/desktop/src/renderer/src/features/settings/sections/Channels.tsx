import { useState } from 'react';
import { ChevronDown, ExternalLink, KeyRound, Plus, Trash2, X } from '../../../components/ui/icons';
import type { Bot, Channel, MethodParams } from '@appubot/protocol';
import { Badge, BotAvatar, Button, Icon, Input, Switch, cn } from '../../../components/ui';
import { call, confirm } from '../../../lib/actions';
import { native } from '../../../lib/native';
import { useThisComputer } from '../../cloud/thisComputer';
import { byId, setState, upsertBy, useStore } from '../../../lib/store';
import { optimisticCall } from '../../../lib/optimistic';
import { TelegramMark } from '../brandLogos';
import { settingAnchorId } from '../nav';
import { SETTINGS_ROW, SETTINGS_ROW_DESCRIPTION, SETTINGS_ROW_TITLE, SettingsCard, SettingsGroup } from './shared';

/** Change a Telegram bot's setup: its switch and allowed users show at once (the token never shows, so it waits). */
async function configure(params: MethodParams<'channels.configure'>, success?: string): Promise<Channel | undefined> {
  if (params.token === undefined) {
    const { id, ...fields } = params;
    return optimisticCall('channels.configure', params, [{ kind: 'patch', coll: 'channels', id, fields }], {
      errorTitle: 'Could not update Telegram', answered: (c) => ({ coll: 'channels', entity: c }),
    });
  }
  const res = await call('channels.configure', params, { errorTitle: 'Could not update Telegram', success });
  if (res) setState((s) => ({ channels: upsertBy(s.channels, res, byId) }));
  return res;
}

function StatusBadge({ channel }: { channel: Channel }) {
  if (channel.status === 'running') return <Badge tone="success">Running</Badge>;
  if (channel.status === 'error') return <Badge tone="danger">Error</Badge>;
  if (!channel.botUsername) return <Badge tone="neutral">Not set up</Badge>;
  return <Badge tone="neutral">Stopped</Badge>;
}

function AllowedUsers({ channel, first }: { channel: Channel; first: boolean }) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  const add = async () => {
    const user = draft.trim().replace(/^@/, '');
    if (!user || channel.allowedUsers.includes(user)) { setDraft(''); return; }
    setBusy(true);
    const res = await configure({ id: channel.id, allowedUsers: [...channel.allowedUsers, user] });
    setBusy(false);
    if (res) setDraft('');
  };

  return (
    <div id={first ? settingAnchorId('Allowed users') : undefined} className={cn(SETTINGS_ROW, 'flex scroll-mt-24 flex-col gap-3')}>
      <div className="space-y-0.5">
        <h3 className={SETTINGS_ROW_TITLE}>Allowed users</h3>
        <p className={SETTINGS_ROW_DESCRIPTION}>
          Only these Telegram user IDs or usernames can talk to this bot. Pairing with a code adds you automatically.
        </p>
      </div>
      {channel.allowedUsers.length ? (
        <div className="flex flex-wrap gap-1.5">
          {channel.allowedUsers.map((u) => (
            <span key={u} className="ab-pill squircle inline-flex items-center gap-1 rounded-control-sm bg-surface-2 py-1 pr-1 pl-2.5 font-mono text-ui text-fg">
              {u}
              <button
                type="button"
                aria-label={`Remove ${u}`}
                className="ab-pill flex size-5 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-fg"
                onClick={() => void configure({ id: channel.id, allowedUsers: channel.allowedUsers.filter((x) => x !== u) })}
              >
                <Icon icon={X} size={12} />
              </button>
            </span>
          ))}
        </div>
      ) : (
        <p className="text-copy text-muted">Nobody yet.</p>
      )}
      <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <Input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="User ID or @username" className="max-w-72" spellCheck={false} />
        <Button type="submit" size="sm" variant="secondary" icon={Plus} loading={busy} disabled={!draft.trim()}>Add</Button>
      </form>
    </div>
  );
}

/** A bot not on Telegram yet: its card shows this until a token is saved. */
const NOT_CONNECTED: Channel = { id: '', enabled: false, status: 'stopped', allowedUsers: [] };

/**
 * One of your bots on Telegram: a header row (folded by default), its setup below when opened. A bot without a
 * Telegram bot yet gets one (`channels.add`) when its token is first saved.
 */
function TelegramCard({ bot: linkedBot, channel: linked, first, open, onToggle }: { bot: Bot; channel?: Channel; first: boolean; open: boolean; onToggle: () => void }) {
  const computer = useThisComputer();
  const channel = linked ?? NOT_CONNECTED;
  const [token, setToken] = useState('');
  const [saving, setSaving] = useState(false);
  const bodyId = `telegram-${linkedBot.id}`;

  const saveToken = async () => {
    if (!token.trim()) return;
    setSaving(true);
    let id = linked?.id;
    if (!id) {
      const made = await call('channels.add', { botId: linkedBot.id }, { errorTitle: 'Could not connect Telegram' });
      if (made) { setState((s) => ({ channels: upsertBy(s.channels, made, byId) })); id = made.id; }
    }
    // a new token starts the bot too: that is what saving it is for
    const res = id ? await configure({ id, token: token.trim(), ...(channel.botUsername ? {} : { enabled: true }) }, 'Telegram token saved') : undefined;
    setSaving(false);
    if (res) setToken('');
  };

  const remove = () =>
    confirm({
      title: channel.botUsername ? `Disconnect @${channel.botUsername}?` : `Disconnect ${linkedBot.name} from Telegram?`,
      body: 'AppuBot stops answering there and forgets its token. Its chats stay in your threads.',
      confirmLabel: 'Disconnect',
      danger: true,
      onConfirm: async () => {
        const res = await call('channels.remove', { id: channel.id }, { errorTitle: 'Could not remove the Telegram bot' });
        if (res) setState((s) => ({ channels: s.channels.filter((c) => c.id !== channel.id) }));
      },
    });

  return (
    <SettingsCard>
      <div id={first ? settingAnchorId('Telegram bot') : undefined} className={cn(SETTINGS_ROW, 'flex scroll-mt-24 items-center gap-3')}>
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={onToggle}
        >
          <span className="relative shrink-0">
            <TelegramMark />
            {linkedBot ? (
              <span className="absolute -right-1 -bottom-1 rounded-full bg-surface p-px">
                <BotAvatar bot={linkedBot} size={16} still />
              </span>
            ) : null}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className={cn(SETTINGS_ROW_TITLE, 'truncate')}>{linkedBot?.name ?? 'Telegram bot'}</span>
              <StatusBadge channel={channel} />
            </span>
            <span className={cn('mt-0.5 block truncate', SETTINGS_ROW_DESCRIPTION)}>
              {channel.botUsername ? `@${channel.botUsername}` : 'Not connected · add its Telegram token'}
            </span>
          </span>
          <Icon icon={ChevronDown} size={14} className={cn('shrink-0 text-muted transition-transform', open && 'rotate-180')} />
        </button>
        <Switch
          label={`Answer on Telegram as ${linkedBot?.name ?? 'this bot'}`}
          checked={channel.enabled}
          disabled={!channel.botUsername && !channel.enabled}
          onChange={(enabled) => { if (linked) void configure({ id: linked.id, enabled }); }}
        />
      </div>

      {channel.status === 'error' && channel.error ? (
        <div className="selectable bg-danger-soft px-3 py-2.5 text-copy leading-snug text-danger">{channel.error}</div>
      ) : null}

      {open ? (
        <div id={bodyId} className="contents">
          {channel.botUsername ? (
            <div className={cn(SETTINGS_ROW, 'flex items-center gap-2')}>
              <span className={cn('flex-1', SETTINGS_ROW_DESCRIPTION)}>Open the chat in Telegram</span>
              <button
                type="button"
                className="inline-flex items-center gap-1 text-copy text-link hover:underline"
                onClick={() => void native().openExternal(`https://t.me/${channel.botUsername}`)}
              >
                @{channel.botUsername}
                <Icon icon={ExternalLink} size={12} />
              </button>
            </div>
          ) : null}

          <div id={first ? settingAnchorId('Bot token') : undefined} className={cn(SETTINGS_ROW, 'scroll-mt-24')}>
            <form className="flex flex-col gap-1.5" onSubmit={(e) => { e.preventDefault(); void saveToken(); }}>
              <label htmlFor={`${bodyId}-token`} className={SETTINGS_ROW_TITLE}>Bot token</label>
              <div className="flex items-center gap-2">
                <Input
                  id={`${bodyId}-token`} type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" spellCheck={false}
                  placeholder={channel.botUsername ? 'Saved. Paste a new token to replace it' : '123456789:AA...'}
                  className="font-mono text-copy"
                  autoFocus={!channel.botUsername}
                />
                <Button type="submit" variant="primary" icon={KeyRound} loading={saving} disabled={!token.trim()}>Save</Button>
              </div>
              <span className={SETTINGS_ROW_DESCRIPTION}>
                Create a bot with <span className="font-mono">@BotFather</span> in Telegram (one per AppuBot bot) and paste its token here. It stays on {computer.name}.
              </span>
            </form>
          </div>

          {channel.pairingCode ? (
            <div className={cn(SETTINGS_ROW, 'flex items-center gap-5')}>
              <div className="min-w-0 flex-1 space-y-0.5">
                <h3 className={SETTINGS_ROW_TITLE}>Pair your Telegram account</h3>
                <div className={SETTINGS_ROW_DESCRIPTION}>
                  Send <span className="selectable font-mono text-fg-2">/pair {channel.pairingCode}</span> to {channel.botUsername ? `@${channel.botUsername}` : 'this bot'} to add yourself to its allowed users.
                </div>
              </div>
              <span className="selectable squircle rounded-control bg-surface-2 px-3.5 py-1.5 font-mono text-[20px] font-medium tracking-[0.25em] text-fg">
                {channel.pairingCode}
              </span>
            </div>
          ) : null}

          {linked ? <AllowedUsers channel={channel} first={first} /> : null}

          {linked ? (
            <div className={cn(SETTINGS_ROW, 'flex justify-end')}>
              <Button size="sm" variant="ghost" icon={Trash2} onClick={remove}>Disconnect</Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </SettingsCard>
  );
}

export function ChannelsSection() {
  const channels = useStore((s) => s.channels);
  const bots = useStore((s) => s.bots);
  // folded by default
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const toggle = (id: string) => setOpen((s) => { const n = new Set(s); if (!n.delete(id)) n.add(id); return n; });
  // every bot gets a card; its Telegram bot is the channel that answers as it (one without a pick answers as the first bot)
  const answersAs = (c: Channel) => (c.botId && bots.some((b) => b.id === c.botId) ? c.botId : bots[0]?.id);
  const channelOf = (botId: string) => channels.find((c) => answersAs(c) === botId);

  return (
    <div className="space-y-6">
      <SettingsGroup
        title="Telegram"
        description="Give each of your bots its own Telegram handle: make one with @BotFather and paste its token on that bot's card."
        bare
      >
        {bots.length ? (
          <div className="flex flex-col gap-2">
            {bots.map((b, i) => <TelegramCard key={b.id} bot={b} channel={channelOf(b.id)} first={i === 0} open={open.has(b.id)} onToggle={() => toggle(b.id)} />)}
          </div>
        ) : (
          <SettingsCard>
            <div id={settingAnchorId('Telegram bot')} className={cn(SETTINGS_ROW, 'flex scroll-mt-24 items-center gap-3')}>
              <TelegramMark />
              <div className="min-w-0 flex-1">
                <h3 className={SETTINGS_ROW_TITLE}>No bots yet</h3>
                <p className={SETTINGS_ROW_DESCRIPTION}>Each bot you make gets a card here to connect it to Telegram.</p>
              </div>
            </div>
          </SettingsCard>
        )}
      </SettingsGroup>
    </div>
  );
}
