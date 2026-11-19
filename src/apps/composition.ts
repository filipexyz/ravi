/**
 * App composition: how one Ravi App offers a service to another, and how the router checks that a call is part of
 * a declared composition. Spec apps/manifest ("Composition") and apps/router ("Composition").
 *
 * A leaf module: it reads manifests and context records and decides. It never spawns a process, never issues or
 * revokes a context, and never imports the discovery code, so `service.ts` and `router.ts` can both depend on it.
 */

import { semver } from "bun";
import { canWithCapabilities } from "../permissions/capability-snapshot.js";
import type { ContextCapability, ContextRecord } from "../router/router-db.js";
import { parseRaviAppCapability } from "./command.js";
import type {
  RaviAppDependencyUnavailableReason,
  RaviAppManifest,
  RaviAppManifestRecord,
  RaviAppProvidedService,
  RaviAppUnavailableDependency,
} from "./types.js";

export type RaviAppCompositionErrorCode = "APP_DEPENDENCY_UNAVAILABLE" | "APP_OPERATION_NOT_PROVIDED";

/**
 * The router refuses to run an app because of how apps compose, before any process starts. Its message is for logs;
 * what reaches a caller is the stable `code` and, for a missing dependency, the validated `unavailable` list.
 */
export class RaviAppCompositionError extends Error {
  readonly code: RaviAppCompositionErrorCode;
  readonly unavailable: RaviAppUnavailableDependency[];

  constructor(code: RaviAppCompositionErrorCode, message: string, unavailable: RaviAppUnavailableDependency[] = []) {
    super(message);
    this.name = "RaviAppCompositionError";
    this.code = code;
    this.unavailable = unavailable;
  }
}

// ----------------------------------------------------------------------------------------------------------------
// Keys and versions

const SEGMENT = /^[a-z][a-z0-9-]*$/;
const EXACT_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const RANGE_TOKEN = /^(?:\^|~|>=|<=|>|<|=)?(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){0,2}$/;
const MAX_RANGE_TOKENS = 3;

export interface RaviAppServiceKey {
  /** The whole key: `<app-id>/<service>`. */
  key: string;
  /** The app that offers the service. An app id may itself contain slashes, so the service is the last segment. */
  appId: string;
  service: string;
}

export function parseServiceKey(value: string): RaviAppServiceKey | null {
  const parts = value.split("/");
  if (parts.length < 2 || !parts.every((part) => SEGMENT.test(part))) return null;
  return { key: value, appId: parts.slice(0, -1).join("/"), service: parts[parts.length - 1]! };
}

/** `x.y.z`, no pre-release and no build metadata: what a provider offers is one exact version. */
export function isExactVersion(value: unknown): value is string {
  return typeof value === "string" && EXACT_VERSION.test(value);
}

/**
 * One to three space-separated comparators (`^1`, `~1.2`, `>=1.2.0 <2`, `1.4.0`). Strict on purpose: the parser
 * that decides satisfaction accepts any text as a match-all range, so text that is not a range must never reach it.
 */
export function isVersionRange(value: unknown): value is string {
  if (typeof value !== "string" || value !== value.trim()) return false;
  const tokens = value.split(" ");
  return tokens.length <= MAX_RANGE_TOKENS && tokens.every((token) => RANGE_TOKEN.test(token));
}

export function satisfiesRange(version: string, range: string): boolean {
  return isExactVersion(version) && isVersionRange(range) && semver.satisfies(version, range);
}

// ----------------------------------------------------------------------------------------------------------------
// Reading the declarations (defensive: a malformed manifest is still read, so cycle checks never throw)

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The well-formed entries of `provides`, keyed by service key. */
export function providedServices(manifest: RaviAppManifest | null | undefined): Record<string, RaviAppProvidedService> {
  const out: Record<string, RaviAppProvidedService> = {};
  if (!manifest || !isObject(manifest.provides)) return out;
  for (const [key, entry] of Object.entries(manifest.provides)) {
    if (!parseServiceKey(key) || !isObject(entry)) continue;
    const operations = entry.operations;
    if (!isExactVersion(entry.version) || !Array.isArray(operations)) continue;
    out[key] = { version: entry.version, operations: operations.filter((op): op is string => typeof op === "string") };
  }
  return out;
}

