// Settings › Instructions: instructions for every bot on this computer (`settings.globalInstructions`). They
// go into each bot's generated CLAUDE.md/AGENTS.md before the bot's own, so a bot's own can refine them; saving
// regenerates every bot's file and its agents pick the change up at their next turn (the core's BotsService).
// Drawn in the code view's card like every Markdown field (components/ui MarkdownEditor), the count and the buttons
// in the card's footer row.
import { useEffect, useRef, useState } from 'react';
import { GLOBAL_INSTRUCTIONS_MAX } from '@appubot/protocol';
import { Button, MarkdownEditor } from '../../../components/ui';
import { useStore } from '../../../lib/store';
import { useT } from '../../../lib/i18n';
import { SectionLoading, SettingsGroup, updateSettings } from './shared';

export { GLOBAL_INSTRUCTIONS_MAX };

export function InstructionsSection() {
  const t = useT();
  const saved = useStore((s) => s.settings?.globalInstructions);
  const [draft, setDraft] = useState(saved ?? '');
  const [busy, setBusy] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const dirty = draft !== (saved ?? '');
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  // another device saved (or the computer's copy arrived): take it unless the user is mid-edit
  useEffect(() => { if (!dirtyRef.current) setDraft(saved ?? ''); }, [saved]);
  if (saved === undefined) return <SectionLoading />;

  const save = async () => {
    setBusy(true);
    // a refusal is toasted and rolled back by updateSettings itself
    const ok = !!(await updateSettings({ globalInstructions: draft.trim() }));
    setBusy(false);
    if (ok) { setJustSaved(true); setTimeout(() => setJustSaved(false), 2000); }
  };

  return (
    <div className="space-y-6">
      <SettingsGroup title={t('instructions.title')} description={t('instructions.desc')} bare>
        <MarkdownEditor
          value={draft}
          onChange={setDraft}
          maxLength={GLOBAL_INSTRUCTIONS_MAX}
          label={t('instructions.title')}
          ariaLabel={t('instructions.title')}
          placeholder={t('instructions.placeholder')}
          lineNumbers={false}
          spellCheck
          onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && dirty && !busy) { e.preventDefault(); void save(); } }}
          className="max-h-[32rem] min-h-[15rem]"
          footer={(
            <div className="flex shrink-0 items-center gap-2 border-t border-(--cb-border) px-3.5 py-2">
              <span className="text-note tabular-nums text-muted">{t('instructions.count', { count: draft.length })}</span>
              {justSaved && !dirty ? <span role="status" className="text-note text-muted">· {t('instructions.saved')}</span> : null}
              <span className="flex-1" />
              {dirty ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => setDraft(saved)}>{t('instructions.revert')}</Button> : null}
              <Button size="sm" variant="primary" disabled={!dirty} loading={busy} onClick={() => void save()}>{t('instructions.save')}</Button>
            </div>
          )}
        />
      </SettingsGroup>
    </div>
  );
}
