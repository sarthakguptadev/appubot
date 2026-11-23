// Settings › Voice, for people: the model that hears you (picked from "All speech models", which downloads it), the
// language it expects where it takes one, the model that reads replies and its voice (with a sample), Telegram voice
// replies, and a folded Storage list of what's downloaded.
import { useEffect, useId, useState } from 'react';
import {
  ASR_LEADERBOARD, findVoiceModel, voiceFor,
  type Settings, type VoiceModelId, type VoiceModelStatus,
} from '@appubot/protocol';
import { languageChoices, othersLabel, pickVoiceModel, pickedModel, shownLanguage, voiceModelFacts, voiceModelRows, voiceModelSize, type VoiceKind, type VoiceModelRow } from '@appubot/chat-core';
import { Badge, Button, Icon, Select, Spinner, Switch, cn } from '../../../components/ui';
import { ChevronLeft, ChevronRight, Download, Play, Square } from '../../../components/ui/icons';
import { call } from '../../../lib/actions';
import { native } from '../../../lib/native';
import { THIS_MACHINE } from '../../../lib/platform';
import { pushToast, selectSelectedBot, setState, useStore } from '../../../lib/store';
import { percent } from '../../voice/models';
import { readingLanguage, speaker, useReading } from '../../voice/speech';
import { ALL_SPEECH_MODELS_TITLE, ALL_VOICE_MODELS_TITLE, SPEECH_MODEL_TITLE, SPEECH_VOICE_TITLE, TELEGRAM_VOICE_TITLE, VOICE_MODEL_TITLE, VOICE_STORAGE_TITLE, WHICH_LANGUAGE_TITLE } from '../nav';
import { storedLabel, storedModels } from '../voiceChoices';
import {
  SETTINGS_ROW, SETTINGS_ROW_DESCRIPTION, SETTINGS_ROW_TITLE, SectionLoading, SettingRow, SettingsCard, SettingsEmptyState,
  SettingsGroup, updateSettings,
} from './shared';

type VoiceSettings = Settings['voice'];

const PREVIEW = 'preview';

function updateVoice(current: VoiceSettings, patch: Partial<VoiceSettings>): void {
  void updateSettings({ voice: { ...current, ...patch } });
}

async function act(method: 'voice.models.download' | 'voice.models.cancel' | 'voice.models.remove', id: VoiceModelId, errorTitle: string): Promise<void> {
  const st = await call(method, { id }, { errorTitle });
  if (st) setState({ voice: st });
}

const download = (id: VoiceModelId) => act('voice.models.download', id, 'Couldn’t download it');

function languageName(code: string): string {
  try { return new Intl.DisplayNames([navigator.language || 'en'], { type: 'language' }).of(code) ?? code; } catch { return code; }
}

/** a model's download under its row: progress + Cancel, the error + Retry, or what it still needs */
function DownloadLine({ m, missing }: { m: VoiceModelStatus | undefined; missing?: string }) {
  if (!m || m.phase === 'ready') return null;
  const line = 'mt-1.5 flex items-center gap-2 text-note';
  if (m.phase === 'downloading') {
    const p = m.progress ?? 0;
    return (
      <span className={line}>
        <span className="shrink-0 text-muted tabular-nums">Downloading… {percent(p)}</span>
        <span className="h-1 w-full max-w-40 overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-label="Download" aria-valuenow={Math.round(p * 100)} aria-valuemin={0} aria-valuemax={100}>
          <span className="block h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: percent(p) }} />
        </span>
        <button type="button" className="shrink-0 text-muted underline-offset-2 hover:text-fg hover:underline" onClick={() => void act('voice.models.cancel', m.id, 'Couldn’t cancel the download')}>Cancel</button>
      </span>
    );
  }
  if (m.phase === 'error') {
    return (
      <span className={line}>
        <span className="min-w-0 text-danger">{m.message ?? 'The download failed.'}</span>
        <button type="button" className="shrink-0 font-medium text-fg underline-offset-2 hover:underline" onClick={() => void download(m.id)}>Retry</button>
      </span>
    );
  }
  if (!missing) return null;
  return (
    <span className={line}>
      <span className="text-muted">{missing} · {voiceModelSize(m.bytes)}</span>
      <button type="button" className="shrink-0 font-medium text-fg underline-offset-2 hover:underline" onClick={() => void download(m.id)}>Download now</button>
    </span>
  );
}