export interface RaviAppRequirement {
  key: RaviAppServiceKey;
  range: string;
}

/** The well-formed entries of `requires`, in key order so every result is deterministic. */
export function requiredServices(manifest: RaviAppManifest | null | undefined): RaviAppRequirement[] {
  if (!manifest || !isObject(manifest.requires)) return [];
  const out: RaviAppRequirement[] = [];
  for (const key of Object.keys(manifest.requires).sort()) {
    const parsed = parseServiceKey(key);
    const range = manifest.requires[key];
    if (parsed && isVersionRange(range)) out.push({ key: parsed, range });
  }
  return out;
}

export function declaresProvides(manifest: RaviAppManifest | null | undefined): boolean {
  return Object.keys(providedServices(manifest)).length > 0;
}

export function declaresRequires(manifest: RaviAppManifest | null | undefined): boolean {
  return requiredServices(manifest).length > 0;
}

/** An app that offers or needs a service runs with a credential that lives only as long as its process. */
export function participatesInComposition(manifest: RaviAppManifest | null | undefined): boolean {
  return declaresProvides(manifest) || declaresRequires(manifest);
}

// ----------------------------------------------------------------------------------------------------------------
// Validation of one manifest

export function validateComposition(manifest: RaviAppManifest, operationIds: Set<string>, errors: string[]): void {
  const appId = typeof manifest.id === "string" ? manifest.id.trim() : "";
  validateProvides(manifest, appId, operationIds, errors);
  validateRequires(manifest, appId, errors);
}

function label(key: string): string {
  return JSON.stringify(key.length > 80 ? `${key.slice(0, 80)}...` : key);
}

function validateProvides(manifest: RaviAppManifest, appId: string, operationIds: Set<string>, errors: string[]): void {
  const value = manifest.provides;
  if (value === undefined) return;
  if (!isObject(value)) {
    errors.push("provides must be an object keyed by <app-id>/<service>.");
    return;
  }
  const permissions = isObject(manifest.permissions) ? manifest.permissions : undefined;
  const reserved =
    permissions && isObject(permissions.provider) && typeof permissions.provider.operation === "string"
      ? permissions.provider.operation
      : null;

  for (const [key, entry] of Object.entries(value)) {
    const path = `provides[${label(key)}]`;
    const parsed = parseServiceKey(key);
    if (!parsed || parsed.appId !== appId) {
      errors.push(`${path}: the key must be "${appId || "<app-id>"}/<service>", lowercase slug segments.`);
      continue;
    }
    if (!isObject(entry)) {
      errors.push(`${path} must be an object with version and operations.`);
      continue;
    }
    if (!isExactVersion(entry.version)) errors.push(`${path}.version must be an exact x.y.z version.`);
    const operations = entry.operations;
    if (!Array.isArray(operations) || operations.length === 0 || !operations.every((op) => typeof op === "string")) {
      errors.push(`${path}.operations must be a non-empty array of operation ids.`);
      continue;
    }
    const seen = new Set<string>();
    operations.forEach((operation: string, index) => {
      const opPath = `${path}.operations[${index}]`;
      if (!operationIds.has(operation)) errors.push(`${opPath} is not declared in operations.`);
      else if (operation === reserved)
        errors.push(`${opPath} is the permission provider operation and cannot be offered.`);
      if (seen.has(operation)) errors.push(`${opPath} duplicates another offered operation.`);
      seen.add(operation);
    });
  }
}

