import { resolveCanonicalRaviCliPath } from "../runtime/ravi-cli-path.js";
/** One literal app invocation may cross a held turn's sandbox; this never grants shell authority. */
import { realpathSync } from "node:fs";
import { basename } from "node:path";
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

/** Decode literal argv only. shell-quote handles words; this guard excludes active expansion. */
export function restrictedLiteralArgv(command: string): string[] | null {
  if (!command || /[\x00-\x1f\x7f]/.test(command)) return null;
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;
    if (quote === "'") {
      if (char === "'") quote = undefined;
      continue;
    }
    if (char === "\\") {
      if (++i >= command.length) return null;
      // In double quotes a backslash only escapes a small set. Other characters stay literal.
      continue;
    }
    if (char === quote) {
      quote = undefined;
      continue;
    }
    if (!quote && (char === "'" || char === '"')) {
      quote = char;
      continue;
    }
    if (char === "$" || char === "`" || (!quote && /[{}()[\]*?~#]/.test(char))) return null;
  }
  if (quote) return null;
  try {
    const argv = parseShell(command);
    return argv.every((word): word is string => typeof word === "string") ? argv : null;
  } catch {
    // no-cause: unsupported shell syntax does not qualify as a literal command.
    return null;
  }
}

export function restrictedAppArgv(command: string, options: RestrictedAppOptions = {}): string[] | null {
  const argv = restrictedLiteralArgv(command);
  if (!argv) return null;
  try {
    const parsed = parseBashCommand(command);
    if (!parsed.success || parsed.commands?.length !== 1 || parsed.assignments?.length) return null;
    const [word, group, verb, appId] = argv;
    if (!word || basename(word) !== "ravi" || group !== "apps" || !["run", "show"].includes(verb ?? "")) return null;
    if (!appId || !/^[a-z][a-z0-9-]*(\/[a-z][a-z0-9-]*)*$/.test(appId)) return null;
    if (verb === "show" && argv.slice(4).some((arg) => arg !== "--json")) return null;
    const checked = checkExecutablePath(word, { cwd: options.cwd, pathEnv: options.env?.PATH });
    const expected = options.raviBin ?? resolveCanonicalRaviCliPath();
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
