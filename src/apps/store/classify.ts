/**
 * App classes are verified from the manifest, never declared (spec apps/store, "Classes").
 *
 * - `compose`: every command the app can run is the `ravi` CLI itself, aimed
 *   at a command the registry knows, that is exposed to remote callers and is
 *   not an administration command. Such an app can do nothing its caller's
 *   own grants do not already allow.
 * - `connector`: reserved for the core HTTP executor (not in this release).
 * - `code`: anything else. It runs as the daemon user and equals the operator.
 */

import { parseRaviAppCommand } from "../command.js";
import type { RaviAppManifest, RaviAppOperationDeclaration } from "../types.js";
import type { CommandRegistryEntry, RegistrySnapshot } from "../../cli/registry-snapshot.js";
import type { AppGrants, RaviAppClass } from "./types.js";

/** Groups a store app may never drive, even through the caller's own authority. */
export const COMPOSE_DENIED_GROUPS = Object.freeze([
  "access",
  "agents.permissions",
  "apps",
  "bridge",
  "cloud-secrets",
  "credential-destinations",
  "credentials",
  "daemon",
  "db",
  "invites",
  "link",
  "login",
  "logout",
  "permissions",
  "sandbox",
  "settings",
  "update",
]);

/** Builtin handlers a compose app may name. They only read manifests. */
const COMPOSE_BUILTIN_HANDLERS = new Set(["apps.help", "apps.manifest.show", "apps.manifest.check", "apps.stub.list"]);

const BRAKE_FLAGS = new Set(["--execute", "--apply"]);

export interface AppClassification {
  class: RaviAppClass;
  /** Why the app is not `compose`; empty for a compose app. */
  reasons: string[];
  grants: AppGrants;
}

export interface ClassifyOptions {
  registry?: RegistrySnapshot;
}

interface CommandSite {
  path: string;
  command: string;
  mutating: boolean;
}

