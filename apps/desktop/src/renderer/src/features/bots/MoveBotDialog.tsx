/**
 * Move a bot between this Mac and your AppuBot computer (either way, and to a team's). The computer it's on packs
 * it (`bots.export`: its setup, memory, skills, files, routines and chats; no secret), this window carries the bundle
 * over (the Mac's gateway on one side, the cloud's end-to-end channel on the other: nothing passes AppuBot's
 * servers) and the other computer unpacks it (`bots.import`). A move then removes it here; "Keep a copy here" makes
 * it a copy. Logins, the Vault, connected apps and Telegram never travel: the result lists what to set up again.
 * A bundle bigger than the other computer takes at once (`SystemInfo.transfer`, `transferLimit`) isn't sent: the
 * dialog says so in words (a move can't leave its chats behind; Settings › Transfer can, as a copy).
 */
import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { GatewayClient, uploadFile } from '@appubot/client';
import { transferLimit, type Bot, type BotImportResult } from '@appubot/protocol';
import { bytes } from '@appubot/chat-core';
import { sizeRefusalText } from '../transfer/transferPlan';
import { AlertTriangle, ArrowRight, CircleCheck, Laptop, Monitor } from '../../components/ui/icons';
import { Button, Dialog, Icon, Spinner, Switch } from '../../components/ui';
import { activeComputer, errorMessage, localGateway, type GatewayLike } from '../../lib/gateway';
import { THIS_MACHINE } from '../../lib/platform';
import { pushToast, setState, ui, useStore } from '../../lib/store';
import { useCloud } from '../cloud/cloudAccount';
import { cloudClientReady, cloudFileBlob, switchComputer, useCloudLink } from '../cloud/cloudClient';

/** a computer a bot can live on: this Mac, the person's own AppuBot computer, or a team's */
export type ComputerKey = 'local' | 'cloud' | `cloud:${string}`;

export const useMoveBot = create<{ bot: Bot | null; from: ComputerKey }>()(() => ({ bot: null, from: 'local' }));
export function openMoveBot(bot: Bot): void {
  const team = useCloudLink.getState().team;
  const from: ComputerKey = activeComputer() === 'cloud' ? (team ? `cloud:${team}` : 'cloud') : 'local';
  useMoveBot.setState({ bot, from });
}

export interface MoveTarget { key: ComputerKey; label: string; team?: string }

/** Every computer a bot could move to from `from`: this Mac, your AppuBot computer (once paired or bought), each team's. */
export function moveTargets(from: ComputerKey, view: { paired?: boolean; computer?: { state?: string } | null; teams?: { team: { id: string; name: string }; paired?: boolean }[] } | null | undefined): MoveTarget[] {
  // moving is one way: a bot on an AppuBot computer goes only to another one, never back to this Mac (as Transfer)
  const out: MoveTarget[] = from === 'local' ? [{ key: 'local', label: `${THIS_MACHINE[0]!.toUpperCase()}${THIS_MACHINE.slice(1)}` }] : [];
  if (view && (view.paired || (view.computer?.state && view.computer.state !== 'none' && view.computer.state !== 'deleted'))) out.push({ key: 'cloud', label: 'Your AppuBot computer' });
  for (const t of view?.teams ?? []) out.push({ key: `cloud:${t.team.id}`, label: `${t.team.name}’s AppuBot computer`, team: t.team.id });
  return out.filter((t) => t.key !== from);
}

const WHAT_MOVES = ['Its setup: name, look, job, instructions, agent and model', 'Its memory, skills and the files in its folder', 'Its routines', 'Its chats and the files in them'];
const WHAT_STAYS = 'Logins, the Vault, connected apps and Telegram never travel: they stay with each computer, and the other one tells you what to set up again.';
/** packing and unpacking a big folder take a while; a sleeping computer takes a while to wake */
export const LONG_MS = 10 * 60_000;

type Step = 'idle' | 'packing' | 'downloading' | 'uploading' | 'unpacking' | 'removing';
const STEP_WORDS: Record<Exclude<Step, 'idle'>, string> = { packing: 'Packing the bot…', downloading: 'Bringing the bundle over…', uploading: 'Sending it to the other computer…', unpacking: 'Unpacking it there…', removing: 'Removing it here…' };

