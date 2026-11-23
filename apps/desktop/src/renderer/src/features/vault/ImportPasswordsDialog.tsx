/**
 * Settings › Vault › Import passwords: the logins in a CSV file a browser or password manager exported, as Vault
 * logins on the computer on screen. The file is read here, in the window (chat-core `passwordCsv.ts`), and its rows go
 * straight to that computer's Vault (`vault.saveMany`, sealed there): nothing is uploaded or kept anywhere else.
 * Logins the Vault already has (same site and username) are left alone unless their passwords are to be replaced.
 */
import { useMemo, useRef, useState } from 'react';
import {
  PASSWORD_EXPORT_STEPS, PasswordFileError, loginsCount, passwordFileSummary, planLoginImport, readPasswordFile,
  type LoginPlanRow, type PasswordFile,
} from '@appubot/chat-core';
import type { VaultItem } from '@appubot/protocol';
import { AlertTriangle, LockKeyhole, Upload } from '../../components/ui/icons';
import { Button, Checkbox, Dialog, Icon, Input, Spinner, Switch, cn } from '../../components/ui';
import { pushToast } from '../../lib/store';
import { errorMessage, gateway } from '../../lib/gateway';
import { saveVaultItems, type VaultSave } from './vaultCarry';

/** a file bigger than any passwords export isn't one */
const FILE_MAX = 8 * 1024 * 1024;

const rowKey = (r: LoginPlanRow, i: number) => `${i}:${r.login.site}:${r.login.username}`;