function validateRequires(manifest: RaviAppManifest, appId: string, errors: string[]): void {
  const value = manifest.requires;
  if (value === undefined) return;
  if (!isObject(value)) {
    errors.push("requires must be an object mapping <app-id>/<service> to a version range.");
    return;
  }
  for (const [key, range] of Object.entries(value)) {
    const path = `requires[${label(key)}]`;
    const parsed = parseServiceKey(key);
    if (!parsed) {
      errors.push(`${path}: the key must be "<app-id>/<service>", lowercase slug segments.`);
      continue;
    }
    if (parsed.appId === appId) errors.push(`${path}: an app cannot require its own service.`);
    if (!isVersionRange(range)) errors.push(`${path} must be a version range such as ^1 or >=1.2.0 <2.0.0.`);
  }
}

// ----------------------------------------------------------------------------------------------------------------
// The set of discovered manifests: cycles, and what is missing

/**
 * `requires` edges that run in a circle make a composed app impossible to start, so every app on the circle is
 * invalid. Apps that only lead into a circle stay valid; the router reports the circle as their unavailable provider.
 */
export function markCompositionCycles(records: RaviAppManifestRecord[]): void {
  const edges = new Map<string, string[]>();
  for (const record of records) {
    const id = record.manifest?.id;
    if (typeof id !== "string") continue;
    const targets = requiredServices(record.manifest)
      .map((requirement) => requirement.key.appId)
      .filter((target) => target !== id);
    if (targets.length > 0) edges.set(id, [...new Set([...(edges.get(id) ?? []), ...targets])].sort());
  }

  const cycles = new Map<string, string[]>();
  for (const start of [...edges.keys()].sort()) {
    const path = findCycleThrough(start, edges);
    if (path) cycles.set(start, path);
  }
  for (const record of records) {
    const id = record.manifest?.id;
    const path = typeof id === "string" ? cycles.get(id) : undefined;
    if (!path) continue;
    record.errors.push(`requires cycle: ${path.join(" -> ")}.`);
    record.valid = false;
  }
}

function findCycleThrough(start: string, edges: Map<string, string[]>): string[] | null {
  const visited = new Set<string>([start]);
  const walk = (node: string, path: string[]): string[] | null => {
    for (const next of edges.get(node) ?? []) {
      if (next === start) return [...path, start];
      if (visited.has(next)) continue;
      visited.add(next);
      const found = walk(next, [...path, next]);
      if (found) return found;
    }
    return null;
  };
  return walk(start, [start]);
}

const REASON_TEXT: Record<RaviAppDependencyUnavailableReason, (dependency: RaviAppUnavailableDependency) => string> = {
  not_installed: () => "no app with that id is installed",
  invalid: () => "the provider's manifest is invalid or ambiguous",
  not_provided: () => "the provider does not offer that service",
  version_mismatch: (dependency) => `the provider offers ${dependency.installedVersion ?? "another version"}`,
  insufficient_authority: (dependency) =>
    `the provider asks for ${(dependency.missing ?? []).join(", ") || "more than"} which ${dependency.requiredBy} does not declare in context.allow`,
};

export function describeUnavailableDependency(dependency: RaviAppUnavailableDependency): string {
  return `${dependency.requiredBy} requires ${dependency.requires}@${dependency.range}: ${REASON_TEXT[dependency.reason](dependency)}.`;
}

/**
 * A manifest whose provider is not there is still a valid manifest: whether a provider is installed is a fact about
 * the machine, not about the file. `apps check` says so as a warning; the router refuses to run the app.
 */
export function markUnavailableDependencies(records: RaviAppManifestRecord[]): void {
  for (const record of records) {
    if (!record.valid || !record.manifest) continue;
    for (const requirement of requiredServices(record.manifest)) {
      const { unavailable } = resolveRequirement(requirement, record, records);
      if (unavailable) record.warnings.push(describeUnavailableDependency(unavailable));
    }
  }
}

// ----------------------------------------------------------------------------------------------------------------
// Resolution at run time