export async function clientFor(key: ComputerKey): Promise<GatewayLike> {
  if (key === 'local') return localGateway();
  return cloudClientReady(key === 'cloud' ? undefined : key.slice('cloud:'.length));
}
export async function blobFrom(g: GatewayLike, key: ComputerKey, file: { id: string; name: string; url: string }): Promise<Blob> {
  if (key !== 'local') return cloudFileBlob(g, file);
  const r = await fetch(g.fileUrl(file));
  if (!r.ok) throw new Error(`The download failed (${r.status}).`);
  return r.blob();
}
export async function uploadTo(g: GatewayLike, blob: Blob, name: string) {
  if (g.upload) return g.upload(blob, name);
  if (g instanceof GatewayClient) return uploadFile(g.baseUrl, g.token, blob, name);
  throw new Error('Uploads are not available here');
}

/** a bot too big to move at once, in words: what it weighs, what the other computer takes, what to do instead */
function tooBigText(name: string, size: number, limit: number, to: string, fromHere: boolean): string {
  const what = `${name} comes to ${bytes(size)}, more than ${to} takes at once (${bytes(limit)}).`;
  return fromHere
    ? `${what} Copy it with Settings › Transfer instead, leaving its chat history or files here, then delete it here if you like.`
    : `${what} Nothing was sent, and it stays where it is.`;
}

/** dev: `?move=1` opens the dialog for the first bot once the roster is in (the browser mock) */
const PREVIEW = import.meta.env.DEV && typeof location !== 'undefined' && new URLSearchParams(location.search).get('move') === '1';

