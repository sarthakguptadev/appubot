// GitHub `> [!NOTE]` alerts for chat markdown (adapted from Synara's remarkGithubAlerts, MIT).
// remark-gfm leaves the marker as plain text, so tag the blockquote for the renderer and strip it.

export const ALERT_KINDS = ['note', 'tip', 'important', 'warning', 'caution'] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  data?: { hProperties?: Record<string, unknown> } & Record<string, unknown>;
}

const MARKER = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(?:\r?\n|$)/i;

function tag(node: MdNode): void {
  const para = node.children?.[0];
  if (para?.type !== 'paragraph' || !para.children) return;
  const text = para.children[0];
  if (text?.type !== 'text' || typeof text.value !== 'string') return;
  const m = MARKER.exec(text.value);
  if (!m) return;
  // "[!NOTE]" followed by inline content on the same line is not an alert, unless a hard break follows
  if (!m[0].endsWith('\n') && m[0].length === text.value.length && para.children.length > 1) {
    if (para.children[1]?.type !== 'break') return;
    para.children.splice(1, 1);
  }
  text.value = text.value.slice(m[0].length);
  if (!text.value) para.children.shift();
  if (!para.children.length) node.children!.shift();
  node.data = { ...node.data, hProperties: { ...node.data?.hProperties, 'data-github-alert': m[1]!.toLowerCase() } };
}

function visit(node: MdNode): void {
  for (const child of node.children ?? []) {
    if (child.type === 'blockquote') tag(child);
    if (child.children) visit(child);
  }
}

export function remarkAlerts() {
  return (tree: MdNode) => visit(tree);
}
