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
import { AsyncLocalStorage } from "node:async_hooks";
import { CliExpectedError } from "../cli/expected-error.js";
import { currentConsoleInvocation } from "../sdk/gateway/console-context.js";
import type { TagDefinition } from "../tags/types.js";
import { normalizePermissionTag } from "./permission-tags.js";

export interface CapabilityLike {
  permission: string;
  objectType: string;
  objectId: string;
}

/** Same set as ADMIN_PERMISSION_PROFILES (apply-grant.ts); kept here to avoid an import cycle, pinned by test. */
export const ADMIN_PROFILE_SLUGS: readonly string[] = ["permission-admin", "permission-owner", "permission-superadmin"];

export const BREAK_GLASS_CAPABILITIES: readonly string[] = ["admin:system:*", "execute:executable:*"];

// The storage layers (tag-db, contacts, router-db, contact-chat-grants) import
// this module, so it must not import them back at load time: scope.js reaches
// the provider registry and router-db. It is required lazily, on first call.
function scopeAgentId(): string | undefined {
  const { getScopeContext } = require("./scope.js") as typeof import("./scope.js");
  return getScopeContext()?.agentId ?? undefined;
}

/** Capabilities a permission profile definition carries (same shapes as readPermissionTagCapabilities). */
function definitionCapabilities(definition: TagDefinition): CapabilityLike[] {
  const metadata = definition.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return [];
  const record = metadata as Record<string, unknown>;
  const permissions =
    record.permissions && typeof record.permissions === "object" && !Array.isArray(record.permissions)
      ? (record.permissions as Record<string, unknown>)
      : record;
  const values = Array.isArray(permissions.capabilities)
    ? permissions.capabilities
    : Array.isArray(record.permissionCapabilities)
      ? record.permissionCapabilities
      : [];
  return values.flatMap((value: unknown): CapabilityLike[] => {
    if (typeof value === "string") {
      const [permission, objectType, objectId] = value.trim().split(":");
      return permission && objectType && objectId ? [{ permission, objectType, objectId }] : [];
    }
    if (value && typeof value === "object") {
      const entry = value as Partial<CapabilityLike>;
      return entry.permission && entry.objectType && entry.objectId
        ? [{ permission: entry.permission, objectType: entry.objectType, objectId: entry.objectId }]
        : [];
    }
    return [];
  });
}

const approvedBreakGlassGrant = new AsyncLocalStorage<string>();

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
  // Same spelling the contact-policy provider reads (`Admin.`, `permission_owner`).
  const normalized = normalizePermissionTag(slug);
  return normalized ? ADMIN_PROFILE_SLUGS.includes(normalized) : false;
}

/**
 * What break-glass power a profile confers: its admin name, or the
 * break-glass capabilities among the ones it would carry. Empty when none.
 */
export function profileBreakGlassReasons(slug: string, capabilities: readonly CapabilityLike[]): string[] {
  const reasons = breakGlassCapabilities(capabilities);
  if (isAdminProfileSlug(slug)) reasons.unshift(`${normalizePermissionTag(slug)} (admin profile)`);
  return [...new Set(reasons)];
}

/** Break-glass power a stored permission tag confers (admin name or its capabilities). */
export function tagDefinitionBreakGlassReasons(slug: string, definition: TagDefinition | null | undefined): string[] {
  const isPermissionDefinition = isPermissionProfileDefinition(definition);
  return profileBreakGlassReasons(slug, isPermissionDefinition && definition ? definitionCapabilities(definition) : []);
}

/** A permission profile definition, judged after the casing the tag store applies. */
export function isPermissionProfileDefinition(
  definition: { kind?: string | null; source?: string | null } | null | undefined,
): boolean {
  return (
    definition?.kind?.trim().toLowerCase() === "system" && definition.source?.trim().toLowerCase() === "permissions"
  );
}

