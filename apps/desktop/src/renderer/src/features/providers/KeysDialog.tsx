import { useState } from 'react';
import type { AuthMethod, Provider } from '@appubot/protocol';
import { Button, Dialog, Field, Input } from '../../components/ui';
import { call } from '../../lib/actions';
import { native } from '../../lib/native';
import { useThisComputer } from '../cloud/thisComputer';
import { pushToast } from '../../lib/store';
import { ProviderMark } from './providerLogos';

/**
 * The keys a login asks for (`method.vars`: an API key…): saved on this computer for this user only, handed to the
 * agent whenever it starts (`providers.setKeys`), never shown again.
 */
export function KeysDialog({ provider: p, method, onClose }: { provider: Provider; method: AuthMethod; onClose: () => void }) {
  const computer = useThisComputer();
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const vars = method.vars ?? [];
  const missing = vars.some((v) => !v.optional && !values[v.name]?.trim());

  const submit = async () => {
    if (missing || busy) return;
    setBusy(true);
    setError(undefined);
    const r = await call('providers.setKeys', { id: p.id, methodId: method.id, values }, { errorTitle: `Could not save ${p.name}'s key` });
    setBusy(false);
    if (!r) return;
    if (!r.ok) return setError(r.message ?? `${p.name} didn't take that key.`);
    pushToast({ title: `Saved ${p.name}'s key`, body: r.message, level: 'success' });
    onClose();
  };

  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title={
        <span className="flex items-center gap-3">
          <ProviderMark provider={p} size={32} />
          {method.name}
        </span>
      }
      description={`${p.name} uses it to sign in. It stays on ${computer.name}, readable only by you, and goes only to ${p.name}.`}
      footer={
        <>
          {method.link ? (
            <Button variant="ghost" className="mr-auto text-muted" onClick={() => void native().openExternal(method.link!)}>Get a key</Button>
          ) : null}
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={missing} onClick={() => void submit()}>Save and sign in</Button>
        </>
      }
    >
      <form className="flex flex-col gap-3.5" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        {vars.map((v, i) => (
          <Field key={v.name} label={`${v.label ?? v.name}${v.optional ? ' (optional)' : ''}`} hint={v.label ? <span className="font-mono">{v.name}</span> : undefined}>
            <Input
              autoFocus={i === 0}
              type={v.secret ? 'password' : 'text'}
              autoComplete="off"
              spellCheck={false}
              placeholder={p.keysSaved.includes(v.name) ? 'Saved: enter a new one to replace it' : undefined}
              value={values[v.name] ?? ''}
              onChange={(e) => setValues((x) => ({ ...x, [v.name]: e.target.value }))}
              className={v.secret ? 'font-mono' : undefined}
            />
          </Field>
        ))}
        {error ? <p className="selectable text-ui leading-snug text-danger">{error}</p> : null}
        {/* Enter submits */}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
