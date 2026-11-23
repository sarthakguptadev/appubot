import { useT } from '../../lib/i18n';
// Prompt composer (Synara's chat composer, MIT; behaviour from Akeru's BotPromptComposer): a raised glass pill with
// + at the left (it attaches files, nothing else), the editor (one line, growing with the draft) and at the right the
// mic (dictation: what you say is added to the draft) and the round button: send, voice mode while the draft is empty
// and, while the bot works, Stop until something is typed (a message sent then still reaches it mid-task). The row of
// pickers under it is off (COMPOSER_PICKERS). Enter sends, Shift+Enter breaks the line (or ⌘Enter sends: Settings › Appearance);
// slash commands, per-chat drafts, pasted/dropped images and files, and attached files carry over.
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import type { Bot, SlashCommand, Thread } from '@appubot/protocol';
import { ArrowUp, File, Paperclip, Plus, VoiceWave, X } from '../../components/ui/icons';
import { Icon, Menu, Tooltip, cn, type MenuItem } from '../../components/ui';
import { call } from '../../lib/actions';
import { basename } from '@appubot/chat-core';
import { isSendKey } from '../../lib/appearance';
import { native } from '../../lib/native';
import { getState, pushToast } from '../../lib/store';
import { startVoice } from '../voice/useVoiceConversation';
import { DictateButton } from '../voice/Dictation';
import { useVoiceRoute } from '../voice/macVoice';
import { drafts, withFileLines, type PendingImage } from './attachments';
import { fitImage, isImageFile } from './imageFit';
import { ModePicker, ThreadModelPicker } from './ComposerBar';
import { ContextRing } from './ContextRing';
import { SlashMenu, filterCommands } from './SlashMenu';

/** the composer's "/" menu of the agent's commands */
const SHOW_SLASH_MENU = false;
/**
 * The row of pickers under the pill (permission mode, model and effort, the context ring). Off since 2026-11-17: the
 * composer is one box, and those live in the side panel's Bot tab, which the chat header's bot name opens. Turning this
 * on brings the row back as it was.
 */
const COMPOSER_PICKERS = false;
const NO_COMMANDS: SlashCommand[] = [];
import { wantCommands } from './threadCommands';
import { useRemoteComputer } from '../cloud/remoteFiles';
import { QUOTE_EVENT, type QuoteRequest } from './QuoteSelection';
import { EDIT_SEND_EVENT, type EditSendRequest } from './editSend';
import { tooBig } from './remoteAttachments';

export interface ComposerProps {
  thread?: Thread;
  bot?: Bot;
  draftKey: string;
  placeholder?: string;
  /** `files`: on a remote computer, the files attached (their bytes go over first: remoteAttachments.ts) */
  onSend: (text: string, images: { mimeType: string; data: string }[], files?: File[]) => Promise<boolean>;
  autoFocus?: boolean;
  /** an approval panel is docked on top of the composer */
  docked?: boolean;
  /** a group's room: + is a menu of Attach files (by path) and the caller's rows, no dictation mic, no pickers row under the pill, pasted pictures and dropped files left out */
  plain?: boolean;
  /** with no thread (a group's room): Stop in Send's place while nothing is typed, and what it does */
  onStop?: () => void;
  /** a group's room: the voice button in Send's place while nothing is typed; what was heard is sent with this */
  onVoiceText?: (text: string) => void;
  /** a group's room: what sits at the right of the row under the pill (its model picker) */
  footer?: ReactNode;
  /** more rows for the + menu (a group's room: mention a member), given a way to put text into the draft */
  addItems?: (insert: (text: string) => void) => MenuItem[];
}

