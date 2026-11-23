/** Dev-only: a few ACP registry entries for the mock gateway's Settings › Agents › More agents. */
import type { FoundProfile, RegistryAgent } from '@appubot/protocol';

const svg = (d: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path fill="currentColor" d="${d}"/></svg>`;
const STAR = svg('M8 0q0 4 2 6t6 2q-4 0-6 2t-2 6q0-4-2-6T0 8q4 0 6-2t2-6');
const RING = svg('M8 1a7 7 0 1 1 0 14A7 7 0 0 1 8 1m0 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8');
const BOLT = svg('M9 0 2 9h5l-1 7 7-9H8z');

export const MOCK_REGISTRY: RegistryAgent[] = [
  { id: 'gemini', name: 'Gemini CLI', version: '0.64.0', description: "Google's official CLI for Gemini", website: 'https://geminicli.com', iconSvg: STAR, install: 'npx' },
  { id: 'goose', name: 'goose', version: '1.12.0', description: 'A local, extensible, open source AI agent that automates engineering tasks', iconSvg: RING, install: 'binary', providerId: 'goose', installedVersion: '1.11.2' },
  { id: 'amp-acp', name: 'Amp', version: '0.10.0', description: 'ACP wrapper for Amp - the frontier coding agent', repository: 'https://github.com/tao12345666333/amp-acp', iconSvg: BOLT, install: 'binary' },
  { id: 'qwen-code', name: 'Qwen Code', version: '0.25.1', description: "Alibaba's Qwen coding agent", install: 'npx' },
  { id: 'fast-agent', name: 'fast-agent', version: '0.10.1', description: 'Code and build agents with comprehensive multi-provider support', install: 'uvx' },
  { id: 'claude-acp', name: 'Claude Agent', version: '0.90.0', description: 'ACP wrapper for Anthropic\'s Claude', install: 'npx', builtinId: 'claude-code' },
];

/** Synara's Claude profiles and a `~/.claude-work`, as `providers.profiles` finds them on a Mac that has them */
export const MOCK_FOUND_PROFILES: FoundProfile[] = [
  { of: 'claude-code', name: 'sarthakfour', source: 'synara', home: '/Users/sarthak/.synara/userdata/provider-homes/claude/instance-636c617564655f7361727468616b666f7572/.claude' },
  { of: 'claude-code', name: 'sarthakthree', source: 'synara', home: '/Users/sarthak/.synara/userdata/provider-homes/claude/instance-636c617564655f7361727468616b7468726565/.claude' },
  { of: 'claude-code', name: 'work', source: 'folder', home: '/Users/sarthak/.claude-work' },
];
