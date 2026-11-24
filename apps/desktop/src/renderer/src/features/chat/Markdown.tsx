// Chat markdown (adapted from Synara's ChatMarkdown, MIT): safe GFM (no raw HTML), Shiki code blocks in Rare UI's
// frame (components/rare/CodeBlock.tsx: language label, line numbers, soft wrap, copy), ```mermaid drawn as diagrams (MermaidDiagram.tsx), GitHub alerts, task lists, links through the
// OS browser, images that open the message's gallery (imageGallery.ts), and LaTeX maths through KaTeX when
// Settings › Appearance's "Render math" is on. Styles: `.chat-markdown` in index.css.
import { createContext, memo, useContext, useDeferredValue, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactElement, type ReactNode } from 'react';
import { MemoryLru, contentHash } from '../../lib/lruStore';
import ReactMarkdown, { type Components, type Options } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { AlertCircle, AlertTriangle, Check, Code, Copy, Info, Lightbulb, ShieldAlert, WrapText, type IconComponent } from '../../components/ui/icons';
import { CachedImg, Icon, cn } from '../../components/ui';
import { useAppearancePrefs } from '../../lib/appearance';
import { native } from '../../lib/native';
import { MENTION_HREF, normalizeMathDelimiters, repairMarkdownTableDelimiters, streamingCodeHighlightIntervalMs } from '@appubot/chat-core';
import { MentionChip } from './MentionChip';
import { useSmoothStreamedText, useThrottledStreamingValue } from '../../lib/streaming';
import { cachedHighlight, highlight, resolveLang } from './highlight';
import { remarkAlerts, type AlertKind } from './remarkAlerts';
import { MermaidSvg, useMermaid } from './MermaidDiagram';
import { galleryProps, openGalleryAt } from './imageGallery';
import { CodeFrame, CodeHeaderButton } from '../../components/rare/CodeBlock';

export function CopyButton({ text, className, label = 'Copy', iconOnly }: { text: string; className?: string; label?: string; iconOnly?: boolean }) {
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = () => {
    void navigator.clipboard.writeText(text).then(() => {
      setDone(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setDone(false), 1200);
    });
  };
  return (
    <button
      type="button"
      onClick={copy}
      aria-label={done ? 'Copied' : label}
      title={done ? 'Copied' : label}
      className={cn('ab-pill inline-flex items-center gap-1 rounded-md text-muted transition-colors hover:text-fg', iconOnly ? 'size-6 justify-center' : 'px-1.5 py-1 text-note', className)}
    >
      <Icon icon={done ? Check : Copy} size={iconOnly ? 12 : 14} />
      {iconOnly ? null : done ? 'Copied' : label}
    </button>
  );
}

/** Whether the markdown around a code block is still streaming (code blocks throttle re-highlighting). */
const StreamingCtx = createContext(false);

interface HastNode { type: string; value?: string; tagName?: string; properties?: Record<string, unknown>; children?: HastNode[] }
const hastText = (n: HastNode | undefined): string => (!n ? '' : n.type === 'text' ? (n.value ?? '') : (n.children ?? []).map(hastText).join(''));

function ShikiCode({ code: liveCode, lang }: { code: string; lang: string | null }) {
  const streaming = useContext(StreamingCtx);
  // while streaming, re-tokenize the growing block at a cadence that stretches with its length (Synara)
  const code = useThrottledStreamingValue(liveCode, streaming, streamingCodeHighlightIntervalMs(liveCode.length));
  const [html, setHtml] = useState<string | null>(() => (lang ? (cachedHighlight(code, lang) ?? null) : null));

  useEffect(() => {
    if (!lang) { setHtml(null); return; }
    const hit = cachedHighlight(code, lang);
    if (hit) { setHtml(hit); return; }
    let alive = true;
    const gone = new AbortController();
    void highlight(code, lang, gone.signal).then((h) => { if (alive && h) setHtml(h); });
    return () => { alive = false; gone.abort(); };
  }, [code, lang]);

  if (html) return <div className="chat-markdown-shiki" dangerouslySetInnerHTML={{ __html: html }} />;
  // not highlighted (yet, or a language Shiki wasn't given): the same shape, so the gutter and wrapping still apply
  const lines = code.split('\n');
  return <pre className="shiki"><code>{lines.map((l, i) => <span key={i}><span className="line">{l}</span>{i < lines.length - 1 ? '\n' : null}</span>)}</code></pre>;
}