export function ImportPasswordsDialog({ items, where, onClose, onDone }: {
  /** the Vault as it stands (to find the logins already saved) */
  items: VaultItem[];
  /** "this Mac" / "your AppuBot computer" */
  where: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [file, setFile] = useState<PasswordFile | null>(null);
  const [fileName, setFileName] = useState('');
  const [error, setError] = useState('');
  const [off, setOff] = useState<Set<string>>(new Set());
  const [replace, setReplace] = useState(false);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<{ done: number; total: number } | null>(null);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const plan = useMemo(() => (file ? planLoginImport(file.logins, items) : []), [file, items]);
  const rows = useMemo(() => plan.map((r, i) => ({ r, key: rowKey(r, i) })), [plan]);
  const picked = rows.filter(({ r, key }) => !off.has(key) && (replace || !r.existing));
  const there = plan.filter((r) => r.existing).length;
  const q = query.trim().toLowerCase();
  const shown = q ? rows.filter(({ r }) => `${r.login.name} ${r.login.site} ${r.login.username}`.toLowerCase().includes(q)) : rows;

  const read = async (f: File | undefined | null) => {
    if (!f) return;
    setError('');
    if (f.size > FILE_MAX) return setError('That file is too large to be a passwords export.');
    try {
      const parsed = readPasswordFile(await f.text());
      if (!parsed.logins.length) return setError('That file has no logins with a password in it.');
      setFile(parsed);
      setFileName(f.name);
      setOff(new Set());
    } catch (e) {
      setError(e instanceof PasswordFileError ? e.message : `Couldn’t read that file: ${errorMessage(e)}`);
    }
  };

  const run = async () => {
    const byId = new Map(items.map((i) => [i.id, i]));
    const saves: VaultSave[] = picked.map(({ r }) => {
      const ex = r.existing ? byId.get(r.existing.id) : undefined;
      // one already saved keeps its name, site and notes: only its password is replaced
      if (ex) return { id: ex.id, kind: 'login', name: ex.name, site: ex.site, username: ex.username, notes: ex.notes, secrets: { password: r.login.password } };
      return { kind: 'login', name: r.login.name, site: r.login.site || undefined, username: r.login.username || undefined, notes: r.login.notes, secrets: { password: r.login.password } };
    });
    if (!saves.length) return;
    setError('');
    setBusy({ done: 0, total: saves.length });
    try {
      await saveVaultItems(gateway(), saves, (done, total) => setBusy({ done, total }));
      pushToast({ title: `Added ${loginsCount(saves.length)} to the Vault`, body: 'Delete the exported file now: it holds your passwords unprotected.', level: 'success' });
      onDone();
    } catch (e) {
      setError(`Couldn’t add them: ${errorMessage(e)}`);
      setBusy(null);
    }
  };

  return (
    <Dialog
      open
      onClose={busy ? () => undefined : onClose}
      size="lg"
      title={(
        <span className="flex items-center gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-control-lg bg-accent-soft text-accent-strong"><Icon icon={LockKeyhole} size={18} /></span>
          Import passwords
        </span>
      )}
      description={`Bring the passwords saved in your browser or password manager into the Vault on ${where}. The file is read here and goes nowhere else. Bots never see a password: AppuBot types it for them, after your Allow.`}
      footer={file ? (
        <>
          <Button variant="ghost" disabled={!!busy} onClick={() => { setFile(null); setError(''); }}>Choose another file</Button>
          <Button variant="primary" loading={!!busy} disabled={!picked.length} onClick={() => void run()}>
            {busy ? `Adding ${busy.done} of ${busy.total}…` : `Add ${loginsCount(picked.length)}`}
          </Button>
        </>
      ) : <Button variant="ghost" onClick={onClose}>Cancel</Button>}
    >
      <input ref={input} type="file" accept=".csv,text/csv,text/plain" hidden onChange={(e) => { void read(e.target.files?.[0]); e.target.value = ''; }} />
      {!file ? (
        <div className="flex flex-col gap-4">
          <button
            type="button"
            onClick={() => input.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setOver(true); }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); setOver(false); void read(e.dataTransfer.files[0]); }}
            className={cn(
              'flex flex-col items-center gap-2 rounded-control-lg border border-dashed px-6 py-8 text-center transition-colors focus-visible:outline-none',
              over ? 'border-[var(--ab-accent)] bg-accent-soft' : 'border-[var(--ab-hairline)] hover:bg-surface-2',
            )}
          >
            <Icon icon={Upload} size={20} className="text-muted" />
            <span className="text-copy font-medium text-fg">Choose the exported file</span>
            <span className="text-ui text-muted">or drop it here · a .csv file</span>
          </button>
          <div className="flex flex-col gap-2">
            <div className="text-ui font-medium text-fg">Where to export it</div>
            <ul className="flex flex-col gap-1.5">
              {PASSWORD_EXPORT_STEPS.map((s) => (
                <li key={s.app} className="text-ui leading-snug text-muted"><span className="text-fg">{s.app}:</span> {s.steps}</li>
              ))}
            </ul>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="truncate text-copy font-medium text-fg">{fileName}</div>
              <div className="text-ui text-muted">{passwordFileSummary(file, plan)}</div>
            </div>
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" className="h-8 w-44 shrink-0 text-copy" spellCheck={false} />
          </div>
          {there ? (
            <label className="flex cursor-pointer items-center justify-between gap-3 rounded-control-lg border border-[var(--ab-hairline)] px-3.5 py-2.5">
              <span className="text-copy text-fg">Replace the passwords of the {there.toLocaleString('en-US')} already in the Vault</span>
              <Switch checked={replace} disabled={!!busy} onChange={setReplace} label="Replace the passwords already in the Vault" />
            </label>
          ) : null}
          <div className="max-h-[320px] overflow-y-auto rounded-control-lg border border-[var(--ab-hairline)]">
            {shown.length ? shown.map(({ r, key }) => {
              const skipped = !!r.existing && !replace;
              return (
                <label key={key} className={cn('flex items-center gap-3 border-b border-[var(--ab-hairline)] px-3.5 py-2 last:border-b-0', skipped || busy ? 'cursor-default' : 'cursor-pointer')}>
                  <Checkbox disabled={skipped || !!busy}
                    checked={!skipped && !off.has(key)}
                    onChange={() => setOff((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; })}
                  />
                  <span className={cn('min-w-0 flex-1', skipped && 'opacity-55')}>
                    <span className="block truncate text-copy text-fg">{r.login.name}</span>
                    <span className="block truncate text-note text-muted">{[r.login.site, r.login.username].filter(Boolean).join(' · ') || 'No site or username'}</span>
                  </span>
                  {r.existing ? <span className="shrink-0 text-note text-muted">{replace ? 'Password replaced' : 'Already saved'}</span> : null}
                </label>
              );
            }) : <div className="px-3.5 py-6 text-center text-copy text-muted">Nothing matches “{query.trim()}”.</div>}
          </div>
          <div className="flex items-center justify-between gap-3 text-ui text-muted">
            <span>{busy ? <span className="flex items-center gap-2"><Spinner size={13} />Sealing them in the Vault…</span> : `${loginsCount(picked.length)} picked`}</span>
            {!busy ? (
              <span className="flex gap-3">
                <button type="button" className="hover:text-fg" onClick={() => setOff(new Set())}>Select all</button>
                <button type="button" className="hover:text-fg" onClick={() => setOff(new Set(rows.map((x) => x.key)))}>Select none</button>
              </span>
            ) : null}
          </div>
        </div>
      )}
      {error ? <p className="selectable mt-3 flex gap-2 text-ui leading-snug text-danger"><Icon icon={AlertTriangle} size={14} className="mt-0.5 shrink-0" /><span>{error}</span></p> : null}
    </Dialog>
  );
}
