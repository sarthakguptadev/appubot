import { describe, expect, it } from 'vitest';
import { FormFieldSchema, FormVaultKind, VaultKind, type Message } from '@appubot/protocol';
import {
  appCardState, appCardText, botCardDoneText, botCardFields, botCardSetup, cleanFormValues, fieldProblem, fileValue, fileValueId, fileValueName, formAnswerRows, formAnswerText, formChangeRows, formDeclinedText, formDeclineLabel, formEyebrow,
  formProblems, formSubmitLabel, formTitle, initialFormValues, openQuestion, routineFormCron, routineFormFields, routineFormSpec, TELEGRAM_FORM_FIELDS, vaultFormFields, withoutSecrets,
} from './index';

const f = (x: Partial<ReturnType<typeof FormFieldSchema.parse>> & { id: string; type?: string }) => FormFieldSchema.parse({ label: x.id, ...x });

describe('form cards', () => {
  it('knows every Vault kind', () => {
    expect(FormVaultKind.options).toEqual(VaultKind.options);
    for (const k of VaultKind.options) {
      const fields = vaultFormFields(k, { name: 'X' });
      expect(fields[0]).toMatchObject({ id: 'name', required: true, value: 'X' });
      // a secret is never filled in to start with
      expect(fields.filter((x) => x.type === 'secret' && x.value)).toEqual([]);
    }
    expect(vaultFormFields('contact').some((x) => x.type === 'secret')).toBe(false);
  });

  it('checks what was typed', () => {
    expect(fieldProblem(f({ id: 'a', required: true }), '  ')).toBe('Required');
    expect(fieldProblem(f({ id: 'a', type: 'email' }), 'nope')).toBe('Not an email address');
    expect(fieldProblem(f({ id: 'a', type: 'email' }), 'a@b.co')).toBeUndefined();
    expect(fieldProblem(f({ id: 'a', type: 'toggle', required: true }), false)).toBeUndefined();
    expect(fieldProblem(f({ id: 'a', type: 'multichoice', options: ['x'] }), ['y'])).toBe('Pick from the list');
    const card = { fields: vaultFormFields('card', { name: 'Visa' }), vault: { kind: 'card' as const, saved: [] } };
    expect(formProblems(card, { name: 'Visa', number: '4242 4242 4242 4242', expiry: '13/30', cvc: '12' })).toEqual({ expiry: 'Write it as MM/YY', cvc: '3 or 4 digits' });
    expect(formProblems({ fields: vaultFormFields('apiKey'), vault: { kind: 'apiKey', saved: [] } }, { name: 'k', envName: 'MY-KEY', key: 'x' })).toEqual({ envName: 'Letters, digits and _ only' });
  });

  it('cleans values to the fields and reads them back without secrets', () => {
    const fields = [f({ id: 'n' }), f({ id: 't', type: 'toggle' }), f({ id: 'm', type: 'multichoice', options: ['a', 'b'] }), f({ id: 'pw', type: 'secret', label: 'Password' })];
    const v = cleanFormValues(fields, { n: '  Ada ', t: 'true', m: 'a', pw: 'hunter2', junk: 'x' });
    expect(v).toEqual({ n: 'Ada', t: true, m: ['a'], pw: 'hunter2' });
    expect(withoutSecrets(fields, v)).toEqual({ n: 'Ada', t: true, m: ['a'] });
    expect(formAnswerRows(fields, v).at(-1)).toEqual({ label: 'Password', value: '••••••••', secret: true });
    expect(formAnswerText(fields, v)).toBe('n: Ada\nt: Yes\nm: a');
    expect(initialFormValues([f({ id: 'm', type: 'multichoice', options: ['a', 'b'], value: 'b, z' }), f({ id: 'pw', type: 'secret', value: 'no' })])).toEqual({ m: ['b'] });
  });

  it('titles a Vault card by its item', () => {
    const form = { kind: 'vault' as const, fields: vaultFormFields('login', { name: 'GitHub' }), vault: { kind: 'login' as const, saved: [] } };
    expect(formTitle({ question: 'Ada needs a login: “GitHub”', form })).toBe('“GitHub”');
    expect(formEyebrow(form, 'Ada', false)).toBe('Ada needs a login');
    expect(formTitle({ question: 'Hotel details', form: { kind: 'form', fields: [] } })).toBe('Hotel details');
  });

  it('leaves a waiting form out of what the composer answers', () => {
    const msg = (parts: Message['parts']): Message => ({ id: 'm', threadId: 't', role: 'agent', parts, status: 'streaming', via: 'desktop', createdAt: 1, updatedAt: 1 } as Message);
    expect(openQuestion([msg([{ type: 'question', questionId: 'q1', question: 'Q', options: [], form: { kind: 'form', fields: [] } }])])).toBeUndefined();
    expect(openQuestion([msg([{ type: 'question', questionId: 'q0', question: 'Q', options: [] }, { type: 'question', questionId: 'q1', question: 'F', options: [], form: { kind: 'form', fields: [] } }])])).toBe('q0');
  });
});

