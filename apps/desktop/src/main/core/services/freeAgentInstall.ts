/**
 * Installing OpenCode by itself (the free agent, protocol `freeModels.ts`), on a person's own computer and on an
 * AppuBot Cloud one, with nothing else needed there: no Node, no npm, no Homebrew, no terminal. OpenCode 2 ships as
 * one program per platform in npm packages (`@opencode/cli-<os>-<arch>`); `nativeInstall.ts` downloads, checks,
 * unpacks and links it into `<dataDir>/free-agent/<version>/`, as it does Codex and Copilot. OpenCode's own
 * `install` script and the `opencode-ai` package only install OpenCode 1. An OpenCode the person installed themselves
 * is found first and nothing here runs (`FreeAgentService` only installs where none is found).
 */
import { agentBuild, installNativeAgent, linkFor, programIn, type NativeInstallOptions, type NativeInstallResult } from './nativeInstall';

export { openCodePackage, packageUrl, readPackageRecord, type PackageRecord } from './nativeInstall';

export type FreeAgentInstallOptions = NativeInstallOptions;
export type FreeAgentInstallResult = NativeInstallResult;

/** the program inside an unpacked version folder */
export const binaryIn = (versionDir: string, platform: NodeJS.Platform = process.platform): string =>
  programIn(versionDir, { bin: platform === 'win32' ? 'bin/opencode.exe' : 'bin/opencode' });
/** the link the runtime finds */
export const linkPath = (home: string, platform: NodeJS.Platform = process.platform): string => linkFor(home, 'opencode', platform);

/** Download, check, unpack and link OpenCode. Never throws: a failure says why in `output`. */
export async function installFreeAgent(o: FreeAgentInstallOptions): Promise<FreeAgentInstallResult> {
  if (!agentBuild('opencode', o.platform ?? process.platform, o.arch ?? process.arch)) {
    return { ok: false, output: `OpenCode has no build for this computer (${o.platform ?? process.platform} ${o.arch ?? process.arch}).` };
  }
  return installNativeAgent('opencode', o);
}
