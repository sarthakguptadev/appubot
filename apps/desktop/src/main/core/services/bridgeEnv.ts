/** Builds the stdio MCP server spec the ACP agent launches: the AppuBot MCP bridge (bridge.mjs). */
import type { McpServerStdio } from '@appubot/agent-runtime';

export interface BridgeOptions {
  bridgePath: string;
  port: number;
  token: string;
  threadId: string;
  botId: string;
  botName: string;
  computerUse: boolean;
  /** the bot may use connected apps (Composio): the bridge offers its apps tools */
  apps?: boolean;
  /** the bot may use some custom connector's tools: the bridge offers them (`APPUBOT_CONNECTORS=1`) */
  connectors?: boolean;
  /** one of the user's own computers lends this one its files: the bridge offers the `mac_files_*` tools (`APPUBOT_MAC_FILES`: its name) */
  macFiles?: string;
  /** an AppuBot Cloud computer: the computer tools name the apps its image has (`APPUBOT_CLOUD=1`) */
  cloud?: boolean;
  launcher?: { command: string; env: Record<string, string> };
}

export function defaultBridgeLauncher(): { command: string; env: Record<string, string> } {
  return { command: process.execPath, env: process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {} };
}

export function buildBridgeServer(o: BridgeOptions): McpServerStdio {
  const launcher = o.launcher ?? defaultBridgeLauncher();
  return {
    name: 'appubot',
    command: launcher.command,
    args: [o.bridgePath],
    env: {
      ...launcher.env,
      APPUBOT_GATEWAY_URL: `http://127.0.0.1:${o.port}`,
      APPUBOT_TOKEN: o.token,
      APPUBOT_THREAD_ID: o.threadId,
      APPUBOT_BOT_ID: o.botId,
      APPUBOT_BOT_NAME: o.botName,
      APPUBOT_COMPUTER_USE: o.computerUse ? '1' : '0',
      APPUBOT_APPS: o.apps ? '1' : '0',
      ...(o.connectors ? { APPUBOT_CONNECTORS: '1' } : {}),
      ...(o.cloud ? { APPUBOT_CLOUD: '1' } : {}),
      ...(o.macFiles ? { APPUBOT_MAC_FILES: o.macFiles } : {}),
    },
  };
}