export function MoveBotDialog() {
  const bot = useMoveBot((s) => s.bot);
  const firstBot = useStore((s) => s.bots[0]);
  // (a moment later: the mock's switch to the cloud computer settles first, so `from` is the one on screen)
  useEffect(() => { if (!PREVIEW || !firstBot || useMoveBot.getState().bot) return; const t = setTimeout(() => openMoveBot(firstBot), 600); return () => clearTimeout(t); }, [firstBot?.id]);
  const from = useMoveBot((s) => s.from);
  const view = useCloud((s) => s.view);
  const targets = moveTargets(from, view);
  const [target, setTarget] = useState<ComputerKey | null>(null);
  const [keepCopy, setKeepCopy] = useState(false);
  const [step, setStep] = useState<Step>('idle');
  const [result, setResult] = useState<BotImportResult | null>(null);
  const [failed, setFailed] = useState('');
  useEffect(() => { if (bot) { setTarget(targets[0]?.key ?? null); setKeepCopy(false); setStep('idle'); setResult(null); setFailed(''); } }, [bot?.id]);
  const close = () => { if (step !== 'idle') return; useMoveBot.setState({ bot: null }); };
  const to = targets.find((t) => t.key === target) ?? targets[0];
  const fromLabel = from === 'local' ? THIS_MACHINE : from === 'cloud' ? 'your AppuBot computer' : `${view?.teams?.find((t) => t.team.id === from.slice('cloud:'.length))?.team.name ?? 'your team'}’s AppuBot computer`;

  const run = async () => {
    if (!bot || !to) return;
    setFailed('');
    try {
      setStep('packing');
      const [src, dst] = await Promise.all([clientFor(from), clientFor(to.key)]);
      const { file } = await src.call('bots.export', { id: bot.id }, { timeoutMs: LONG_MS });
      // what the other computer takes at once (one from before says nothing: 300 MB)
      const takes = await dst.call('system.info', {}).then((i) => i.transfer, () => undefined);
      const limit = transferLimit(takes);
      const toLabel = to.label.replace(/^Your/, 'your').replace(/^This/, 'this');
      if (file.size > limit) throw new Error(tooBigText(bot.name, file.size, limit, toLabel, from === 'local'));
      setStep('downloading');
      const blob = await blobFrom(src, from, file);
      setStep('uploading');
      const up = await uploadTo(dst, blob, file.name).catch((e: unknown) => {
        throw sizeRefusalText(e, { name: bot.name, bytes: file.size, target: toLabel }) ? new Error(tooBigText(bot.name, file.size, limit, toLabel, from === 'local')) : e;
      });
      setStep('unpacking');
      const r = await dst.call('bots.import', { fileId: up.id }, { timeoutMs: LONG_MS });
      if (!keepCopy) {
        setStep('removing');
        await src.call('bots.delete', { id: bot.id, deleteWorkspace: true });
        // gone from the roster on screen (the computer it was on is the one shown)
        setState((s) => {
          const bots = s.bots.filter((b) => b.id !== bot.id);
          return { bots, threads: s.threads.filter((t) => t.botId !== bot.id), skills: s.skills.filter((k) => k.botId !== bot.id), routines: s.routines.filter((x) => x.botId !== bot.id), selectedBotId: s.selectedBotId === bot.id ? (bots[0]?.id ?? null) : s.selectedBotId };
        });
        ui.syncSelection();
      }
      setResult(r);
      setStep('idle');
    } catch (e) {
      setStep('idle');
      setFailed(errorMessage(e));
    }
  };
  const open = async () => {
    if (!to || !result) return;
    useMoveBot.setState({ bot: null });
    try {
      await switchComputer(to.key === 'local' ? 'local' : 'cloud', to.team);
      ui.selectBot(result.bot.id);
    } catch (e) { pushToast({ title: 'Couldn’t open the other computer', body: errorMessage(e), level: 'error' }); }
  };

  const busy = step !== 'idle';
  return (
    <Dialog
      open={!!bot}
      onClose={close}
      size="md"
      title={result ? `${bot?.name ?? 'The bot'} is on ${to?.label.replace(/^Your/, 'your') ?? 'the other computer'}` : `${keepCopy ? 'Copy' : 'Move'} ${bot?.name ?? ''}`}
      description={result ? (result.notes.length ? 'A few things to set up there by hand:' : 'Everything came along.') : `From ${fromLabel} to ${to ? to.label.replace(/^Your/, 'your').replace(/^This/, 'this') : 'another computer'}.`}
      footer={result ? (
        <>
          <Button size="sm" variant="ghost" onClick={() => useMoveBot.setState({ bot: null })}>Done</Button>
          <Button size="sm" variant="primary" icon={ArrowRight} onClick={() => void open()}>Open {result.bot.name} there</Button>
        </>
      ) : (
        <>
          <Button size="sm" variant="ghost" disabled={busy} onClick={close}>Cancel</Button>
          <Button size="sm" variant="primary" disabled={busy || !to} loading={busy} onClick={() => void run()}>{keepCopy ? 'Copy' : 'Move'}</Button>
        </>
      )}
    >
      {result ? (
        <div className="flex flex-col gap-3 text-copy">
          <div className="flex items-center gap-2 text-fg"><Icon icon={CircleCheck} size={16} className="text-success" />{result.counts.threads} chats, {result.counts.messages} messages, {result.counts.files} files, {result.counts.skills} skills and {result.counts.routines} routines came along.</div>
          {result.notes.length ? <ul className="flex flex-col gap-1.5 pl-1">{result.notes.map((n) => <li key={n} className="flex gap-2 text-muted"><Icon icon={AlertTriangle} size={14} className="mt-0.5 shrink-0" /><span>{n}</span></li>)}</ul> : null}
        </div>
      ) : (
        <div className="flex flex-col gap-4 text-copy">
          {targets.length > 1 ? (
            <div className="flex flex-col gap-1">
              <div className="text-note font-medium text-muted">To</div>
              {targets.map((t) => (
                <label key={t.key} className="flex cursor-pointer items-center gap-2 rounded-control px-2 py-1.5 hover:bg-ink/5">
                  <input type="radio" name="move-target" checked={target === t.key} disabled={busy} onChange={() => setTarget(t.key)} />
                  <Icon icon={t.key === 'local' ? Laptop : Monitor} size={14} className="text-muted" />
                  <span>{t.label}</span>
                </label>
              ))}
            </div>
          ) : targets.length === 0 ? (
            <div className="text-muted">Get your AppuBot computer first (Settings › Billing) to move bots to it.</div>
          ) : null}
          <div className="flex flex-col gap-1">
            <div className="text-note font-medium text-muted">What moves</div>
            <ul className="list-disc pl-5 text-fg/90">{WHAT_MOVES.map((w) => <li key={w}>{w}</li>)}</ul>
          </div>
          <div className="flex gap-2 text-muted"><Icon icon={AlertTriangle} size={14} className="mt-0.5 shrink-0" /><span>{WHAT_STAYS}</span></div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-fg">Keep a copy on {fromLabel}</span>
            <Switch checked={keepCopy} disabled={busy} onChange={setKeepCopy} label={`Keep a copy on ${fromLabel}`} />
          </div>
          {busy ? <div className="flex items-center gap-2 text-muted"><Spinner size={14} />{STEP_WORDS[step]}</div> : null}
          {failed ? <div className="flex gap-2 text-danger"><Icon icon={AlertTriangle} size={14} className="mt-0.5 shrink-0" /><span>{failed}</span></div> : null}
        </div>
      )}
    </Dialog>
  );
}
