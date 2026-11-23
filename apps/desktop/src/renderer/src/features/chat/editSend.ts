// "Edit" on a message that wasn't sent (UserMessage's SendState): it leaves the chat and its words, pictures and files
// go back into that chat's composer (Composer.tsx listens), so nothing typed is ever lost.
import { takeBackSend } from '../../lib/outbox';

export const EDIT_SEND_EVENT = 'appubot:editSend';
export interface EditSendRequest {
  threadId: string;
  text: string;
  images: { mimeType: string; data: string }[];
  files: File[];
}

export function editUnsent(localId: string): void {
  const q = takeBackSend(localId);
  if (!q) return;
  const detail: EditSendRequest = { threadId: q.threadId, text: q.text, images: q.images, files: q.blobs ?? [] };
  window.dispatchEvent(new CustomEvent(EDIT_SEND_EVENT, { detail }));
}