describe('the request cards (apps, Telegram, routines) and the new fields', () => {
  it('checks a one-time code against its length', () => {
    expect(fieldProblem(f({ id: 'c', type: 'code' }), '123456')).toBeUndefined();
    expect(fieldProblem(f({ id: 'c', type: 'code' }), '1234')).toBe('Enter all 6 characters');
    expect(fieldProblem(f({ id: 'c', type: 'code', max: 4 }), 'A1b2')).toBeUndefined();
    expect(fieldProblem(f({ id: 'c', type: 'code', max: 4 }), '12 4')).toBe('Enter all 4 characters');
    // a length outside 4 to 8 is brought inside it
    expect(fieldProblem(f({ id: 'c', type: 'code', max: 10 }), '12345678')).toBeUndefined();
    expect(fieldProblem(f({ id: 'c', type: 'code', required: true }), '')).toBe('Required');
  });

  it('checks a rating and a file', () => {
    expect(fieldProblem(f({ id: 'r', type: 'rating' }), '4')).toBeUndefined();
    expect(fieldProblem(f({ id: 'r', type: 'rating' }), '6')).toBe('1 to 5');
    expect(fieldProblem(f({ id: 'r', type: 'rating', max: 10 }), '9')).toBeUndefined();
    expect(fieldProblem(f({ id: 'r', type: 'rating' }), '2.5')).toBe('1 to 5');
    expect(fieldProblem(f({ id: 'p', type: 'file' }), '/Users/me/a.pdf')).toBeUndefined();
    expect(fieldProblem(f({ id: 'p', type: 'file' }), 'file:file_1:a.pdf')).toBeUndefined();
    expect(fieldProblem(f({ id: 'p', type: 'file' }), 'a.pdf')).toBe('Pick a file');
    expect(fileValue('file_1', 'report.pdf')).toBe('file:file_1:report.pdf');
    expect(fileValueId('file:file_1:report.pdf')).toBe('file_1');
    expect(fileValueId('/Users/me/a.pdf')).toBeUndefined();
    expect(fileValueName('file:file_1:report.pdf')).toBe('report.pdf');
    expect(fileValueName('/Users/me/Documents/a.pdf')).toBe('a.pdf');
    expect(fileValueName('C:\\Users\\me\\a.pdf')).toBe('a.pdf');
    const rows = formAnswerRows([f({ id: 'p', type: 'file', label: 'Policy' }), f({ id: 'r', type: 'rating', label: 'Firmness' })], { p: '/tmp/x/policy.pdf', r: '4' });
    expect(rows).toEqual([{ label: 'Policy', value: 'policy.pdf', secret: false }, { label: 'Firmness', value: '4 of 5', secret: false }]);
  });

  it('says where an app card stands and what its button does', () => {
    expect(appCardState({ signedIn: false, connected: false, on: true })).toBe('sign-in');
    expect(appCardState({ signedIn: true, connected: false, on: true })).toBe('connect');
    expect(appCardState({ signedIn: true, connected: true, on: false })).toBe('turn-on');
    expect(appCardState({ signedIn: true, connected: true, on: true })).toBe('ready');
    expect(appCardText('connect', 'Gmail', 'Ada').button).toBe('Connect Gmail');
    expect(appCardText('turn-on', 'Gmail', 'Ada').button).toBe('Turn on for Ada');
    expect(appCardText('sign-in', 'Gmail', 'Ada').button).toBe('Sign in to Apps');
    const form = { kind: 'app' as const, fields: [], app: { slug: 'gmail', name: 'Gmail', state: 'connect' as const } };
    expect(formEyebrow(form, 'Ada', false)).toBe('Ada needs Gmail');
    expect(formTitle({ question: 'Ada needs Gmail', form })).toBe('Gmail');
    expect(formSubmitLabel({ kind: 'telegram' })).toBe('Connect');
    expect(formSubmitLabel({ kind: 'routine' })).toBe('Allow');
    expect(formDeclineLabel({ kind: 'routine' })).toBe('Don’t allow');
    expect(formEyebrow({ kind: 'routine', routine: { prompt: 'x', schedule: '0 9 * * *', forBot: 'Bo', action: 'create', changes: [] } }, 'Ada', false)).toBe('Ada proposes a routine for Bo');
    expect(formEyebrow({ kind: 'routine', routine: { prompt: 'x', schedule: '0 9 * * *', action: 'update', changes: [] } }, 'Ada', true)).toBe('Ada proposed a change to a routine');
    // bot cards: a new bot (its name a field), a change to itself or another bot
    const made = { action: 'create' as const, name: 'Scout', agent: 'Claude Code', computerUse: true, job: 'Finds leads', self: false, changes: [] };
    expect(formEyebrow({ kind: 'bot', bot: made }, 'Ada', false)).toBe('Ada wants to make a new bot');
    expect(formTitle({ question: 'Ada wants to make a new bot, Scout.', form: { kind: 'bot', fields: botCardFields('Scout'), bot: made } })).toBe('Scout');
    expect(botCardSetup(made).map((r) => `${r.label}: ${r.value}${r.grants ? ' !' : ''}`)).toEqual(['Runs on: Claude Code', 'Computer use: On !', 'Job: Finds leads']);
    expect(botCardDoneText(made, false)).toBe('Scout is in the sidebar now.');
    expect(botCardDoneText(made, true)).toBe('No bot was made.');
    const self = { action: 'update' as const, name: 'Ada', self: true, changes: [{ label: 'Computer use', value: 'On', was: 'Off', grants: true }] };
    expect(formEyebrow({ kind: 'bot', bot: self }, 'Ada', false)).toBe('Ada wants to change itself');
    expect(formEyebrow({ kind: 'bot', bot: { ...self, name: 'Bo', self: false } }, 'Ada', true)).toBe('Ada wanted to change Bo');
    expect(formChangeRows({ kind: 'bot', bot: self })).toEqual(self.changes);
    expect(formSubmitLabel({ kind: 'bot' })).toBe('Allow');
    expect(formDeclineLabel({ kind: 'bot' })).toBe('Don’t allow');
    expect(formDeclinedText({ kind: 'bot' })).toBe('Not allowed');
    expect(formDeclinedText({ kind: 'form' })).toBe('Declined');
    expect(TELEGRAM_FORM_FIELDS.map((x) => x.type)).toEqual(['secret']);
  });

  it('turns a routine’s cron into fields and the adjusted fields back into cron', () => {
    const fields = routineFormFields({ name: 'Morning check', schedule: '30 8 * * 1-5', deliverTo: 'notify' });
    const by = Object.fromEntries(fields.map((x) => [x.id, x]));
    expect(by.repeat!.value).toBe('Weekdays');
    expect(by.time!.value).toBe('08:30');
    expect(by.days!.value).toBe('Mon,Tue,Wed,Thu,Fri');
    expect(by.results!.value).toBe('Notify me when done');
    // the user moves it to 9:00 on Mondays and Thursdays, results kept in the chat
    const values = cleanFormValues(fields, { ...initialFormValues(fields), repeat: 'Certain days', time: '09:00', days: ['Mon', 'Thu'], results: 'Keep them in the chat' });
    const read = routineFormSpec(values);
    expect('problems' in read).toBe(false);
    if (!('problems' in read)) {
      expect(routineFormCron(read.spec)).toBe('0 9 * * 1,4');
      expect(read.deliverTo).toBe('thread');
      expect(read.name).toBe('Morning check');
    }
    // every kind round-trips
    for (const cron of ['15 * * * *', '0 9 * * *', '30 8 * * 1-5', '0 18 * * 5', '0 7 1 * *']) {
      const fs = routineFormFields({ name: 'r', schedule: cron, deliverTo: 'notify' });
      const r = routineFormSpec(cleanFormValues(fs, initialFormValues(fs)));
      expect('problems' in r ? r : routineFormCron(r.spec)).toBe(cron);
    }
    // a cron the editor can't express keeps its own field
    const custom = routineFormFields({ name: 'r', schedule: '*/10 * * * *', deliverTo: 'thread' });
    expect(custom.find((x) => x.id === 'cron')?.value).toBe('*/10 * * * *');
    const rc = routineFormSpec(cleanFormValues(custom, initialFormValues(custom)));
    expect('problems' in rc ? rc : routineFormCron(rc.spec)).toBe('*/10 * * * *');
    // what's wrong is said per field
    const bad = routineFormSpec({ name: '', repeat: 'Monthly', time: '09:00', day: '40', results: 'Notify me when done' });
    expect(bad).toEqual({ problems: { name: 'Required', day: '1 to 31' } });
    expect(routineFormSpec({ name: 'x', repeat: 'Certain days', time: '09:00', days: [], results: 'Notify me when done' })).toEqual({ problems: { days: 'Pick the days' } });
  });
});