/** What you sent in this thread, newest first (the text you typed; repeats once): ↑ in an empty box walks back through it. */
function sentPrompts(threadId: string | undefined): string[] {
  const c = threadId ? getState().convo[threadId] : undefined;
  if (!c) return [];
  const out: string[] = [];
  for (let i = c.ids.length - 1; i >= 0; i--) {
    const m = c.byId[c.ids[i]!];
    if (m?.role !== 'user') continue;
    const text = m.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('\n').trim();
    if (text && out[out.length - 1] !== text) out.push(text);
  }
  return out;
}

/** Quotes picked from the bot's replies, then what you typed: Markdown quotes, so the bot sees exactly what you meant. */
export function withQuotes(quotes: string[], text: string): string {
  if (!quotes.length) return text;
  const block = quotes.map((q) => q.split('\n').map((l) => `> ${l}`.trimEnd()).join('\n')).join('\n\n');
  return text.trim() ? `${block}\n\n${text}` : block;
}

/** what a file is called on its tile: "PDF", "DOCX" (its extension), else nothing */
const extOf = (name: string): string => /\.([a-z0-9]{1,5})$/i.exec(name)?.[1]?.toUpperCase() ?? '';

/** A file's tile with no picture of its own: its icon, its extension and its name. */
function FileFace({ name }: { name: string }) {
  const ext = extOf(name);
  return (
    <span className="flex size-full flex-col items-center justify-center gap-0.5 px-1 text-center">
      <Icon icon={File} size={18} className="text-muted" />
      {ext ? <span className="text-[9.5px] font-semibold tracking-wide text-fg-2">{ext}</span> : null}
      <span className="line-clamp-1 max-w-full text-[10px] leading-tight break-all text-muted">{name}</span>
    </span>
  );
}

/** A preview with the file's name along its foot (a picture says nothing about what the file is called). */
function Preview({ src, name, video }: { src: string; name: string; video?: boolean }) {
  return (
    <>
      {video
        ? <video src={src} muted playsInline preload="metadata" className="size-full object-cover" />
        : <img src={src} alt="" className="size-full object-cover" />}
      <span className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/65 to-transparent px-1.5 pt-3 pb-1 text-[9.5px] leading-none text-white">{name}</span>
    </>
  );
}

/**
 * A file attached by path on this Mac: the system's own thumbnail of it (Quick Look on macOS, the shell on Windows: a
 * PDF's first page, a document's, a picture, a clip's frame), else its icon and extension.
 */
function PathPreview({ path }: { path: string }) {
  const name = basename(path);
  const [thumb, setThumb] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setThumb(null);
    void native().fileThumbnail?.(path).then((t) => { if (alive) setThumb(t); }).catch(() => undefined);
    return () => { alive = false; };
  }, [path]);
  return thumb ? <Preview src={thumb} name={name} /> : <FileFace name={name} />;
}

/** A file on its way to a remote computer (its bytes are here): a picture or a clip shows itself, the rest its icon. */
function BlobPreview({ file }: { file: globalThis.File }) {
  const kind = file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video' : null;
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!kind) return;
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file, kind]);
  return url ? <Preview src={url} name={file.name} video={kind === 'video'} /> : <FileFace name={file.name} />;
}

function Tile({ onRemove, label, children }: { onRemove: () => void; label: string; children: React.ReactNode }) {
  return (
    <div className="group/tile relative size-16 shrink-0 overflow-hidden rounded-control border border-border-subtle bg-surface-2" title={label}>
      {children}
      <button type="button" aria-label={`Remove ${label}`} onClick={onRemove} className="absolute top-1 right-1 flex size-5 items-center justify-center rounded-md bg-[color:var(--ab-popover)] text-muted shadow-sm hover:text-fg">
        <Icon icon={X} size={11} />
      </button>
    </div>
  );
}

/**
 * Synara's prominent round button: send, voice mode and stop. `chat-send` / `chat-round`: the Messages theme's hooks
 * (themes/messages.css), which draws the composer as floating pieces: send and stop a larger solid circle, the voice
 * button and + round glass, the field a pill of its own.
 */