/**
 * The caller is an agent turn or a Console invocation, as opposed to the local
 * operator terminal. Holding admin does not change this: a full-access agent
 * is still an agent and never confers break-glass power to anyone.
 */
export function callerIsAgentOrRemote(): boolean {
  if (currentConsoleInvocation()) return true;
  return Boolean(scopeAgentId());
}

interface AgentPermissionsConfigLike {
  profile?: string | null;
  capabilities?: ReadonlyArray<string | Partial<CapabilityLike>> | null;
}

/** Break-glass an agent runtime config carries: the full-access profile or break-glass capabilities. */
export function agentConfigBreakGlassReasons(config: AgentPermissionsConfigLike | null | undefined): string[] {
  if (!config) return [];
  const reasons =
    String(config.profile ?? "")
      .trim()
      .toLowerCase() === "full-access"
      ? ["full-access"]
      : [];
  const capabilities = (config.capabilities ?? []).flatMap((value): CapabilityLike[] => {
    if (typeof value === "string") {
      const [permission, objectType, objectId] = value.split(":");
      return permission && objectType && objectId ? [{ permission, objectType, objectId }] : [];
    }
    return value?.permission && value.objectType && value.objectId
      ? [{ permission: value.permission, objectType: value.objectType, objectId: value.objectId }]
      : [];
  });
  return [...new Set([...reasons, ...breakGlassCapabilities(capabilities)])];
}

/**
 * Refuse, from an agent turn or a Console invocation, raising ANOTHER agent to
 * break-glass by any writer of agent runtime permissions (`agents permissions`,
 * `agents set <id> defaults`, a Library install/update profile). Lowering or
 * keeping power is never refused; the operator terminal is not refused. An
 * agent's own ceiling is out of this check (spec permissions/break-glass).
 */
export function assertAgentBreakGlassRaiseAllowed(
  action: string,
  targetAgentId: string,
  before: AgentPermissionsConfigLike | null | undefined,
  after: AgentPermissionsConfigLike | null | undefined,
): void {
  const raised = agentConfigBreakGlassReasons(after);
  if (raised.length === 0 || agentConfigBreakGlassReasons(before).length > 0) return;
  if (approvedBreakGlassGrant.getStore()) return;
  if (!callerIsAgentOrRemote()) return;
  if (scopeAgentId() === targetAgentId) return;
  throw new CliExpectedError(
    `${action}: raising agent ${targetAgentId} to break-glass (${raised.join(", ")}) is for the operator terminal; an agent never raises another agent.`,
    "FULL_ACCESS_APPROVAL_REQUIRED",
    3,
    `Ask the operator to run, from a terminal: ravi agents permissions ${targetAgentId} full-access --execute`,
  );
}

/**
 * Run writes that an operator approval authorized (an approved
 * `permissions request`, a denial approval card). Inside it, the storage sinks
 * accept a break-glass tag or grant; nothing else opens them for an agent.
 */
export function runApprovedBreakGlassGrant<T>(approval: string, fn: () => T): T {
  return approvedBreakGlassGrant.run(approval, fn);
}

/**
 * The storage-level guard (spec permissions/break-glass, "sinks"). Every new
 * contact tag binding and every new contact chat grant passes here, whatever
 * command or code path wrote it. Break-glass power is refused from an agent
 * turn or a Console invocation unless the write runs inside an approved grant.
 * Command guards give the good error first; this one is what holds.
 */
export function assertBreakGlassStoreWrite(action: string, reasons: readonly string[]): void {
  if (reasons.length === 0) return;
  if (approvedBreakGlassGrant.getStore()) return;
  if (!callerIsAgentOrRemote()) return;
  throw new CliExpectedError(
    `${action}: writing ${[...new Set(reasons)].join(", ")} confers break-glass power; only an approved request or the operator terminal writes it.`,
    "FULL_ACCESS_APPROVAL_REQUIRED",
    3,
    `Break-glass reaches a contact only through operator approval: ${BREAK_GLASS_REQUEST_COMMAND}`,
  );
}
