/**
 * Picking an answer among a permission request's options. AppuBot has no approval rules of its own for what a bot does
 * on the Mac: the agent's permission mode decides what it asks, and every ask waits for the user. The exceptions are
 * AppuBot's own tools for talking with the user and managing bots (`OWN_TOOLS`: an approval for "Ask you" or a 👍
 * would only get in the way; what gives a bot more power waits for the user's "Allow" inside update_bot/create_bot),
 * finding app tools and reading their inputs (`apps_search`, `apps_tool_schemas`: running them, `apps_execute`, asks
 * like any action), the Vault's tools (`vault_fill`/`vault_key` ask the user's "Allow" themselves, the first time an
 * item is used in a chat), and, while a new bot sets itself up (its first, quiet turn), saving a skill too (`SETUP_TOOLS`).
 */
import type { PermissionRequest } from '@appubot/protocol';

type Option = PermissionRequest['options'][number];

export function pickOption(options: Option[], kinds: Option['kind'][]): string | undefined {
  for (const k of kinds) {
    const o = options.find((x) => x.kind === k);
    if (o) return o.optionId;
  }
  return undefined;
}

export const pickReject = (options: Option[]): string | undefined => pickOption(options, ['reject_once', 'reject_always']);

export const pickAllowOnce = (options: Option[]): string | undefined => pickOption(options, ['allow_once', 'allow_always']);

/**
 * AppuBot's own tools a new bot uses to set itself up (ChatService.greet's turn): asking the user, its memory, its own
 * settings and skills. Nothing that touches the Mac beyond the bot's own folder; another bot's settings still wait for
 * the user's "Allow" inside `update_bot` itself.
 */
const OWN_TOOLS = new Set(['apps_search', 'apps_tool_schemas', 'ask_user', 'ask_form', 'vault_request', 'apps_request', 'telegram_request', 'send_message', 'show_page', 'send_voice', 'transcribe_audio', 'react', 'remember', 'update_memory', 'forget', 'read_memory', 'list_bots', 'get_bot', 'update_bot', 'create_bot', 'read_bot_history', 'list_routines', 'create_routine', 'update_routine', 'delete_routine', 'message_bot', 'message_bots', 'list_groups', 'post_to_group', 'create_group', 'start_goal', 'finish_goal', 'vault_list', 'vault_fill', 'vault_key']);
const SETUP_TOOLS = new Set([...OWN_TOOLS, 'save_skill']);

/** The bridge tool a permission request is for (`mcp__appubot__ask_user`, `appubot.ask_user`, Cursor's `appubot-ask_user: ask_user`…), if it is one. */
export function bridgeTool(title: string): string | undefined {
  return /^(?:mcp__appubot__|appubot[./:-]|appubot__)([a-z_]+)(?::\s*[a-z_]+)?$/.exec(title.trim())?.[1];
}

/** `tool`: the bridge tool's own name (`ask_user`, PermissionAsk.bridgeTool) or a raw tool title (`mcp__appubot__ask_user`). */
export const isSetupTool = (tool: string): boolean => SETUP_TOOLS.has(bridgeTool(tool) ?? tool);
/** AppuBot's own conversational and bot-managing tools, approved without asking (see above). */
export const isOwnTool = (tool: string): boolean => OWN_TOOLS.has(bridgeTool(tool) ?? tool);
/** Bridge tools that act in the user's accounts (sending, posting, deleting through their apps): never approved for them on "Approve for me". */
export const actsInAccounts = (tool: string): boolean => (bridgeTool(tool) ?? tool) === 'apps_execute';