const SEND = cn(
  // Rare UI's send button: an ink circle that gives under the pointer and springs back, faint while there is nothing to send
  'chat-send ab-press ab-pill squircle flex shrink-0 items-center justify-center rounded-control bg-fg text-[color:var(--ab-inverse)] [--press:.88]',
  'focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_var(--ab-bg),0_0_0_4px_var(--ab-ring)] disabled:opacity-20',
);

/** The browser engine's file dialog: it hands the files' bytes, which a remote computer needs. */
function pickBrowserFiles(onFiles: (files: globalThis.File[]) => void): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.onchange = () => { const files = Array.from(input.files ?? []); if (files.length) onFiles(files); };
  input.click();
}

const ADD = 'chat-round ab-press ab-pill squircle flex size-8 shrink-0 items-center justify-center rounded-control bg-surface-2 text-fg/80 [--press:.9] hover:bg-surface-3 hover:text-fg focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_var(--ab-ring)] aria-expanded:bg-surface-3 aria-expanded:text-fg';

/**
 * The pill's +: it attaches files and nothing else, so a press opens the file dialog at once. Voice mode and dictation
 * are the buttons at the pill's other end; Teach is in the bot's menu, the Skills tab and the palette. Only a group's
 * room, which has rows of its own (mention a member), gets a menu. A memo of its own: the composer draws again on every
 * key typed, and this doesn't change with the text.
 */
const AddButton = memo(function AddButton({ files = true, extra = [], onFiles, onBlobs, focus }: {
  onFiles: (paths: string[]) => void;
  /** off where the files couldn't go: a group's room on a remote computer */
  files?: boolean;
  /** a group's room: rows of the caller's own, which make + a menu */
  extra?: MenuItem[];
  /** on a remote computer: the files themselves, picked by the browser engine's own dialog (a path here means nothing there) */
  onBlobs?: (files: globalThis.File[]) => void;
  focus: RefObject<HTMLTextAreaElement | null>;
}) {
  const t = useT();
  const attach = async () => {
    if (onBlobs) { pickBrowserFiles(onBlobs); return; }
    const picked = await native().pickFiles({ multiple: true });
    if (picked.length) onFiles(picked);
    focus.current?.focus();
  };
  if (!extra.length) {
    if (!files) return null;
    return (
      <Tooltip label={t('composer.attach')} side="top">
        <button type="button" aria-label={t('composer.attach')} onClick={() => void attach()} className={ADD}>
          <Icon icon={Plus} size={15} />
        </button>
      </Tooltip>
    );
  }
  return (
    <Menu
      align="start"
      className="min-w-[210px]"
      trigger={(p) => (
        <button {...p} type="button" aria-label={t('composer.add')} className={ADD}>
          <Icon icon={Plus} size={15} />
        </button>
      )}
      items={[
        ...(files ? [{ label: 'Attach files…', icon: Paperclip, onSelect: () => void attach() }, 'separator' as const] : []),
        ...extra,
      ]}
    />
  );
});

