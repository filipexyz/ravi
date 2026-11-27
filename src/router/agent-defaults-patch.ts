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
