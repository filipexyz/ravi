import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalStatePath, hasRuntimeInvocationEnv, isOperatorCliOnRealState } from "../db/state-boundary.js";
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

/**
 * Whether this is the installed CLI in the operator's terminal, using real
 * state. Such a CLI runs its commands in this process, against real state it
 * may open but never prepares (`db/state-boundary.ts`); it is not sent to the
 * daemon's gateway. This only says which commands must work with no database
 * at all (recovery, the credential file); it grants no access by itself.
 */
export function isInstalledOperatorOnRealState(
  env: NodeJS.ProcessEnv = process.env,
  options: { modulePath?: string; homeDir?: string; runtimeInvocation?: boolean } = {},
): boolean {
  if (hasRuntimeInvocationEnv(env)) return false;
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

/**
 * Whether the commands that must work with no database get that path: the
 * operator's installed CLI on real state, by the provenance check above or as
 * the state boundary sees it. The two differ when `HOME` is not the account's
 * home, when the account lookup is unavailable and when the selected state
 * directory sits inside `~/.ravi`; whenever the boundary lets this CLI into
 * real state, recovery must not depend on that state being prepared.
 */
export function usesOperatorRecoveryPath(): boolean {
  return isInstalledOperatorOnRealState() || isOperatorCliOnRealState();
}

export function isLocalRecoveryCommand(group: string, command: string): boolean {
  return RECOVERY_COMMANDS.has(`${group} ${command}`);
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