function CodeBlock({ node }: { node?: HastNode }) {
  const codeEl = node?.children?.find((c) => c.tagName === 'code');
  const classes = codeEl?.properties?.className;
  const cls = Array.isArray(classes) ? classes.map(String) : typeof classes === 'string' ? [classes] : [];
  const fence = cls.find((c) => c.startsWith('language-'))?.slice('language-'.length);
  const code = hastText(codeEl ?? node).replace(/\n$/, '');
  const [wrap, setWrap] = useState(false);
  // ```mermaid draws as a diagram once the reply stops streaming; until then, or if it can't be drawn, it's code
  const streaming = useContext(StreamingCtx);
  const diagram = useMermaid(code, fence?.toLowerCase() === 'mermaid' && !streaming);
  const [source, setSource] = useState(false);
  const drawn = diagram?.ok && !source ? diagram.svg : null;
  return (
    <CodeFrame
      code={code}
      label={fence || 'text'}
      wrap={wrap}
      // a drawn diagram isn't lines of code
      showLineNumbers={!drawn}
      className="chat-markdown-codeblock"
      actions={(
        <>
          {diagram?.ok ? (
            <CodeHeaderButton pressed={source} onClick={() => setSource((s) => !s)} aria-label={source ? 'Show diagram' : 'Show source'}>
              <Icon icon={Code} size={14} />
            </CodeHeaderButton>
          ) : null}
          {drawn ? null : (
            <CodeHeaderButton pressed={wrap} onClick={() => setWrap((w) => !w)} aria-label={wrap ? 'Disable soft wrap' : 'Enable soft wrap'}>
              <Icon icon={WrapText} size={14} />
            </CodeHeaderButton>
          )}
        </>
      )}
      footer={diagram && !diagram.ok ? <p className="chat-markdown-codeblock__note" title={diagram.error}>Couldn’t draw this diagram</p> : null}
    >
      {drawn ? <MermaidSvg svg={drawn} /> : <ShikiCode code={code} lang={resolveLang(fence)} />}
    </CodeFrame>
  );
}

const ALERTS: Record<AlertKind, { label: string; icon: IconComponent }> = {
  note: { label: 'Note', icon: Info },
  tip: { label: 'Tip', icon: Lightbulb },
  important: { label: 'Important', icon: AlertCircle },
  warning: { label: 'Warning', icon: AlertTriangle },
  caution: { label: 'Caution', icon: ShieldAlert },
};

function Blockquote({ node, children, ...rest }: { node?: HastNode; children?: ReactNode } & Record<string, unknown>) {
  const kind = (rest['data-github-alert'] ?? node?.properties?.['data-github-alert'] ?? node?.properties?.dataGithubAlert) as AlertKind | undefined;
  const alert = kind ? ALERTS[kind] : undefined;
  if (!alert) return <blockquote>{children}</blockquote>;
  return (
    <blockquote data-github-alert={kind}>
      <p className="markdown-alert-title"><Icon icon={alert.icon} size={15} />{alert.label}</p>
      {children}
    </blockquote>
  );
}

const components: Components = {
  // a group message's @Name (chat-core linkMentions): the bot's chip
  a: ({ href, children }) => (href?.startsWith(MENTION_HREF) ? <MentionChip id={href.slice(MENTION_HREF.length)} fallback={children} /> : (
    <a
      href={href}
      title={href}
      onClick={(e) => { e.preventDefault(); if (href && /^(https?:|mailto:)/.test(href)) void native().openExternal(href); }}
    >
      {children}
    </a>
  )),
  pre: ({ node }) => <CodeBlock node={node as HastNode | undefined} />,
  blockquote: ({ node, children, ...rest }) => <Blockquote node={node as HastNode | undefined} {...rest}>{children}</Blockquote>,
  table: ({ children }) => <div className="chat-markdown-table"><table>{children}</table></div>,
  input: ({ type, checked }) => (type === 'checkbox' ? <input type="checkbox" checked={!!checked} readOnly disabled className="chat-markdown-task-checkbox" /> : null),
  // opens the message's image gallery (one inside a link opens the link instead)
  img: ({ src, alt, title }) => (typeof src === 'string' && /^(https?:|data:image\/)/.test(src)
    ? <CachedImg src={src} alt={alt ?? ''} title={title} {...galleryProps(src, alt || title)} onClick={openGalleryAt} />
    : null),
};

