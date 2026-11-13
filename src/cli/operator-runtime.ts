import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalStatePath } from "../db/state-boundary.js";
import { findRaviPackageRoot } from "../managed-runtime.js";
import { resolveAccountHome } from "../utils/account-home.js";
import { getContext, hasRuntimeInvocationContext, type ToolContext } from "./context.js";

const codePath = fileURLToPath(import.meta.url);
const RECOVERY_COMMANDS = new Set([
  "daemon start",
  "daemon stop",
  "daemon restart",
  "daemon status",
  "daemon logs",
  "channels start",
  "channels stop",
  "channels restart",
  "channels status",
  "channels logs",
]);

/** Selects transport only; it never grants access to a database or a gateway. */
export function usesInstalledOperatorTransport(
  env: NodeJS.ProcessEnv = process.env,
  options: { modulePath?: string; homeDir?: string; runtimeInvocation?: boolean } = {},
): boolean {
  if (
    env.RAVI_CONTEXT_KEY?.trim() ||
    env.RAVI_GATEWAY_URL?.trim() ||
    env.RAVI_SESSION_KEY?.trim() ||
    env.RAVI_SESSION_NAME?.trim() ||
    env.RAVI_AGENT_ID?.trim()
  )
    return false;
  if (options.runtimeInvocation ?? (hasRuntimeInvocationContext() || getContext({ localOnly: true }) !== undefined))
    return false;
  const root = findRaviPackageRoot(options.modulePath ?? codePath);
  if (!root || existsSync(join(root, "src")) || existsSync(join(root, ".git"))) return false;
  const home = options.homeDir ?? resolveAccountHome();
  if (!home) return false;
  const selectedHome = env.HOME || options.homeDir || homedir();
  const state = env.RAVI_STATE_DIR || join(selectedHome, ".ravi");
  return canonicalStatePath(state) === canonicalStatePath(join(home, ".ravi"));
}

export function isLocalRecoveryCommand(group: string, command: string): boolean {
  return RECOVERY_COMMANDS.has(`${group} ${command}`);
}

export function isManagedRuntimeEntry(group: string, command: string): boolean {
  return command === "run" && (group === "daemon" || group === "channels");
}

const LOCAL_CREDENTIAL_COMMANDS = new Set(["list", "add", "set-default", "remove"]);
const localCredentialContexts = new WeakSet<ToolContext>();

export function isLocalCredentialCommand(group: string, command: string): boolean {
  return group === "context_credentials" && LOCAL_CREDENTIAL_COMMANDS.has(command);
}

/** Called only after installed operator provenance was verified by the registry.
 * Object identity, never an env/metadata flag, carries the selected transport.
 * The empty context also prevents resolving the default credential in local SQLite.
 */
export function createLocalCredentialOperatorContext(): ToolContext {
  const context: ToolContext = {};
  localCredentialContexts.add(context);
  return context;
}

export function isLocalCredentialOperatorContext(): boolean {
  const context = getContext({ localOnly: true });
  return context !== undefined && localCredentialContexts.has(context);
}