function resolveRequirement(
  requirement: RaviAppRequirement,
  requiredBy: RaviAppManifestRecord,
  records: RaviAppManifestRecord[],
): { provider?: RaviAppManifestRecord; unavailable?: RaviAppUnavailableDependency } {
  const base = {
    requires: requirement.key.key,
    range: requirement.range,
    requiredBy: requiredBy.manifest?.id ?? requiredBy.id,
  };
  // A manifest that did not parse has no id of its own: it is known by the directory it sits in, and it is still the
  // app the requirement names, only a broken one. Saying "not installed" would send the operator to install it again.
  const matches = records.filter((record) => (record.manifest?.id ?? record.id) === requirement.key.appId);
  if (matches.length === 0) return { unavailable: { ...base, reason: "not_installed" } };
  const provider = matches[0]!;
  if (matches.length > 1 || !provider.valid) return { unavailable: { ...base, reason: "invalid" } };
  const offered = providedServices(provider.manifest)[requirement.key.key];
  if (!offered) return { unavailable: { ...base, reason: "not_provided" } };
  if (!satisfiesRange(offered.version, requirement.range)) {
    return { unavailable: { ...base, reason: "version_mismatch", installedVersion: offered.version } };
  }
  // The provider's context is issued from the requiring app's, so what the provider is allowed has to be something the
  // requiring app declares it holds. It is the requiring app's manifest that says what it delegates, and a provider
  // that starts asking for more has to fail closed here, not widen the requiring app.
  const missing = uncoveredAllow(provider, requiredBy);
  if (missing.length > 0) return { unavailable: { ...base, reason: "insufficient_authority", missing } };
  return { provider };
}

/** The entries of `provider`'s `context.allow` that `holder`'s own `context.allow` does not cover. */
function uncoveredAllow(provider: RaviAppManifestRecord, holder: RaviAppManifestRecord): string[] {
  const held = declaredCapabilities(holder.manifest);
  const asked = provider.manifest?.context?.allow;
  return (Array.isArray(asked) ? asked : []).filter((entry) => {
    if (typeof entry !== "string") return false;
    try {
      const capability = parseRaviAppCapability(entry);
      return !canWithCapabilities(held, capability.permission, capability.objectType, capability.objectId);
    } catch {
      // A malformed entry is the provider's own validation error; it is not a gap in the holder's declaration.
      return false;
    }
  });
}

function declaredCapabilities(manifest: RaviAppManifest | null | undefined): ContextCapability[] {
  const allow = manifest?.context?.allow;
  const out: ContextCapability[] = [];
  for (const entry of Array.isArray(allow) ? allow : []) {
    if (typeof entry !== "string") continue;
    try {
      out.push(parseRaviAppCapability(entry));
    } catch {
      // Skipped: validation already reports it.
    }
  }
  return out;
}

export interface RaviAppDependencyEdge {
  requiredBy: RaviAppManifestRecord;
  requirement: RaviAppRequirement;
  provider: RaviAppManifestRecord;
}

export interface RaviAppDependencyClosure {
  /** Every app the root needs, directly or through another provider, once each. The root is not in it. */
  providers: RaviAppManifestRecord[];
  edges: RaviAppDependencyEdge[];
  unavailable: RaviAppUnavailableDependency[];
}

/** What `root` needs, followed through its providers' own `requires`. */
export function resolveDependencyClosure(
  root: RaviAppManifestRecord,
  records: RaviAppManifestRecord[],
): RaviAppDependencyClosure {
  const closure: RaviAppDependencyClosure = { providers: [], edges: [], unavailable: [] };
  const visited = new Set<string>(root.manifest ? [root.manifest.id] : []);
  const queue: RaviAppManifestRecord[] = [root];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const requirement of requiredServices(current.manifest)) {
      const { provider, unavailable } = resolveRequirement(requirement, current, records);
      if (unavailable) {
        closure.unavailable.push(unavailable);
        continue;
      }
      closure.edges.push({ requiredBy: current, requirement, provider: provider! });
      const providerId = provider!.manifest!.id;
      if (visited.has(providerId)) continue;
      visited.add(providerId);
      closure.providers.push(provider!);
      queue.push(provider!);
    }
  }
  return closure;
}