export function Composer({ thread, bot, draftKey, placeholder, onSend, autoFocus = true, docked, plain = false, onStop, addItems, onVoiceText, footer }: ComposerProps) {
  const t = useT();
  const [text, setText] = useState(() => drafts.get(draftKey) ?? '');
  const [images, setImages] = useState<PendingImage[]>([]);
  const [paths, setPaths] = useState<string[]>([]);
  /** on a remote computer (your AppuBot computer, a team's): the files themselves, since a path here means nothing there */
  const [files, setFiles] = useState<File[]>([]);
  const remote = !!useRemoteComputer();
  const [quotes, setQuotes] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [active, setActive] = useState(0);
  const [dragging, setDragging] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  /** T3 Code's prompt recall: which sent prompt is in the box (index into `sentPrompts`), while it is unedited */
  const recall = useRef<{ i: number; text: string } | null>(null);
  const running = thread?.status === 'running' || thread?.status === 'waiting';
  // speech runs on this computer where its models can (a server that predates voice offers none); with an AppuBot
  // computer on screen (no speech models there, plan §4.2) this Mac's own model hears instead (voice/voiceRoute.ts)
  const voice = useVoiceRoute().hear !== null;
  /** the mic is dictating (or writing down what it heard): voice mode would take the microphone from it */
  const [dictating, setDictating] = useState(false);

  useEffect(() => { setText(drafts.get(draftKey) ?? ''); setImages([]); setPaths([]); setFiles([]); setQuotes([]); recall.current = null; if (autoFocus) ta.current?.focus(); }, [draftKey, autoFocus]);
  // "Quote" on text selected in one of this chat's replies (QuoteSelection)
  useEffect(() => {
    const onQuote = (e: Event) => {
      const q = (e as CustomEvent<QuoteRequest>).detail;
      if (q.threadId !== thread?.id) return;
      setQuotes((cur) => (cur.includes(q.text) ? cur : [...cur, q.text]));
      ta.current?.focus();
    };
    window.addEventListener(QUOTE_EVENT, onQuote);
    return () => window.removeEventListener(QUOTE_EVENT, onQuote);
  }, [thread?.id]);
  useEffect(() => { drafts.set(draftKey, text); }, [draftKey, text]);

  // the "/" menu of the agent's commands is off (owner's call, 2026-11-07): a "/" is just text, and a typed command
  // still reaches the agent as it is; the context ring's Compact sends /compact itself
  const slash = SHOW_SLASH_MENU && text.startsWith('/');
  // a cloud thread comes without its commands: asked for once "/" is typed
  useEffect(() => { if (slash) wantCommands(thread?.id); }, [slash, thread?.id]);
  const commands = slash ? filterCommands(thread?.commands ?? [], text) : NO_COMMANDS;
  useEffect(() => setActive(0), [commands.length]);

  const hasDraft = text.trim().length > 0 || images.length > 0 || paths.length > 0 || files.length > 0 || quotes.length > 0;
  // the bot working doesn't hold a message back: it goes into the turn (Claude Code) or right after it
  const canSend = hasDraft;
  // the round button: the ink circle (the bot's colour on it read badly, the owner's call 2026-11-17)
  const ROUND = cn(SEND, 'size-8 transition-[filter] duration-100 hover:brightness-90');
  // ChatGPT's composer: with nothing typed, send's slot starts voice mode instead
  const voiceSlot = voice && !!bot && !hasDraft && !sending && !dictating;

  // the message shows in the chat at once and goes in the background (lib/outbox.ts): the box is free again now, and
  // only a send that couldn't even be queued puts the draft back (if nothing new was typed meanwhile)
  const send = async () => {
    if (!canSend) return;
    const draft = { text, images, paths, files, quotes };
    setText(''); setImages([]); setPaths([]); setFiles([]); setQuotes([]); drafts.delete(draftKey); recall.current = null;
    ta.current?.focus();
    setSending(true);
    const ok = await onSend(withFileLines(withQuotes(draft.quotes, draft.text), draft.paths), draft.images.map(({ mimeType, data }) => ({ mimeType, data })), draft.files)
      .catch(() => false);
    if (mounted.current) setSending(false);
    if (ok) return;
    if (!mounted.current) { if (!drafts.get(draftKey)) drafts.set(draftKey, draft.text); return; }
    setText((cur) => (cur ? cur : draft.text));
    setImages((cur) => (cur.length ? cur : draft.images));
    setPaths((cur) => (cur.length ? cur : draft.paths));
    setFiles((cur) => (cur.length ? cur : draft.files));
    setQuotes((cur) => (cur.length ? cur : draft.quotes));
  };
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  // "Edit" on a message that wasn't sent: its words come back here (UserMessage's SendState)
  useEffect(() => {
    const onEdit = (e: Event) => {
      const d = (e as CustomEvent<EditSendRequest>).detail;
      if (d.threadId !== thread?.id) return;
      setText((cur) => (cur.trim() ? `${cur}\n\n${d.text}` : d.text));
      if (d.images.length) setImages((cur) => [...cur, ...d.images.map((im, i) => ({ ...im, id: `edit-${Date.now()}-${i}`, preview: `data:${im.mimeType};base64,${im.data}` }))].slice(0, 8));
      if (d.files.length) setFiles((cur) => [...cur, ...d.files]);
      ta.current?.focus();
    };
    window.addEventListener(EDIT_SEND_EVENT, onEdit);
    return () => window.removeEventListener(EDIT_SEND_EVENT, onEdit);
  }, [thread?.id]);

  /** put text at the end of the draft (a space before it when needed) and keep typing */
  const insert = useCallback((s: string) => {
    setText((cur) => `${cur}${cur && !/\s$/.test(cur) ? ' ' : ''}${s}`);
    requestAnimationFrame(() => { const el = ta.current; if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } });
  }, []);
  const plainItems = useMemo(() => addItems?.(insert) ?? [], [addItems, insert]);
  const pick = useCallback((c: SlashCommand) => { setText(`/${c.name} `); ta.current?.focus(); }, []);
  const attachFiles = useCallback((picked: string[]) => { setPaths((cur) => Array.from(new Set([...cur, ...picked]))); }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (commands.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => (a + 1) % commands.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => (a - 1 + commands.length) % commands.length); return; }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && text.trim() !== `/${commands[active]?.name}`)) {
        e.preventDefault(); const c = commands[active]; if (c) pick(c); return;
      }
      if (e.key === 'Escape') { e.preventDefault(); setText(text + ' '); return; }
    }
    if (isSendKey(e)) { e.preventDefault(); void send(); return; }
    // ↑ in an empty box (or on an unedited recalled prompt's first line) brings back what you sent, ↓ comes forward
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey && !images.length && !paths.length && !files.length) {
      const el = e.currentTarget;
      const r = recall.current && recall.current.text === text ? recall.current : null;
      if (!r && text) return;
      const before = text.slice(0, el.selectionStart);
      const after = text.slice(el.selectionEnd);
      if (e.key === 'ArrowUp' && before.includes('\n')) return;
      if (e.key === 'ArrowDown' && (!r || after.includes('\n'))) return;
      const prompts = sentPrompts(thread?.id);
      const i = e.key === 'ArrowUp' ? (r ? r.i + 1 : 0) : r!.i - 1;
      if (e.key === 'ArrowUp' && i >= prompts.length) return;
      e.preventDefault();
      const next = i >= 0 ? prompts[i]! : '';
      recall.current = i >= 0 ? { i, text: next } : null;
      setText(next);
      requestAnimationFrame(() => { const t = ta.current; if (t) t.setSelectionRange(next.length, next.length); });
    }
  };

  /** Files to carry over to a remote computer (the size check happens here, so a file too big is refused at once). */
  const keepFiles = useCallback((picked: globalThis.File[]) => {
    const big = tooBig(picked);
    if (big) pushToast({ title: `${big.name} is too big to attach`, body: 'Files up to 200 MB can be sent to your AppuBot computer.', level: 'error' });
    const ok = picked.filter((f) => f !== big);
    if (ok.length) setFiles((cur) => [...cur, ...ok]);
  }, []);

  /**
   * Dropped or pasted files: pictures go in as images, any other file (a song, a PDF…) is attached by its path, or, on
   * a remote computer, as the file itself.
   */
  const addFiles = async (files: globalThis.File[]) => {
    const imgs = files.filter(isImageFile);
    const others = files.filter((f) => !isImageFile(f));
    if (remote) keepFiles(others);
    else {
      const found = others.map((f) => native().pathForFile(f)).filter(Boolean);
      if (found.length) setPaths((cur) => Array.from(new Set([...cur, ...found])));
      if (found.length < others.length) pushToast({ title: 'Use + to attach files', body: 'Some of these files couldn’t be attached here.', level: 'info' });
    }
    // pictures too big for the agent are shrunk, HEIC converted; one by one, so big photos aren't all decoded at once
    const failed: globalThis.File[] = [];
    for (const f of imgs) {
      const img = await fitImage(f).catch(() => null);
      if (img) setImages((cur) => [...cur, img].slice(0, 8));
      else failed.push(f);
    }
    if (!failed.length) return;
    // what can't go in as an image still reaches the bot as a file
    if (remote) { keepFiles(failed); pushToast({ title: 'Attached as a file', body: 'This picture couldn’t go in as an image, so the bot gets the file to open.', level: 'info' }); return; }
    const asFiles = failed.map((f) => native().pathForFile(f)).filter(Boolean);
    if (asFiles.length) setPaths((cur) => Array.from(new Set([...cur, ...asFiles])));
    if (asFiles.length === failed.length) pushToast({ title: 'Attached as a file', body: 'This picture couldn’t go in as an image, so the bot gets the file to open.', level: 'info' });
    else pushToast({ title: 'Could not attach image', body: 'This picture couldn’t be read here. Save it to a file and attach it with +.', level: 'error' });
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData.files);
    if (files.length) { e.preventDefault(); void addFiles(files); }
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault(); setDragging(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length) void addFiles(files);
  };

  return (
    <div onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={onDrop}>
      <div className="relative">
        <SlashMenu items={commands} active={active} onPick={pick} onHover={setActive} />
        {/* Synara's pill: + (files) at the left, the editor, then the mic (dictation) and send (or voice mode) at the right */}
        <div
          className={cn(
            'chat-composer chat-composer-surface squircle relative flex items-end gap-2 rounded-card p-1.5 transition-[border-radius,border-color] duration-200 ease-rare',
            dragging && 'border-accent',
            docked && 'rounded-t-md border-t-transparent',
          )}
          data-dragging={dragging ? '' : undefined}
        >
          {plain ? (
            // a group's room: files by path on this Mac (the bots read them there), and the caller's rows
            <AddButton files={!remote} extra={plainItems} onFiles={attachFiles} focus={ta} />
          ) : <AddButton onFiles={attachFiles} onBlobs={remote ? keepFiles : undefined} focus={ta} />}
          <div className={cn('chat-composer-field min-w-0 flex-1 py-[6.25px]', plain && 'pl-2.5')}>
            {quotes.length ? (
              <div className="mt-1 mb-2 flex flex-col gap-1.5">
                {quotes.map((q) => (
                  <div key={q} className="group/quote flex items-start gap-2 rounded-control border-l-2 border-[var(--ab-accent)] bg-surface-2 py-1.5 pr-1.5 pl-2.5">
                    <p className="line-clamp-2 min-w-0 flex-1 text-ui leading-snug text-fg-2">{q}</p>
                    <button type="button" aria-label="Remove quote" onClick={() => setQuotes((c) => c.filter((x) => x !== q))} className="flex size-5 shrink-0 items-center justify-center rounded-md text-muted hover:text-fg">
                      <Icon icon={X} size={11} />
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
            {images.length || paths.length || files.length ? (
              <div className="mt-1 mb-2 flex flex-wrap gap-2">
                {images.map((im) => (
                  <Tile key={im.id} label="image" onRemove={() => setImages((c) => c.filter((x) => x.id !== im.id))}>
                    <img src={im.preview} alt="" className="size-full object-cover" />
                  </Tile>
                ))}
                {paths.map((p) => (
                  <Tile key={p} label={basename(p)} onRemove={() => setPaths((c) => c.filter((x) => x !== p))}>
                    <PathPreview path={p} />
                  </Tile>
                ))}
                {files.map((f, i) => (
                  <Tile key={`${i}:${f.name}`} label={f.name} onRemove={() => setFiles((c) => c.filter((x) => x !== f))}>
                    <BlobPreview file={f} />
                  </Tile>
                ))}
              </div>
            ) : null}
            <textarea
              ref={ta}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              rows={1}
              aria-label={placeholder ?? t('composer.message', { name: bot?.name ?? 'Appu' })}
              placeholder={placeholder ?? t(running ? 'composer.tellMore' : 'composer.message', { name: bot?.name ?? 'Appu' })}
              className="block max-h-56 min-h-[1lh] w-full resize-none bg-transparent text-copy leading-[1.5] text-fg outline-none [field-sizing:content] placeholder:text-muted/50 placeholder:opacity-100"
            />
          </div>
          <div className="flex shrink-0 items-end gap-1">
          {/* talk to type: what you say goes into the draft (a group's room has its own speak-and-send button instead) */}
          {voice && !onVoiceText ? <DictateButton onText={insert} onActive={setDictating} /> : null}
          {/* while the bot works and nothing is typed: Stop (typing brings Send back, and that message reaches it mid-task) */}
          {onStop && !hasDraft ? (
            <Tooltip label={t('composer.stop')} side="top">
              <button type="button" aria-label={t('composer.stop')} onClick={onStop} className={ROUND}>
                <span aria-hidden className="block size-2.5 rounded-[2px] bg-current" />
              </button>
            </Tooltip>
          ) : running && !hasDraft && thread && !thread.id.startsWith('local:') ? (
            <Tooltip label={t('composer.stop')} side="top">
              <button
                type="button"
                aria-label={t('composer.stop')}
                onClick={() => void call('chat.cancel', { threadId: thread.id }, { errorTitle: t('composer.stopFailed') })}
               
                className={ROUND}
              >
                <span aria-hidden className="block size-2.5 rounded-[2px] bg-current" />
              </button>
            </Tooltip>
          ) : onVoiceText && voice && !hasDraft && !sending ? (
            <DictateButton round onText={onVoiceText} className={cn(ROUND, 'chat-round')} />
          ) : voiceSlot && bot ? (
            <Tooltip label={t('composer.voice')} side="top">
              <button type="button" aria-label={t('composer.voice')} onClick={() => startVoice(bot.id, thread?.id ?? null)} className={cn(ROUND, 'chat-round')}>
                <Icon icon={VoiceWave} size={16} />
              </button>
            </Tooltip>
          ) : dictating && !hasDraft ? null /* listening: its ✓ Done is the round button for now */ : (
            <button type="button" aria-label={t('composer.send')} disabled={!canSend} onClick={() => void send()} className={ROUND}>
              <Icon icon={ArrowUp} size={15} />
            </button>
          )}
          </div>
        </div>
      </div>
      {/* under the pill: nothing in a bot's chat since 2026-11-17 (COMPOSER_PICKERS): the permission mode, the model with
          its effort and the context ring live in the side panel's Bot tab (features/bots/BotPanel.tsx). A group's room
          keeps its own model picker here (`footer`). */}
      {/* with the row on, in a narrow chat: the mode's label truncates first, and the model picker drops its profile's
          name, its context size, then its effort, below this row's container widths, so the model's name stays */}
      {plain ? (footer ? <div className="@container mt-1 flex items-center justify-end gap-2 pr-1">{footer}</div> : null) : !COMPOSER_PICKERS ? null : (
        <div className="@container mt-1 flex items-center justify-between gap-2 pr-1 pl-0">
          <div className="flex min-w-0 items-center"><ModePicker thread={thread} /></div>
          <div className="flex max-w-[75%] min-w-0 shrink-0 items-center justify-end gap-1">
            <ThreadModelPicker thread={thread} />
            <ContextRing thread={thread} bot={bot} />
          </div>
        </div>
      )}
    </div>
  );
}
