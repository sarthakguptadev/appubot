import { z } from 'zod';
import { Id, Timestamp } from './entities';

/**
 * Custom models (Settings › Agents › Add custom › Models): model servers the user runs or has an account with, given to
 * OpenCode as providers of its own (`OPENCODE_CONFIG_CONTENT`), so their models show in OpenCode's model picker.
 * Ollama and LM Studio are OpenAI-compatible servers on this computer; any other server with the OpenAI chat API works
 * too. An endpoint's API key stays on this computer (`model-endpoints.json`, this user's only), never on the wire.
 */

export const EndpointKind = z.enum(['ollama', 'lmstudio', 'openai']);
export type EndpointKind = z.infer<typeof EndpointKind>;

/** What each kind starts with: the name and the server's OpenAI-compatible address. */
export const ENDPOINT_PRESETS: Record<EndpointKind, { name: string; baseUrl: string; needsKey: boolean }> = {
  ollama: { name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', needsKey: false },
  lmstudio: { name: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1', needsKey: false },
  openai: { name: '', baseUrl: '', needsKey: false },
};

export const ModelEndpointSchema = z.object({
  id: Id,
  kind: EndpointKind,
  name: z.string().min(1).max(40),
  /** the server's OpenAI-compatible base address, `/v1` included (`http://127.0.0.1:11434/v1`) */
  baseUrl: z.string(),
  /** the models offered to OpenCode, as the server names them */
  models: z.array(z.string()),
  /** whether an API key is saved for it (the key itself never leaves the computer's files) */
  keySaved: z.boolean(),
  /** how OpenCode knows it: its models show as `<providerKey>/<model>` */
  providerKey: z.string(),
  createdAt: Timestamp,
});
export type ModelEndpoint = z.infer<typeof ModelEndpointSchema>;