const remarkPlugins = [remarkGfm, remarkAlerts];
// $x^2$, $$…$$, \(…\) and \[…\] typeset as maths, made $$ first by chat-core `normalizeMathDelimiters` (a lone $ is a
// price, never maths); KaTeX's own errors show in place rather than throwing.
// KaTeX (~250 KB, plus its CSS) is a chunk of its own: loaded in a quiet moment after launch, or at once when a text
// with maths shows up before that. Only a text with `$$` in it can hold maths (remark-math reads nothing else here),
// so every other text goes through the plain plugins, which also parse quicker.
interface MathPlugins { remark: Options['remarkPlugins']; rehype: Options['rehypePlugins'] }
let mathPlugins: MathPlugins | null = null;
let mathLoading: Promise<void> | null = null;
const mathListeners = new Set<() => void>();
export function loadMath(): Promise<void> {
  mathLoading ??= Promise.all([import('remark-math'), import('rehype-katex'), import('katex/dist/katex.min.css')])
    .then(([remarkMath, rehypeKatex]) => {
      mathPlugins = {
        remark: [remarkGfm, [remarkMath.default, { singleDollarTextMath: false }], remarkAlerts],
        rehype: [[rehypeKatex.default, { throwOnError: false, strict: false }]],
      };
      for (const l of mathListeners) l();
    })
    .catch(() => { mathLoading = null; });
  return mathLoading;
}
const hasMath = (text: string) => text.includes('$$');
/** Whether KaTeX is here; a component reading it draws again when it comes. */
function useMathLoaded(wanted: boolean): boolean {
  const loaded = useSyncExternalStore((cb) => { mathListeners.add(cb); return () => { mathListeners.delete(cb); }; }, () => !!mathPlugins);
  useEffect(() => { if (wanted && !loaded) void loadMath(); }, [wanted, loaded]);
  return loaded;
}

export type MarkdownVariant = 'assistant' | 'user' | 'muted';

/**
 * Finished messages' markdown, parsed once a run: the element tree react-markdown makes (remark, rehype, KaTeX) for a
 * text, by its content hash and whether maths is on, so a chat opened again (or a message scrolled back into the
 * list) skips the parse; its code blocks find their highlighting in highlight.ts's cache and paint highlighted in the
 * first frame, and Mermaid diagrams in MermaidDiagram's. Streaming text is never kept (it changes every frame).
 */
const TREES_MAX = 600;
const trees = new MemoryLru<ReactElement>(TREES_MAX);

/**
 * The tree for a finished text: parsed now on a miss, the kept one on a hit. With maths on, a text holding some is
 * typeset once KaTeX is here; until then it reads as written and isn't kept (it is parsed again once KaTeX comes).
 */
export function markdownTree(text: string, math: boolean): ReactElement {
  const typeset = math && hasMath(text);
  const key = `${typeset ? 'm' : 'p'}:${contentHash(text)}`;
  const hit = trees.get(key);
  if (hit) return hit;
  if (typeset && !mathPlugins) return ReactMarkdown({ children: text, remarkPlugins, components });
  const tree = typeset && mathPlugins
    ? ReactMarkdown({ children: text, remarkPlugins: mathPlugins.remark, rehypePlugins: mathPlugins.rehype, components })
    : ReactMarkdown({ children: text, remarkPlugins, components });
  trees.set(key, tree);
  return tree;
}

/**
 * Chat markdown. While `streaming`, text is revealed at Synara's steady adaptive cadence (not in network clumps),
 * the markdown re-parse is deferred/coalesced by React, and code blocks re-highlight on a throttle.
 */
export const ChatMarkdown = memo(function ChatMarkdown({ text, streaming, variant = 'assistant', className }: {
  text: string; streaming?: boolean; variant?: MarkdownVariant; className?: string;
}) {
  const isStreaming = !!streaming;
  const math = useAppearancePrefs().math;
  const smoothed = useSmoothStreamedText(text, isStreaming);
  // the user's own text stays byte-for-byte what they typed
  const normalized = useMemo(() => {
    const text = variant === 'user' ? smoothed : repairMarkdownTableDelimiters(smoothed);
    return math ? normalizeMathDelimiters(text) : text;
  }, [variant, smoothed, math]);
  const deferred = useDeferredValue(normalized);
  const rendered = isStreaming ? deferred : normalized;
  const typeset = math && hasMath(rendered);
  const mathLoaded = useMathLoaded(typeset);
  // a finished text's tree is parsed once a run (`markdownTree`)
  const tree = useMemo(() => (isStreaming ? null : markdownTree(normalized, math)), [isStreaming, normalized, math, mathLoaded]);
  return (
    <div className={cn('chat-markdown selectable', variant === 'user' && 'chat-markdown--user', variant === 'muted' && 'chat-markdown--muted', isStreaming && 'is-streaming', className)}>
      <StreamingCtx.Provider value={isStreaming}>
        {isStreaming ? (
          typeset && mathPlugins ? (
            <ReactMarkdown remarkPlugins={mathPlugins.remark} rehypePlugins={mathPlugins.rehype} components={components}>{rendered}</ReactMarkdown>
          ) : (
            <ReactMarkdown remarkPlugins={remarkPlugins} components={components}>{rendered}</ReactMarkdown>
          )
        ) : tree}
      </StreamingCtx.Provider>
    </div>
  );
});

