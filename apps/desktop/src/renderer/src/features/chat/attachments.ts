export interface PendingImage { id: string; mimeType: string; data: string; preview: string }

let n = 0;
export function readImage(file: Blob): Promise<PendingImage> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(r.error ?? new Error('Could not read image'));
    r.onload = () => {
      const url = String(r.result);
      const comma = url.indexOf(',');
      resolve({ id: `img${Date.now()}${n++}`, mimeType: file.type || 'image/png', data: url.slice(comma + 1), preview: url });
    };
    r.readAsDataURL(file);
  });
}

/** Desktop attachments are passed as absolute paths in the prompt (the agent can read local files). */
export function withFileLines(text: string, paths: string[]): string {
  if (!paths.length) return text;
  return `${text.trim()}\n\n${paths.map((p) => `Files: ${p}`).join('\n')}`.trim();
}

/** Drafts survive thread switches. */
export const drafts = new Map<string, string>();
