// A sent message (after Synara's user bubble, MIT): right-aligned, in the bot's colour (chat-core `sentBubble`: a
// text-message chat with that bot), user-variant markdown in its ink, image
// thumbnails inside; copy and (i) (where it was sent from, the exact time: MessageActions) show on hover to the bubble's
// left. Under it only the bot's reaction and, for a routine's prompt, "Routine" (it reads as yours otherwise).
// In the Messages theme (lib/appearance.ts) the bubble is the theme's own (`Bubble`: neutral, a tail, the time and
// ticks inside) and the bot's reaction sits on its bottom edge.
import { memo, useEffect, useState } from 'react';
import type { Message, Part } from '@appubot/protocol';
import { AlertCircle, Bot as BotIcon, Clock, Repeat } from '../../components/ui/icons';
import { Icon } from '../../components/ui';
import { SENDING_QUIET_MS, sendLook, sentBubble, splitFileLines } from '@appubot/chat-core';
import { useStore } from '../../lib/store';
import { useMessagesTheme } from '../../lib/appearance';
import { Bubble } from './Bubble';
import { ChatMarkdown } from './Markdown';
import { MessageActions } from './MessageActions';
import { ReactionChip } from './Reactions';
import { FileTile, PathChip, imageSrc } from './MediaParts';
import { galleryProps, openGalleryAt } from './imageGallery';
import { useCloudFiles } from '../cloud/cloudClient';
import { VoiceNote, type VoicePart } from '../voice/VoiceNote';
import { MAC_KEY, discardSend, isLocalId, retrySend, useOutbox, type QueuedSend } from '../../lib/outbox';
import { editUnsent } from './editSend';

/** How a message still on its way looks now: sent as far as the eye can tell for its first second, then pending. */
function useSendLook(q: QueuedSend | undefined): 'quiet' | 'pending' | 'failed' | null {
  const [now, setNow] = useState(() => Date.now());
  const look = q ? sendLook(q.state, q.sentAt, now) : null;
  useEffect(() => {
    if (look !== 'quiet' || !q) return;
    const t = setTimeout(() => setNow(Date.now()), Math.max(0, q.sentAt + SENDING_QUIET_MS - Date.now()) + 20);
    return () => clearTimeout(t);
  }, [look, q?.sentAt]); // eslint-disable-line react-hooks/exhaustive-deps
  return look;
}

/** what a message waits on, in words (only shown once it has waited a second) */
function waitingText(q: QueuedSend): string {
  if (q.state === 'uploading') {
    const n = q.files?.length ?? 0;
    return n > 1 ? `Uploading ${Math.min((q.uploaded ?? 0) + 1, n)} of ${n}…` : 'Uploading…';
  }
  if (q.state === 'sending') return 'Sending…';
  if (isLocalId(q.threadId)) return 'Starting the chat…';
  return q.key === MAC_KEY ? 'Waiting for AppuBot…' : 'Waiting for your AppuBot computer…';
}

/** A file's line on a message still on its way: uploaded, uploading, or waiting its turn. */
function fileSending(q: QueuedSend, i: number): string {
  if (q.state === 'failed') return '';
  if (i < (q.uploaded ?? 0)) return 'Uploaded';
  return q.state === 'uploading' && i === (q.uploaded ?? 0) ? 'Uploading…' : '';
}

/** Under a message still on its way (lib/outbox.ts): a small clock once it has waited a second, or "Not sent". */
function SendState({ q, look }: { q: QueuedSend; look: 'quiet' | 'pending' | 'failed' }) {
  if (look === 'quiet') return null;
  if (look === 'pending') {
    return (
      <div className="flex h-6 items-center justify-end gap-1 pr-0.5 text-[11px] text-muted" role="status">
        <Icon icon={Clock} size={11} />{waitingText(q)}
      </div>
    );
  }
  return (
    <div className="flex min-h-6 items-center justify-end gap-2 pr-0.5 text-[11px] text-danger" role="alert" title={q.error}>
      <Icon icon={AlertCircle} size={12} />Not sent
      <button type="button" className="font-medium text-fg-2 underline-offset-2 hover:underline" onClick={() => retrySend(q.localId)}>Try again</button>
      <button type="button" className="text-muted underline-offset-2 hover:underline" onClick={() => editUnsent(q.localId)}>Edit</button>
      <button type="button" className="text-muted underline-offset-2 hover:underline" onClick={() => discardSend(q.localId)}>Delete</button>
    </div>
  );
}

/**
 * Your bubble: round all over, a text message's padding and type (a group room's are the same:
 * features/groups/GroupView.tsx); the fill and ink come from `sentBubble`, set as `backgroundColor` so the sheen over it
 * (index.css `.chat-bubble-sent`) stays.
 */
export const SENT_BUBBLE = 'chat-bubble-sent squircle w-max min-w-9 rounded-[18px] px-3 py-[7px] text-lead leading-5';