/** Plays a sample sentence in the chosen voice. */
function ListenButton({ botName }: { botName: string }) {
  const playing = useReading((r) => r.owner === PREVIEW);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    const off = speaker.on({
      start: (o) => { if (o === PREVIEW) setLoading(false); },
      idle: (o) => { if (o === PREVIEW) setLoading(false); },
      error: (o, message) => { if (o === PREVIEW) pushToast({ title: 'Couldn’t play the sample', body: message, level: 'error' }); },
    });
    return () => { off(); speaker.stop(PREVIEW); };
  }, []);
  if (playing || loading) {
    return (
      <Button size="sm" variant="ghost" icon={playing ? Square : undefined} onClick={() => { speaker.stop(PREVIEW); setLoading(false); }}>
        {loading ? <Spinner size={12} /> : null}Stop
      </Button>
    );
  }
  return (
    <Button
      size="sm" variant="ghost" icon={Play}
      onClick={() => {
        const line = `Hi, I'm ${botName}. This is how I sound.`;
        speaker.stop(PREVIEW);
        setLoading(true);
        speaker.enqueue(PREVIEW, line, readingLanguage(line));
      }}
    >
      Listen
    </Button>
  );
}

/** Who made the model a row uses and its license (CC BY asks for the credit), linked to its model card. */
function ModelCredit({ id }: { id: VoiceModelId }) {
  const m = findVoiceModel(id);
  if (!m?.credit.by) return null;
  return (
    <span className="block text-note text-muted">
      {m.name} by {m.credit.by}{m.credit.note ? ` (${m.credit.note})` : ''} ·{' '}
      <button type="button" className="text-link hover:underline" onClick={() => void native().openExternal(m.credit.url)}>{m.credit.license}</button>
    </span>
  );
}

/** What picking a model does: saved at once, and downloaded when it isn't here yet. */
function pick(kind: VoiceKind, m: VoiceModelStatus, v: VoiceSettings): void {
  updateVoice(v, pickVoiceModel(kind, m.id, v));
  if (m.phase === 'missing' || m.phase === 'error') void download(m.id);
}

/** A row's right side: In use, its download (size), how far it is, or Use for one already here (the picked one too, while another stands in). */
function RowAction({ row, onPick }: { row: VoiceModelRow; onPick: () => void }) {
  const m = row.status;
  // its progress and Cancel are under its facts
  if (m.phase === 'downloading') return <span className="text-ui text-muted tabular-nums">{percent(m.progress ?? 0)}</span>;
  if (row.inUse) {
    return <span className="inline-flex items-center gap-1.5 text-ui font-medium text-accent-strong"><span className="size-1.5 rounded-full bg-current" />In use</span>;
  }
  if (m.phase === 'ready') return <Button size="xs" variant="secondary" onClick={(e) => { e.stopPropagation(); onPick(); }}>Use</Button>;
  return (
    <Button size="xs" variant="secondary" icon={Download} aria-label={`Download ${row.info.name}, ${voiceModelSize(m.bytes)}`} onClick={(e) => { e.stopPropagation(); onPick(); }}>
      {voiceModelSize(m.bytes)}
    </Button>
  );
}

/** One model: name and tag, what it's for, its facts, and its download's progress or error under them. */
function ModelRowView({ row, onPick }: { row: VoiceModelRow; onPick: () => void }) {
  const { info, status: m } = row;
  return (
    <div
      role="button"
      tabIndex={0}
      aria-current={row.picked ? 'true' : undefined}
      onClick={onPick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(); } }}
      className={cn(SETTINGS_ROW, 'flex cursor-default items-start gap-4 outline-none transition-colors hover:bg-[color-mix(in_srgb,var(--ab-fg)_3%,transparent)] focus-visible:shadow-[inset_0_0_0_2px_var(--ab-ring)]')}
    >
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex min-h-5 flex-wrap items-center gap-2">
          <span className={SETTINGS_ROW_TITLE}>{info.name}</span>
          {info.tag ? <Badge tone={info.tag === 'Recommended' ? 'accent' : 'neutral'}>{info.tag}</Badge> : null}
        </div>
        {info.about ? <p className={SETTINGS_ROW_DESCRIPTION}>{info.about}</p> : null}
        <p className="text-note text-muted tabular-nums">{voiceModelFacts(info, m.bytes)}</p>
        {m.phase === 'downloading' || m.phase === 'error' ? <DownloadLine m={m} /> : null}
      </div>
      <div className="flex min-h-5 shrink-0 items-center">
        <RowAction row={row} onPick={onPick} />
      </div>
    </div>
  );
}

