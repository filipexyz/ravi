/**
 * Break-glass power: authority that is the whole system.
 *
 * Two capabilities are treated as the same power everywhere in Ravi:
 *
 * - `admin:system:*` short-circuits every capability check
 *   (capability-snapshot.ts) and makes the holder an approver.
 * - `execute:executable:*` runs any host command, and the runtime already
 *   accepts it in place of admin for shell jobs and provider settings
 *   (shell-automation.ts, provider-config-paths.ts).
 *
 * Contact profiles named `permission-admin|owner|superadmin` confer
 * `admin:system:*` by name, with no definition (contact-policy provider).
 *
 * The rule (spec permissions/break-glass): a write that would confer this power
 * is judged by the power it confers, never by the profile name. A direct
 * `--apply` never confers it; a contact gets it only through an operator
 * approval (`ravi permissions request full-access`), and an agent turn never
 * confers it by any command. The local operator terminal keeps one bootstrap
 * path: tagging a contact `permission-owner|admin|superadmin`.
 */
import { currentConsoleInvocation } from "../sdk/gateway/console-context.js";
import type { TagDefinition } from "../tags/types.js";
import { readPermissionTagCapabilities } from "./authorization-guidance.js";
import { getScopeContext } from "./scope.js";

export interface CapabilityLike {
  permission: string;
  objectType: string;
  objectId: string;
}

/** Same set as ADMIN_PERMISSION_PROFILES (apply-grant.ts); kept here to avoid an import cycle, pinned by test. */
export const ADMIN_PROFILE_SLUGS: readonly string[] = ["permission-admin", "permission-owner", "permission-superadmin"];

export const BREAK_GLASS_CAPABILITIES: readonly string[] = ["admin:system:*", "execute:executable:*"];

export const BREAK_GLASS_REQUEST_COMMAND =
  "ravi permissions request full-access --to contact:<id> --chat <chat-id> --agent <executor> --execute";

/**
 * `admin` on `system` with any object id counts: only `*` matches today, but a
 * definition is judged by intent, not by what the matcher happens to accept.
 * `execute:executable:*` counts only as the full wildcard; a pattern such as
 * `execute:executable:git*` is a narrow grant.
 */
export function isBreakGlassCapability(capability: CapabilityLike): boolean {
  const permission = capability.permission.trim().toLowerCase();
  const objectType = capability.objectType.trim().toLowerCase();
  const objectId = capability.objectId.trim();
  if (permission === "admin" && objectType === "system") return true;
  return permission === "execute" && objectType === "executable" && objectId === "*";
}

export function breakGlassCapabilities(capabilities: readonly CapabilityLike[]): string[] {
  return capabilities
    .filter(isBreakGlassCapability)
    .map((capability) => `${capability.permission}:${capability.objectType}:${capability.objectId}`);
}

export function isAdminProfileSlug(slug: string): boolean {
  return ADMIN_PROFILE_SLUGS.includes(slug.trim().toLowerCase());
}

/**
 * What break-glass power a profile confers: its admin name, or the
 * break-glass capabilities among the ones it would carry. Empty when none.
 */
export function profileBreakGlassReasons(slug: string, capabilities: readonly CapabilityLike[]): string[] {
  const reasons = breakGlassCapabilities(capabilities);
  if (isAdminProfileSlug(slug)) reasons.unshift(`${slug.trim().toLowerCase()} (admin profile)`);
  return [...new Set(reasons)];
}

/** Break-glass power a stored permission tag confers (admin name or its capabilities). */
export function tagDefinitionBreakGlassReasons(slug: string, definition: TagDefinition | null | undefined): string[] {
  const isPermissionDefinition = definition?.kind === "system" && definition.source === "permissions";
  return profileBreakGlassReasons(
    slug,
    isPermissionDefinition && definition ? readPermissionTagCapabilities(definition) : [],
  );
}

/**
 * The caller is an agent turn or a Console invocation, as opposed to the local
 * operator terminal. Holding admin does not change this: a full-access agent
 * is still an agent and never confers break-glass power to anyone.
 */
export function callerIsAgentOrRemote(): boolean {
  if (currentConsoleInvocation()) return true;
  return Boolean(getScopeContext().agentId);
}
