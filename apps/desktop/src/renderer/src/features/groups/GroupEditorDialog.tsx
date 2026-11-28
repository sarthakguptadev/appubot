// New / edit group (features/groups): its name, which bots are in it (a checklist with their avatars; chiefs marked)
// and who leads it: a chief member (the user's messages go to the lead, who hands work out with @Name), or nobody
// (every member answers the user). Settings' cards: the name, a switch per bot, the lead as a row with its menu.
import { useEffect, useState, type FormEvent } from 'react';
import { CHIEF_BADGE } from '@appubot/chat-core';
import { ChevronDown, Star } from '../../components/ui/icons';
import { BotAvatar, Button, CardRow, CardSection, Dialog, FIELD_HINT, Icon, Menu, SettingsCard, Switch, cn } from '../../components/ui';
import { useStore } from '../../lib/store';
import { createGroup, updateGroup } from './groups';

export function GroupEditorDialog({ open, onClose, groupId, withBotId }: { open: boolean; onClose: () => void; groupId?: string; withBotId?: string }) {
  const group = useStore((s) => (groupId ? s.groups.find((g) => g.id === groupId) : undefined));
  const bots = useStore((s) => s.bots);
  const [name, setName] = useState('');
  const [botIds, setBotIds] = useState<string[]>([]);
  const [leadId, setLeadId] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!open) return;
    setName(group?.name ?? '');
    // made from a bot's menu: that bot to start with, the others picked here
    setBotIds(group?.botIds ?? (withBotId && bots.some((b) => b.id === withBotId) ? [withBotId] : bots.slice(0, Math.min(3, bots.length)).map((b) => b.id)));
    setLeadId(group?.leadId ?? '');
  }, [open, group?.id, withBotId]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (id: string) => setBotIds((l) => (l.includes(id) ? l.filter((x) => x !== id) : [...l, id]));
  const members = botIds.map((id) => bots.find((b) => b.id === id)).filter((b): b is NonNullable<typeof b> => !!b);
  const firstChief = members.find((b) => b.chief);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !botIds.length) return;
    setSaving(true);
    const lead = leadId && botIds.includes(leadId) ? leadId : '';
    const r = group ? await updateGroup(group.id, { name: name.trim(), botIds, leadId: lead }) : await createGroup({ name: name.trim(), botIds, ...(lead ? { leadId: lead } : {}) });
    setSaving(false);
    if (r) onClose();
  };
  const leadBot = members.find((b) => b.id === leadId);
  const leadLabel = leadBot ? leadBot.name : firstChief ? firstChief.name : 'Nobody';
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="md"
      title={group ? 'Edit group' : 'New group'}
      description="Bots that talk with each other to get work done."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="group-editor" loading={saving} disabled={!name.trim() || !botIds.length}>{group ? 'Save' : 'Make group'}</Button>
        </>
      }
    >
      <form id="group-editor" onSubmit={(e) => void submit(e)} className="flex flex-col gap-5">
        <CardSection title="Name">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Launch team"
            aria-label="Name"
            autoFocus
            data-autofocus
            maxLength={80}
            className="block w-full bg-transparent px-4 py-3 text-copy text-fg outline-none placeholder:text-muted/60"
          />
        </CardSection>
        <CardSection title="Bots" action={bots.length ? <span className="text-note text-muted tabular-nums">{botIds.length} of {bots.length}</span> : null}>
          {bots.length ? bots.map((b) => {
            const on = botIds.includes(b.id);
            return (
              <div key={b.id} onClick={() => toggle(b.id)} className="flex cursor-default items-center gap-3 px-4 py-2.5 hover:bg-fg/[.025]">
                <BotAvatar bot={b} size={26} still />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex items-center gap-1.5 text-copy font-medium text-fg">
                    {b.name}
                    {b.chief ? <span className="inline-flex items-center gap-0.5 text-[11px] font-normal text-muted"><span className="inline-flex" style={{ color: CHIEF_BADGE.gold }}><Icon icon={Star} size={11} /></span>Chief</span> : null}
                  </span>
                  {b.job ? <span className="truncate text-note text-muted">{b.job}</span> : null}
                </span>
                <span onClick={(e) => e.stopPropagation()}><Switch checked={on} onChange={() => toggle(b.id)} label={`${b.name} in the group`} /></span>
              </div>
            );
          }) : <div className={cn('px-4 py-3', FIELD_HINT)}>Make a bot or two first.</div>}
        </CardSection>
        <SettingsCard>
          <CardRow title="Lead">
            <Menu
              align="end"
              trigger={(p) => (
                <button {...p} type="button" aria-label={`Lead: ${leadLabel}`} className="flex h-8 items-center gap-1.5 ab-pill squircle rounded-control px-2 text-copy text-fg hover:bg-fg/5 aria-expanded:bg-fg/5">
                  {leadBot ?? firstChief ? <BotAvatar bot={(leadBot ?? firstChief)!} size={18} still /> : null}
                  <span className="max-w-[12rem] truncate">{leadLabel}</span>
                  <Icon icon={ChevronDown} size={13} className="text-muted" />
                </button>
              )}
              items={[
                { label: firstChief ? `${firstChief.name} (first chief)` : 'Nobody', current: !leadBot, hint: !leadBot ? '✓' : undefined, onSelect: () => setLeadId('') },
                ...members.map((b) => ({ label: b.name, leading: <BotAvatar bot={b} size={16} still />, current: leadBot?.id === b.id, hint: leadBot?.id === b.id ? '✓' : undefined, onSelect: () => setLeadId(b.id) })),
              ]}
            />
          </CardRow>
        </SettingsCard>
      </form>
    </Dialog>
  );
}
