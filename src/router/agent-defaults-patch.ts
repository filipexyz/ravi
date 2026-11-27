/**
 * `ravi agents set <id> defaults <json>` applies a patch, never a replacement.
 *
 * On 27/11 the WhatsApp overlay read a paginated agent list, did not find
 * `main` on the first page, started from `{}` and wrote back only its TTS keys:
 * the agent lost runtimePermissions (full-access) and every other default with
 * no error. A generic defaults write now merges key by key, `null` removes a
 * key, and runtimePermissions is owned by `ravi agents permissions` alone.
 */
import { CliExpectedError } from "../cli/expected-error.js";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isPlainRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

export const AGENT_DEFAULTS_PERMISSION_KEY = "runtimePermissions";

/**
 * Merge `patch` over `current`. Keys absent from the patch are kept; a `null`
 * value removes the key. A patch that would change runtimePermissions (set,
 * replace or remove) is refused; sending the identical value is a no-op.
 */
export function mergeAgentDefaultsPatch(
  agentId: string,
  current: Record<string, unknown> | null | undefined,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const base: Record<string, unknown> = isPlainRecord(current) ? { ...current } : {};
  if (Object.hasOwn(patch, AGENT_DEFAULTS_PERMISSION_KEY)) {
    const incoming = patch[AGENT_DEFAULTS_PERMISSION_KEY];
    const existing = base[AGENT_DEFAULTS_PERMISSION_KEY];
    const same =
      incoming === null || incoming === undefined
        ? existing === undefined || existing === null
        : stableJson(incoming) === stableJson(existing);
    if (!same) {
      throw new CliExpectedError(
        `agents set ${agentId} defaults cannot change runtimePermissions. Use: ravi agents permissions ${agentId} <profile>`,
        "AGENT_DEFAULTS_PERMISSIONS_READ_ONLY",
        1,
        `ravi agents permissions ${agentId}`,
      );
    }
  }
  for (const [key, value] of Object.entries(patch)) {
    if (key === AGENT_DEFAULTS_PERMISSION_KEY) continue;
    if (value === null) delete base[key];
    else base[key] = value;
  }
  return base;
}

function sameJson(a: unknown, b: unknown): boolean {
  return stableJson(a) === stableJson(b);
}

/**
 * Three-way merge used by `dbRebaseAgentDefaults`: apply what a writer changed
 * between `base` (what it read) and `next` (what it built) onto `current` (the
 * row as stored now), at any depth, so two writers that touch different
 * entries of the same top-level key both survive.
 *
 * - Plain objects merge key by key, recursively.
 * - Arrays are treated as sets of values: elements the writer added are
 *   appended to `current`, elements it removed are dropped from `current`;
 *   entries another writer added in between survive (e.g. two different
 *   `runtimePermissions.capabilities` granted concurrently).
 * - Anything else (or a type change) is a leaf: the writer's value wins only
 *   when it differs from `base`.
 */
function emptyLike(value: unknown): unknown {
  if (Array.isArray(value)) return [];
  if (isPlainRecord(value)) return {};
  return undefined;
}

/**
 * Canonical identity of a `runtimePermissions.capabilities` entry: the string
 * form `permission:objectType:objectId` (objectId may contain ':') and the
 * object form `{ permission, objectType, objectId }` are the same capability.
 * Same parsing rule as normalizeAuthorizationCapabilityInput (not imported:
 * that module reaches the tags DB and would cycle with router-db). An entry
 * that is neither form keeps its serialized identity.
 */
export function capabilityItemKey(item: unknown): string {
  if (typeof item === "string") {
    const parts = item.split(":");
    if (parts.length >= 3) {
      const [permission, objectType, ...rest] = parts;
      const objectId = rest.join(":");
      if (permission.trim() && objectType.trim() && objectId.trim()) {
        return `cap:${permission.trim()}:${objectType.trim()}:${objectId.trim()}`;
      }
    }
  } else if (isPlainRecord(item)) {
    const { permission, objectType, objectId } = item;
    if (typeof permission === "string" && typeof objectType === "string" && typeof objectId === "string") {
      if (permission.trim() && objectType.trim() && objectId.trim()) {
        return `cap:${permission.trim()}:${objectType.trim()}:${objectId.trim()}`;
      }
    }
  }
  return stableJson(item);
}

