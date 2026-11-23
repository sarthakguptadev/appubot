import { useEffect, useState } from 'react';
import type { Skill } from '@appubot/protocol';
import { Trash2 } from '../../components/ui/icons';
import { Badge, Button, Dialog, Field, Input, MarkdownEditor, Spinner } from '../../components/ui';
import { call, confirm } from '../../lib/actions';
import { setState, upsertBy } from '../../lib/store';
import { skillKey } from './SkillsPanel';

export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;

const TEMPLATE = `## When to use
Describe the situation where this skill applies.

## Steps
1. First step
2. Second step
3. Check the result

## Notes
- Anything to watch out for
`;

/** View / edit a skill's SKILL.md (or write a new one). */
export function SkillDialog({ open, onClose, botId, name }: { open: boolean; onClose: () => void; botId: string; name?: string }) {
  const isNew = !name;
  const [skill, setSkill] = useState<Skill | null>(null);
  const [skillName, setSkillName] = useState('');
  const [description, setDescription] = useState('');
  const [body, setBody] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setTouched(false);
    setSaving(false);
    setSkill(null);
    if (!name) {
      setSkillName('');
      setDescription('');
      setBody(TEMPLATE);
      setLoading(false);
      return;
    }
    setSkillName(name);
    setDescription('');
    setBody('');
    setLoading(true);
    void call('skills.get', { botId, name }, { errorTitle: 'Could not load skill' }).then((k) => {
      if (!alive) return;
      setLoading(false);
      if (!k) return;
      setSkill(k);
      setDescription(k.description);
      setBody(k.body ?? '');
    });
    return () => { alive = false; };
  }, [open, botId, name]);

  const trimmedName = skillName.trim();
  const nameValid = SKILL_NAME_RE.test(trimmedName);
  const showNameError = isNew && touched && trimmedName.length > 0 && !nameValid;
  const canSave = nameValid && body.trim().length > 0 && !loading;

  const save = async () => {
    setTouched(true);
    if (!canSave || saving) return;
    setSaving(true);
    const saved = await call(
      'skills.save',
      { botId, name: trimmedName, description: description.trim(), body },
      { errorTitle: 'Could not save skill', success: isNew ? 'Skill created' : 'Skill saved' },
    );
    setSaving(false);
    if (!saved) return;
    setState((s) => ({ skills: upsertBy(s.skills, saved, skillKey) }));
    onClose();
  };

  const remove = () => {
    if (!name) return;
    confirm({
      title: `Delete “${name}”?`,
      body: 'The SKILL.md file will be removed. Your bot will no longer know these steps.',
      confirmLabel: 'Delete skill',
      danger: true,
      onConfirm: async () => {
        const res = await call('skills.delete', { botId, name }, { errorTitle: 'Could not delete skill' });
        if (!res) return;
        setState((s) => ({ skills: s.skills.filter((k) => !(k.name === name && (k.botId ?? '') === botId)) }));
        onClose();
      },
    });
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={
        isNew ? 'New skill' : (
          <span className="flex items-center gap-2">
            <span className="font-mono text-[18px]">{name}</span>
            {skill?.source === 'taught' ? <Badge tone="accent">Taught</Badge> : skill?.source === 'bundled' ? <Badge>Built-in</Badge> : null}
          </span>
        )
      }
      description={isNew ? 'A skill is a Markdown playbook your bot follows when the task comes up.' : skill?.path ? <span className="font-mono text-note select-text">{skill.path}</span> : undefined}
      footer={
        <>
          {!isNew && skill?.source !== 'bundled' ? (
            <Button variant="danger" icon={Trash2} onClick={remove} className="mr-auto" disabled={loading}>Delete</Button>
          ) : null}
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={saving} disabled={!canSave} onClick={() => void save()}>
            {isNew ? 'Create skill' : 'Save'}
          </Button>
        </>
      }
    >
      {loading ? (
        <div className="flex h-64 items-center justify-center text-muted"><Spinner size={20} /></div>
      ) : (
        <div className="flex flex-col gap-4">
          {isNew ? (
            <Field
              label="Name"
              hint={showNameError
                ? <span className="text-danger">Use 2–41 lowercase letters, numbers and dashes, starting with a letter or number.</span>
                : 'Lowercase with dashes, e.g. file-monthly-invoices.'}
            >
              <Input
                autoFocus
                data-autofocus
                value={skillName}
                onChange={(e) => setSkillName(e.target.value.toLowerCase().replace(/\s+/g, '-'))}
                onBlur={() => setTouched(true)}
                placeholder="file-monthly-invoices"
                className="font-mono text-copy"
                aria-invalid={showNameError}
                maxLength={41}
              />
            </Field>
          ) : null}
          <Field label="Description" hint="One sentence. Your bot reads this to decide when the skill applies.">
            <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Download this month's invoices and file them by vendor." />
          </Field>
          <MarkdownEditor
            value={body}
            onChange={setBody}
            label="SKILL.md"
            ariaLabel="SKILL.md"
            className="max-h-[480px] min-h-[320px]"
          />
        </div>
      )}
    </Dialog>
  );
}
