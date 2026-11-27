/** One literal app invocation may cross a held turn's sandbox; this never grants shell authority. */
import { realpathSync } from "node:fs";
import { basename, resolve } from "node:path";
import { parse as parseShell } from "shell-quote";
import { checkExecutablePath } from "../bash/executable-path.js";
import { parseBashCommand } from "../bash/parser.js";
import { isTurnHeldBelowAgent } from "../permissions/actor-limit.js";
import { canWithCapabilityContext } from "../permissions/provider-runtime.js";
import type { ContextRecord } from "../router/router-db.js";
import { discoverAppManifests, getAppManifest } from "./service.js";
import { storeExposureFor } from "./store/gate.js";
import { isAppTrusted } from "./trust.js";
import type { RaviAppManifestRecord } from "./types.js";

export interface RestrictedAppOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Host-owned entrypoint, never read from the tool input. */
  raviBin?: string;
}

function hostRaviBin(): string | undefined {
  const entry = process.argv[1];
  if (!entry || !/(?:dist\/bundle\/index\.js|src\/cli\/index\.ts)$/.test(entry)) return undefined;
  return resolve(entry, "../../../bin/ravi");
}

export function restrictedAppArgv(command: string, options: RestrictedAppOptions = {}): string[] | null {
  // No expansion, control character, glob, subshell, brace expansion or comment. Quoted arguments remain data.
  if (!command || /[\x00-\x1f\x7f$`{}()[\]*?~#]/.test(command)) return null;
  try {
    const parsed = parseBashCommand(command);
    if (!parsed.success || parsed.commands?.length !== 1 || parsed.assignments?.length) return null;
    const argv = parseShell(command);
    if (!argv.every((word): word is string => typeof word === "string")) return null;
    const [word, group, verb, appId] = argv;
    if (!word || basename(word) !== "ravi" || group !== "apps" || !["run", "show"].includes(verb ?? "")) return null;
    if (!appId || !/^[a-z][a-z0-9-]*(\/[a-z][a-z0-9-]*)*$/.test(appId)) return null;
    if (verb === "show" && argv.slice(4).some((arg) => arg !== "--json")) return null;
    const checked = checkExecutablePath(word, { cwd: options.cwd, pathEnv: options.env?.PATH });
    const expected = options.raviBin ?? hostRaviBin();
    if (!checked.ok || !checked.realPath || !expected || checked.realPath !== realpathSync(expected)) return null;
    return argv;
  } catch {
    // no-cause: unsupported syntax or an unresolved executable is never a sandbox exception.
    return null;
  }
}

function callable(record: RaviAppManifestRecord, context: ContextRecord, options: RestrictedAppOptions): boolean {
  const id = record.manifest?.id;
  return (
    !!id &&
    record.manifest?.sandbox?.callableFromRestrictedTurns === true &&
    isAppTrusted(record, options.env) &&
    storeExposureFor(id, context.agentId ?? "", options.env) !== "hidden" &&
    canWithCapabilityContext(context, "use", "app", id)
  );
}

export function hasCallableRestrictedApp(
  context: ContextRecord | null | undefined,
  options: RestrictedAppOptions = {},
): boolean {
  if (!context || !isTurnHeldBelowAgent(context) || context.metadata?.bridgeTurnId !== undefined) return false;
  return discoverAppManifests(options).some((record) => callable(record, context, options));
}

export function authorizeRestrictedAppCommand(
  command: string,
  context: ContextRecord | null | undefined,
  options: RestrictedAppOptions = {},
): { approved: boolean; reason?: string } {
  const denied = {
    approved: false,
    reason:
      "Restricted turns may escalate only one literal ravi apps run|show call to an operator-trusted app they can use.",
  };
  if (!context || !isTurnHeldBelowAgent(context) || context.metadata?.bridgeTurnId !== undefined) return denied;
  const argv = restrictedAppArgv(command, options);
  if (!argv) return denied;
  try {
    return callable(getAppManifest(argv[3]!, options), context, options) ? { approved: true } : denied;
  } catch {
    // no-cause: missing, ambiguous or unreadable apps cannot leave a restricted turn's sandbox.
    return denied;
  }
}