function loadRegistry(options: ClassifyOptions): RegistrySnapshot {
  if (options.registry) return options.registry;
  const { getRegistry } = require("../../cli/registry-snapshot.js") as typeof import("../../cli/registry-snapshot.js");
  return getRegistry();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function namesOf(entry: { name: string; aliases?: string[] }): string[] {
  return [entry.name, ...(entry.aliases ?? [])];
}

/**
 * Resolve the registry command that `ravi <tokens...>` runs, using only the
 * static tokens before `{args}`. Group and command aliases count.
 */
export function resolveRegistryTarget(
  registry: RegistrySnapshot,
  staticTokens: readonly string[],
): { entry: CommandRegistryEntry; consumed: number } | null {
  let best: { entry: CommandRegistryEntry; consumed: number } | null = null;
  const groupNames = new Map(registry.groups.map((group) => [group.name, group]));
  for (const entry of registry.commands) {
    let index = 0;
    let matched = true;
    for (let depth = 0; depth < entry.groupSegments.length; depth++) {
      const path = entry.groupSegments.slice(0, depth + 1).join(".");
      const group = groupNames.get(path);
      const segment = entry.groupSegments[depth]!;
      const accepted = group ? namesOf({ name: segment, aliases: group.aliases }) : [segment];
      if (!accepted.includes(staticTokens[index] ?? "")) {
        matched = false;
        break;
      }
      index++;
    }
    if (!matched) continue;
    if (!namesOf({ name: entry.command, aliases: entry.aliases }).includes(staticTokens[index] ?? "")) continue;
    index++;
    if (!best || index > best.consumed) best = { entry, consumed: index };
  }
  return best;
}

function isDeniedGroup(groupPath: string): boolean {
  return COMPOSE_DENIED_GROUPS.some((denied) => groupPath === denied || groupPath.startsWith(`${denied}.`));
}

function collectCommandSites(manifest: RaviAppManifest, reasons: string[]): CommandSite[] {
  const sites: CommandSite[] = [];
  const cli = isObject(manifest.interfaces) ? manifest.interfaces.cli : undefined;
  if (isObject(cli)) {
    if (typeof cli.command === "string")
      sites.push({ path: "interfaces.cli.command", command: cli.command, mutating: false });
    if (typeof cli.health === "string")
      sites.push({ path: "interfaces.cli.health", command: cli.health, mutating: false });
  }
  const health = (manifest as { health?: unknown }).health;
  if (isObject(health) && Array.isArray(health.checks)) {
    health.checks.forEach((check, index) => {
      if (isObject(check) && typeof check.command === "string") {
        sites.push({ path: `health.checks[${index}].command`, command: check.command, mutating: false });
      }
    });
  }
  const operations = isObject(manifest.operations) ? manifest.operations : {};
  for (const [id, raw] of Object.entries(operations)) {
    if (!isObject(raw)) continue;
    const operation = raw as RaviAppOperationDeclaration;
    if (operation.interface === "builtin") {
      if (!operation.handler || !COMPOSE_BUILTIN_HANDLERS.has(operation.handler)) {
        reasons.push(
          `operations.${id} uses builtin handler ${operation.handler ?? "(none)"}, which store apps cannot name`,
        );
      }
      continue;
    }
    if (typeof operation.command === "string") {
      sites.push({
        path: `operations.${id}.command`,
        command: operation.command,
        mutating: operation.mutating === true,
      });
    } else {
      reasons.push(`operations.${id} has no command`);
    }
  }
  return sites;
}

function checkSite(site: CommandSite, registry: RegistrySnapshot, reasons: string[]): void {
  let template: ReturnType<typeof parseRaviAppCommand>;
  try {
    template = parseRaviAppCommand(site.command);
  } catch (error) {
    reasons.push(`${site.path} does not parse: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (template.executable !== "ravi") {
    reasons.push(`${site.path} runs ${template.executable}, not ravi`);
    return;
  }
  const staticTokens =
    template.argsPlaceholderIndex === null ? template.argv : template.argv.slice(0, template.argsPlaceholderIndex);
  // `interfaces.cli.command` may name only a group ("ravi blog"); it is never executed by the router.
  if (site.path === "interfaces.cli.command") return;
  const target = resolveRegistryTarget(registry, staticTokens);
  if (!target) {
    reasons.push(`${site.path} does not name a known ravi command before {args}`);
    return;
  }
  const { entry } = target;
  const name = `${entry.groupPath} ${entry.command}`;
  if (entry.cliOnly) reasons.push(`${site.path} runs ravi ${name}, which is not exposed to remote callers`);
  if (isDeniedGroup(entry.groupPath)) reasons.push(`${site.path} runs ravi ${name}, an administration command`);
  if (!entry.access) reasons.push(`${site.path} runs ravi ${name}, which has no access contract`);
  const brakes = template.argv.some((token) => BRAKE_FLAGS.has(token));
  const mutates = entry.access?.kind !== "read";
  if ((brakes || mutates) && !site.mutating) {
    reasons.push(`${site.path} changes state (ravi ${name}) but is not marked mutating`);
  }
}

export function classifyAppManifest(manifest: RaviAppManifest, options: ClassifyOptions = {}): AppClassification {
  const reasons: string[] = [];
  const registry = loadRegistry(options);
  const sites = collectCommandSites(manifest, reasons);
  for (const site of sites) checkSite(site, registry, reasons);

  const permissions = isObject(manifest.permissions) ? manifest.permissions : {};
  const provider = (permissions as { provider?: unknown }).provider;
  if (isObject(provider) && provider.interface === "cli") {
    reasons.push("permissions.provider runs a command; store apps cannot decide permissions");
  }

  const operations: AppGrants["operations"] = {};
  const declared = isObject(manifest.operations) ? manifest.operations : {};
  for (const [id, raw] of Object.entries(declared)) {
    if (!isObject(raw)) continue;
    const operation = raw as RaviAppOperationDeclaration;
    operations[id] = {
      runs:
        operation.interface === "builtin"
          ? `builtin:${operation.handler ?? ""}`
          : typeof operation.command === "string"
            ? operation.command
            : null,
      mutating: operation.mutating === true,
    };
  }
  const grants: AppGrants = {
    contextAllow: [...(manifest.context?.allow ?? [])].sort(),
    operations,
    hosts: [],
    connections: [],
  };
  return { class: reasons.length === 0 ? "compose" : "code", reasons, grants };
}
