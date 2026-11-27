// The answers view's working row, in plain words: what the bot is doing right now, from the newest thing its turn holds.
// It names no tool and shows no command (the owner's call, 2026-11-15, on seeing "Running nohup google-chrome --no-…"
// beside the bot): a command is "Running a command", a file or a site goes by its name, an app by its own name.
import type { Part } from '@appubot/protocol';
import { basename, truncate } from './format';
import { commandReadTargets, rawCommand, sentenceText, toolPaths, type ToolCallPart } from './toolText';
import { bridgeTool, trailSentence, workCategory } from './workTrail';

/** The longest a step's label runs before it is cut ("Reading quarterly-travel-spend-by-person…"). */
const MAX = 48;

const named = (verb: string, names: string[], fallback: string) => (names.length ? truncate(`${verb} ${names.join(', ')}`, MAX) : fallback);

function hostOf(url: string): string | undefined {
  try { return new URL(url).hostname.replace(/^www\./, '') || undefined; } catch { return undefined; }
}

/** One call as the step it is, or undefined when there are no plain words for it (the row then says "Working"). */
export function stepLabel(t: ToolCallPart): string | undefined {
  const r = t.rawInput && typeof t.rawInput === 'object' ? (t.rawInput as Record<string, unknown>) : {};
  const str = (k: string) => (typeof r[k] === 'string' && (r[k] as string).trim() ? (r[k] as string).trim() : undefined);
  const files = toolPaths(t).map(basename);
  const bridge = bridgeTool(t.title);
  if (bridge) {
    if (bridge.startsWith('computer_')) return 'Using the computer';
    const s = trailSentence(t, true);
    // the bridge tools without words of their own read as their raw name ("Using some tool"): none here
    return s.verb === `Using ${bridge.replace(/_/g, ' ')}` ? undefined : truncate(sentenceText(s), MAX);
  }
  switch (t.kind) {
    case 'read': return named('Reading', files, 'Reading a file');
    case 'edit': return named('Editing', files, 'Editing a file');
    case 'delete': return named('Deleting', files, 'Deleting a file');
    case 'move': return named('Moving', files, 'Moving a file');
    case 'search': return 'Searching your files';
    case 'execute': {
      const reads = commandReadTargets(rawCommand(t.rawInput) ?? t.title);
      return reads ? named('Reading', reads.map(basename), 'Reading a file') : 'Running a command';
    }
    case 'fetch': {
      const host = str('url') ? hostOf(str('url')!) : undefined;
      if (host) return truncate(`Reading ${host}`, MAX);
      return str('query') ? truncate(`Searching the web for “${str('query')}”`, MAX) : 'Searching the web';
    }
    case 'computer': return 'Using the computer';
    default: break;
  }
  switch (workCategory(t)) {
    case 'agent': return 'Working on part of it';
    case 'ask': return 'Asking you';
    case 'send': return 'Sending you a message';
    case 'memory': return 'Checking its memory';
    default: return t.kind === 'think' ? 'Thinking' : undefined;
  }
}

/**
 * What a live turn is doing now: "Typing…" once its reply is coming in after its last call, "Thinking" over a thought,
 * else its newest call's step. Undefined before anything has happened, or when the step has no plain words.
 */
export function liveStepLabel(parts: readonly Part[]): string | undefined {
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i]!;
    if (p.type === 'text') {
      // a message the bot sent on its own (`said`) is a bubble along the way, not its reply
      if (p.said || !p.text.trim()) continue;
      return 'Typing…';
    }
    if (p.type === 'thought') return 'Thinking';
    if (p.type === 'tool_call') return stepLabel(p);
  }
  return undefined;
}