/** "All speech models" / "All voices": every model of a kind, the ones that don't speak English folded at the end. */
function ModelList({ kind, models, v, onBack }: { kind: VoiceKind; models: VoiceModelStatus[]; v: VoiceSettings; onBack: () => void }) {
  const [more, setMore] = useState(false);
  const moreId = useId();
  const { rows, others } = voiceModelRows(kind, models, v);
  const title = kind === 'stt' ? ALL_SPEECH_MODELS_TITLE : ALL_VOICE_MODELS_TITLE;
  const view = (r: VoiceModelRow) => <ModelRowView key={r.info.id} row={r} onPick={() => pick(kind, r.status, v)} />;
  return (
    <div className="space-y-4">
      <div className="-ml-2 flex items-center gap-1">
        <Button size="icon-sm" variant="ghost" icon={ChevronLeft} aria-label="Back to Voice" onClick={onBack} />
        <h2 className="text-title font-semibold text-fg">{title}</h2>
      </div>
      <SettingsCard>
        {rows.map(view)}
        {others.length ? (
          <>
            <button
              type="button"
              aria-expanded={more}
              aria-controls={moreId}
              onClick={() => setMore((o) => !o)}
              className={cn(SETTINGS_ROW, 'flex w-full items-center gap-2 text-left text-copy text-fg-2 outline-none transition-colors hover:bg-[color-mix(in_srgb,var(--ab-fg)_3%,transparent)] focus-visible:shadow-[inset_0_0_0_2px_var(--ab-ring)]')}
            >
              <span className="flex-1">{othersLabel(others.length)}</span>
              <Icon icon={ChevronRight} size={14} className={cn('shrink-0 text-muted transition-transform duration-150', more && 'rotate-90')} />
            </button>
            {more ? <div id={moreId} className="contents">{others.map(view)}</div> : null}
          </>
        ) : null}
      </SettingsCard>
      {kind === 'stt' ? (
        <p className="text-note leading-normal text-muted">
          Wrong words: the{' '}
          <button type="button" className="text-link hover:underline" onClick={() => void native().openExternal(ASR_LEADERBOARD.url)}>Open ASR Leaderboard</button>
          ’s English average, {new Date(`${ASR_LEADERBOARD.asOf}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })}. Wait: measured on a Mac with Apple silicon.
          Everything runs on {THIS_MACHINE}; nothing you say leaves it.
        </p>
      ) : null}
    </div>
  );
}

/** What's downloaded, folded: one quiet line each with its size and Remove. */
function Storage({ models }: { models: VoiceModelStatus[] }) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const { models: stored, bytes } = storedModels(models);
  if (!stored.length) return null;
  return (
    <SettingsGroup title={VOICE_STORAGE_TITLE} bare>
      <SettingsCard>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((o) => !o)}
          // the focus ring sits inside the button: an outline outside it would be clipped by the card into a stray line
          className={cn(SETTINGS_ROW, 'flex w-full items-center gap-2 text-left outline-none transition-colors hover:bg-[color-mix(in_srgb,var(--ab-fg)_3%,transparent)] focus-visible:shadow-[inset_0_0_0_2px_var(--ab-ring)]')}
        >
          <span className={cn('flex-1', SETTINGS_ROW_TITLE)}>
            Voice files <span className="font-normal text-muted">· {voiceModelSize(bytes)}</span>
          </span>
          <Icon icon={ChevronRight} size={14} className={cn('shrink-0 text-muted transition-transform duration-150', open && 'rotate-90')} />
        </button>
        {open ? (
          <div id={bodyId} className="contents">
            {stored.map((m) => (
              <div key={m.id} className="flex items-center gap-2 px-4 py-1.5 text-copy">
                <span className="min-w-0 flex-1 truncate text-fg-2">{storedLabel(m)}</span>
                <span className="text-note text-muted tabular-nums">{voiceModelSize(m.bytes)}</span>
                <Button size="xs" variant="ghost" className="text-muted" onClick={() => void act('voice.models.remove', m.id, 'Couldn’t remove it')}>Remove</Button>
              </div>
            ))}
          </div>
        ) : null}
      </SettingsCard>
    </SettingsGroup>
  );
}

export function VoiceSection() {
  const settings = useStore((s) => s.settings);
  const status = useStore((s) => s.voice);
  const botName = useStore((s) => selectSelectedBot(s)?.name ?? s.bots[0]?.name ?? 'Appu');
  const [browsing, setBrowsing] = useState<VoiceKind | null>(null);

  // the models' state may have moved while this window wasn't listening (a download that ended)
  useEffect(() => { void call('voice.status').then((st) => { if (st) setState({ voice: st }); }); }, []);

  if (!settings) return <SectionLoading />;
  // a computer that reads aloud but hears nothing (your AppuBot computer): its voice alone is here
  const speaksOnly = !!status && !status.supported && !!status.speaks;
  if (!status || (!status.supported && !speaksOnly)) {
    return (
      <SettingsGroup bare>
        <SettingsEmptyState>{status?.reason ?? (status ? `Speech can’t run on ${THIS_MACHINE}.` : 'Voice needs a newer version of AppuBot.')}</SettingsEmptyState>
      </SettingsGroup>
    );
  }
  const v = settings.voice;
  if (browsing) return <ModelList kind={browsing} models={status.models} v={v} onBack={() => setBrowsing(null)} />;

  const byId = new Map(status.models.map((m) => [m.id as string, m]));
  const sttId = pickedModel('stt', v);
  const ttsId = pickedModel('tts', v);
  const hearing = byId.get(sttId);
  const voiceModel = byId.get(ttsId);
  const sttInfo = findVoiceModel(sttId);
  const ttsInfo = findVoiceModel(ttsId);
  const languages = languageChoices(sttId);
  const shown = shownLanguage(v);
  const voices = ttsInfo?.voices ?? [];
  const voice = voiceFor(ttsId, v.voice);
  const picker = (kind: VoiceKind, name: string | undefined, label: string) => (
    <Button size="sm" variant="secondary" iconRight={ChevronRight} aria-label={`${label}: ${name ?? ''}`} onClick={() => setBrowsing(kind)}>
      {name ?? 'Choose'}
    </Button>
  );

  return (
    <div className="space-y-6">
      <SettingsGroup title="Speech" description={speaksOnly ? 'This computer reads replies aloud. In voice mode, your words are heard on the device you talk on.' : undefined}>
        {speaksOnly ? null : <SettingRow
          title={SPEECH_MODEL_TITLE}
          description={<>
            <span className="block">Bots hear you on {THIS_MACHINE}. Nothing you say leaves it.</span>
            <DownloadLine m={hearing} missing="Downloads the first time you talk" />
            <ModelCredit id={sttId as VoiceModelId} />
          </>}
        >
          {picker('stt', sttInfo?.name ?? hearing?.name, SPEECH_MODEL_TITLE)}
        </SettingRow>}
        {languages.length && !speaksOnly ? (
          <SettingRow title={WHICH_LANGUAGE_TITLE} description={languages[0] === 'auto' ? 'Automatic works it out each time you talk.' : `${sttInfo?.name ?? 'This model'} needs to know which one you speak.`}>
            <Select aria-label={WHICH_LANGUAGE_TITLE} fit value={shown} onChange={(e) => updateVoice(v, { language: e.target.value })}>
              {languages.map((code) => ({ code, name: code === 'auto' ? 'Automatic' : languageName(code) }))
                .sort((a, b) => (a.code === 'auto' ? -1 : b.code === 'auto' ? 1 : a.name.localeCompare(b.name)))
                .map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
            </Select>
          </SettingRow>
        ) : null}

        <SettingRow
          title={VOICE_MODEL_TITLE}
          description={<>
            <span className="block">What reads your bots’ replies aloud.</span>
            <DownloadLine m={voiceModel} missing="Downloads the first time a bot talks" />
            <ModelCredit id={ttsId as VoiceModelId} />
          </>}
        >
          {picker('tts', ttsInfo?.name ?? voiceModel?.name, VOICE_MODEL_TITLE)}
        </SettingRow>
        <SettingRow title={SPEECH_VOICE_TITLE} description="How your bots sound when they talk back.">
          {!voiceModel || voiceModel.phase === 'ready' ? (
            <>
              <ListenButton botName={botName} />
              <Select aria-label={SPEECH_VOICE_TITLE} fit value={voice} onChange={(e) => updateVoice(v, { voice: e.target.value })}>
                {voices.map((x) => <option key={x.id} value={x.id}>{x.about ? `${x.name} (${x.about})` : x.name}</option>)}
              </Select>
            </>
          ) : voiceModel.phase === 'missing' ? (
            <Button size="sm" variant="secondary" icon={Download} onClick={() => void download(voiceModel.id)}>
              Download voice ({voiceModelSize(voiceModel.bytes)})
            </Button>
          ) : null}
        </SettingRow>

        {/* a voice message has to be heard before it can be answered: only where the computer hears */}
        {speaksOnly ? null : <SettingRow title={TELEGRAM_VOICE_TITLE} description="When you send a bot a voice message on Telegram, it answers with one too. The text always comes along.">
          <Switch label={TELEGRAM_VOICE_TITLE} checked={v.telegramVoiceReplies} onChange={(telegramVoiceReplies) => updateVoice(v, { telegramVoiceReplies })} />
        </SettingRow>}
      </SettingsGroup>

      <Storage models={status.models} />
    </div>
  );
}