export const UserMessage = memo(function UserMessage({ msg, botName }: { msg: Message; botName?: string }) {
  // a cloud computer's pictures come through its channel: re-render once their bytes are here
  useCloudFiles((s) => s.rev);
  const botColor = useStore((s) => s.bots.find((b) => b.id === s.threads.find((t) => t.id === msg.threadId)?.botId)?.color);
  const bubble = sentBubble(botColor ?? '#8e8e93');
  const raw = msg.parts.map((p) => (p.type === 'text' ? p.text : '')).join('\n');
  const { body, paths } = splitFileLines(raw);
  const images = msg.parts.filter((p): p is Extract<Part, { type: 'image' }> => p.type === 'image');
  const files = msg.parts.filter((p): p is Extract<Part, { type: 'file' }> => p.type === 'file');
  const voices = msg.parts.filter((p): p is VoicePart => p.type === 'voice');
  const pending = useOutbox((s) => (isLocalId(msg.id) ? s.sends[msg.id] : undefined));
  const look = useSendLook(pending);
  const themed = useMessagesTheme();
  // the bubble's inside, the same in either theme
  const inside = (
    <>
      {images.length ? (
        <div className="mb-1.5 flex flex-wrap gap-1.5 last:mb-0">
          {images.map((im, i) => (
            <button key={i} type="button" aria-label="Open image" {...galleryProps(imageSrc(im))} onClick={openGalleryAt} className="cursor-zoom-in overflow-hidden rounded-control">
              <img src={imageSrc(im)} alt="" draggable={false} className="h-20 max-w-[180px] object-cover" />
            </button>
          ))}
        </div>
      ) : null}
      {paths.length ? <div className="mb-1.5 flex flex-wrap justify-end gap-1.5 last:mb-0">{paths.map((p) => <PathChip key={p} path={p} />)}</div> : null}
      {body ? <ChatMarkdown text={body} variant="user" /> : null}
    </>
  );
  const dimmed = look === 'pending' || look === 'failed';
  const reacted = msg.reactions?.some((r) => r.by === 'bot');
  const marked = msg.via === 'routine' || (msg.via === 'bot' && !!msg.from);

  return (
    // `data-image-gallery`: opening one of its images shows them all (imageGallery.ts)
    <div data-image-gallery className="flex w-full justify-end">
      <div className="group/msg flex max-w-[80%] min-w-0 flex-col items-end gap-px">
        {files.map((f, i) => <div key={f.file.id} className="mb-1"><FileTile file={f.file} sending={pending ? fileSending(pending, i) : undefined} /></div>)}
        {/* a spoken message: its recording over the words that were heard */}
        {voices.map((v) => (
          <VoiceNote key={v.file.id} part={v} color={botColor} className="mb-1" />
        ))}
        {body || images.length || paths.length ? (
          <div className="flex max-w-full min-w-0 items-center gap-1.5">
            <MessageActions text={raw} sent={msg} at={msg.createdAt} side="left" />
            {themed ? (
              <Bubble side="out" at={msg.createdAt} pending={!!pending} className={`w-max max-w-full transition-opacity ${dimmed ? 'opacity-70' : ''}`}>{inside}</Bubble>
            ) : (
              <div
                className={`${SENT_BUBBLE} max-w-full transition-opacity ${dimmed ? 'opacity-70' : ''}`}
                style={{ backgroundColor: bubble.fill, color: bubble.ink, '--ab-fg': bubble.ink, '--ab-link': bubble.ink } as React.CSSProperties}
              >
                {inside}
              </div>
            )}
          </div>
        ) : <MessageActions text={raw} sent={msg} at={msg.createdAt} side="left" />}
        {/* under the bubble, always shown: the bot's reaction, and "Routine" on a prompt a routine sent (you didn't type
            it, though it sits in your bubble); where any other message came from is in its (i) */}
        {reacted || marked ? (
          // Messages theme: the reaction rides the bubble's bottom edge, a line of its own only when there is more to say
          <div className={themed ? `chat-reaction-row chat-reaction-row--out text-[11px] text-muted ${reacted ? '' : 'mt-0! h-5'}` : 'flex h-6 items-center justify-end gap-2 pr-0.5 text-[11px] leading-[1.625] text-muted'}>
            {themed ? null : <ReactionChip msg={msg} by="bot" botName={botName} />}
            {msg.via === 'routine' ? <span className="inline-flex items-center gap-1"><Icon icon={Repeat} size={12} />Routine</span> : null}
            {/* another bot wrote it (message_bot, a group): it sits in your bubble, so say whose it is */}
            {msg.via === 'bot' && msg.from ? <span className="inline-flex items-center gap-1"><Icon icon={BotIcon} size={12} />From {msg.from.name}</span> : null}
            {themed ? <ReactionChip msg={msg} by="bot" botName={botName} /> : null}
          </div>
        ) : null}
        {pending && look ? <SendState q={pending} look={look} /> : null}
      </div>
    </div>
  );
});