/**
 * The capabilities a composed app is issued: its own `context.allow` (what its manifest says it holds, and so what it
 * delegates to its providers), plus the right to call each provider it needs, directly or through another provider
 * (`use:app:<id>`, and `execute:app:<id>` when a required service offers a mutating operation), plus the public
 * `apps run` access that `routing` names. The providers' own `context.allow` is NOT added: a provider's context is
 * issued from this one and the registry refuses what it does not hold, and `resolveDependencyClosure` has already
 * refused a provider that asks for more than its requirer declares. The ceiling never exceeds the invoker either: this
 * app's own context is issued from the invoker's.
 */
export function composedContextAllow(
  root: RaviAppManifestRecord,
  closure: RaviAppDependencyClosure,
  routing?: string,
): string[] {
  const allow = new Set<string>(root.manifest?.context?.allow ?? []);
  // A call to a provider through the public CLI is `apps run`, and the gateway asks for access to that command
  // before the router sees the call. Without it the requirement could be declared and never used.
  if (routing && closure.edges.length > 0) allow.add(routing);
  for (const edge of closure.edges) {
    const providerId = edge.provider.manifest!.id;
    allow.add(`use:app:${providerId}`);
    if (offersMutatingOperation(edge.provider, edge.requirement.key.key)) allow.add(`execute:app:${providerId}`);
  }
  return [...allow];
}

function offersMutatingOperation(provider: RaviAppManifestRecord, serviceKey: string): boolean {
  const offered = providedServices(provider.manifest)[serviceKey];
  const declared = provider.manifest?.operations;
  const operations = isObject(declared) ? declared : {};
  return (offered?.operations ?? []).some((id) => {
    const operation = operations[id];
    return isObject(operation) && operation.mutating === true;
  });
}

// ----------------------------------------------------------------------------------------------------------------
// Calls from one app to another

const MAX_LINEAGE_DEPTH = 16;

/**
 * The app a context belongs to: the one the app router issued it for, or the nearest such ancestor. A credential an
 * app derives for itself (`ravi context issue` gives it no app identity of its own) stays the app's, because its
 * lineage is host-owned and a process cannot erase it. `parentOf` reads one step up; without it only the context
 * itself is looked at.
 */
export function appCallerOf(
  context: ContextRecord | undefined,
  parentOf?: (contextId: string) => ContextRecord | null | undefined,
): string | null {
  const seen = new Set<string>();
  let cursor = context;
  while (cursor && seen.size < MAX_LINEAGE_DEPTH && !seen.has(cursor.contextId)) {
    seen.add(cursor.contextId);
    const metadata = cursor.metadata;
    if (cursor.kind === "app-runtime" && metadata?.source === "app-router" && typeof metadata.appId === "string") {
      return metadata.appId;
    }
    const parentId = typeof metadata?.parentContextId === "string" ? metadata.parentContextId : null;
    cursor = parentId && parentOf ? (parentOf(parentId) ?? undefined) : undefined;
  }
  return null;
}

/**
 * An app that offers services is called by other apps only through them: the caller must declare `requires` for a
 * service the provider offers at a version the range accepts, and the operation must be one the service lists. Apps
 * that offer nothing keep the earlier rule (the caller's `use:app:<id>` capability).
 */
export function assertOperationProvided(
  callee: RaviAppManifestRecord,
  operationId: string,
  callerAppId: string,
  records: RaviAppManifestRecord[],
): { service: string } {
  const calleeId = callee.manifest?.id ?? callee.id;
  const callers = records.filter((record) => record.manifest?.id === callerAppId);
  const caller = callers.length === 1 && callers[0]!.valid ? callers[0]! : null;
  for (const requirement of requiredServices(caller?.manifest)) {
    if (requirement.key.appId !== calleeId) continue;
    const offered = providedServices(callee.manifest)[requirement.key.key];
    if (!offered || !satisfiesRange(offered.version, requirement.range)) continue;
    if (offered.operations.includes(operationId)) return { service: requirement.key.key };
  }
  throw new RaviAppCompositionError(
    "APP_OPERATION_NOT_PROVIDED",
    `App ${callerAppId} cannot call ${operationId} on ${calleeId}: it is not offered through a service ${callerAppId} requires.`,
  );
}
