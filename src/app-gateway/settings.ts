/**
 * Local opt-in settings for the Pages app gateway executor.
 *
 * Both keys widen what org Pages viewers can run on this machine, so
 * `ravi settings set|delete` guards every `apps.gateway.` key like
 * `permissions.*` (superadmin or local operator only). The executor reads them
 * on every invoke with no cache: removing an entry stops it on the next invoke.
 */

import { dbGetSetting } from "../router/router-db.js";
import { isAppId, isOperationId } from "./constants.js";

export const APP_GATEWAY_SETTINGS_PREFIX = "apps.gateway.";
export const APP_GATEWAY_ALLOWED_OPERATIONS_SETTING = "apps.gateway.allowed_operations";
export const APP_GATEWAY_REQUIRE_LINK_SETTING = "apps.gateway.require_link";

export type SettingReader = (key: string) => string | null;

/**
 * Parse `apps.gateway.allowed_operations`: comma-separated exact
 * `<appId>:<operationId>` pairs. Throws on any malformed entry so `ravi
 * settings set` can refuse it; no `*` and no app-only entries.
 */
export function parseAllowedOperationsStrict(raw: string): Set<string> {
  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length === 0) {
    throw new Error("List at least one <appId>:<operationId> pair, e.g. slides:slides.list.");
  }
  const allowed = new Set<string>();
  for (const entry of entries) {
    const separator = entry.indexOf(":");
    const appId = separator > 0 ? entry.slice(0, separator) : "";
    const operationId = separator > 0 ? entry.slice(separator + 1) : "";
    if (!isAppId(appId) || !isOperationId(operationId)) {
      throw new Error(
        `Invalid entry "${entry}". Use exact <appId>:<operationId> pairs such as slides:slides.list; no wildcards or app-only entries.`,
      );
    }
    allowed.add(`${appId}:${operationId}`);
  }
  return allowed;
}

/** Runtime read: an unparsable value counts as empty (nothing exposed). */
export function readAllowedOperations(read: SettingReader = dbGetSetting): Set<string> {
  const raw = read(APP_GATEWAY_ALLOWED_OPERATIONS_SETTING);
  if (!raw?.trim()) return new Set();
  try {
    return parseAllowedOperationsStrict(raw);
  } catch {
    return new Set();
  }
}

export function validateRequireLinkSetting(value: string): void {
  if (value !== "true" && value !== "false") {
    throw new Error("Invalid value. Must be one of: true, false");
  }
}

/** Runtime read: only the exact value `true` requires a Ravi Link contact. */
export function readRequireLink(read: SettingReader = dbGetSetting): boolean {
  return read(APP_GATEWAY_REQUIRE_LINK_SETTING) === "true";
}

export function isAppGatewaySettingKey(key: string): boolean {
  return key.startsWith(APP_GATEWAY_SETTINGS_PREFIX);
}