function arrayItemKeyFor(path: readonly string[]): (item: unknown) => string {
  const n = path.length;
  if (n >= 2 && path[n - 1] === "capabilities" && path[n - 2] === "runtimePermissions") return capabilityItemKey;
  return stableJson;
}

/**
 * Three-way merge used by `dbRebaseAgentDefaults`: apply what a writer changed
 * between `base` (what it read) and `next` (what it built) onto `current` (the
 * row as stored now), at any depth, so two writers that touch different
 * entries of the same top-level key both survive.
 *
 * - Nobody else wrote (`current` equals `base`): the writer's value stands as
 *   built, including a pure reorder.
 * - Plain objects merge key by key, recursively.
 * - Arrays are treated as sets of values: elements the writer added are
 *   appended to `current`, elements it removed are dropped from `current`;
 *   entries another writer added in between survive (e.g. two different
 *   `runtimePermissions.capabilities` granted concurrently). Capability
 *   entries are compared by their canonical identity, so a revocation still
 *   applies when another writer re-wrote the list in the other format.
 * - Anything else (or a type change) is a leaf: the writer's value wins only
 *   when it differs from `base`.
 */
export function rebaseAgentDefaultsValue(
  current: unknown,
  base: unknown,
  next: unknown,
  path: readonly string[] = [],
): unknown {
  if (sameJson(base, next)) return current;
  if (sameJson(current, base)) return next;
  if (isPlainRecord(base) && isPlainRecord(next) && isPlainRecord(current)) {
    const out: Record<string, unknown> = { ...current };
    const keys = new Set([...Object.keys(base), ...Object.keys(next)]);
    for (const key of keys) {
      const inBase = Object.hasOwn(base, key);
      const inNext = Object.hasOwn(next, key);
      if (inBase && !inNext) {
        delete out[key];
      } else if (!inBase && inNext) {
        // The writer added a key it did not see. If another writer created it
        // meanwhile, merge against an empty value of the same shape so both
        // survive (two first grants from a snapshot without capabilities).
        out[key] = Object.hasOwn(out, key)
          ? rebaseAgentDefaultsValue(out[key], emptyLike(next[key]), next[key], [...path, key])
          : next[key];
      } else if (!sameJson(base[key], next[key])) {
        if (Object.hasOwn(out, key))
          out[key] = rebaseAgentDefaultsValue(out[key], base[key], next[key], [...path, key]);
        else out[key] = next[key];
      }
    }
    return out;
  }
  if (Array.isArray(base) && Array.isArray(next) && Array.isArray(current)) {
    const itemKey = arrayItemKeyFor(path);
    const baseKeys = new Set(base.map(itemKey));
    const nextKeys = new Set(next.map(itemKey));
    const removed = new Set([...baseKeys].filter((key) => !nextKeys.has(key)));
    const out: unknown[] = [];
    const present = new Set<string>();
    for (const item of current) {
      const key = itemKey(item);
      if (removed.has(key) || present.has(key)) continue;
      out.push(item);
      present.add(key);
    }
    for (const item of next) {
      const key = itemKey(item);
      if (!baseKeys.has(key) && !present.has(key)) {
        out.push(item);
        present.add(key);
      }
    }
    return out;
  }
  return next;
}

/** `rebaseAgentDefaultsValue` for whole defaults objects; empty result is null. */
export function rebaseAgentDefaultsObject(
  current: Record<string, unknown> | null | undefined,
  base: Record<string, unknown> | null | undefined,
  next: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  const merged = rebaseAgentDefaultsValue(current ?? {}, base ?? {}, next ?? {});
  return isPlainRecord(merged) && Object.keys(merged).length > 0 ? merged : null;
}
