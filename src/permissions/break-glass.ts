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
  // The operator's terminal resolves the local default credential
  // (`~/.ravi/credentials.json`, an admin-bootstrap key bound to the
  // `bootstrap` identity) when no runtime context is set. That identity is the
  // operator's own key, not an agent turn: the same rule as
  // credentials/authorization.ts and voice/authority.ts. The same key presented
  // through the gateway carries no `contextOrigin` and stays an agent/remote caller.
  //
  // Only an interactive terminal counts. A full-access agent's shell may drop
  // its RAVI_* env (the Bash hook lets a superadmin do it) and resolve the same
  // file; its tool shell has no TTY, so it stays an agent here (Devin on #1051).
  const { getContext } = require("../cli/context.js") as typeof import("../cli/context.js");
  if (getContext()?.contextOrigin === "default-credential" && operatorTerminalIsInteractive()) return undefined;
  const { getScopeContext } = require("./scope.js") as typeof import("./scope.js");
  return getScopeContext()?.agentId ?? undefined;
}

/** The operator at a keyboard: stdin and stdout are both a terminal. Overridable for tests. */
let interactiveProbe: () => boolean = () => Boolean(process.stdin?.isTTY && process.stdout?.isTTY);

function operatorTerminalIsInteractive(): boolean {
  return interactiveProbe();
}

/** Test seam: replace the TTY probe; returns a function that restores the real one. */
export function setInteractiveTerminalProbeForTests(probe: () => boolean): () => void {
  const previous = interactiveProbe;
  interactiveProbe = probe;
  return () => {
    interactiveProbe = previous;
  };
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
      const [permission, objectType, ...rest] = value.trim().split(":");
      const objectId = rest.join(":");
      return permission && objectType && objectId ? [{ permission, objectType, objectId }] : [];
    }
    if (value && typeof value === "object") {
      // Malformed metadata (numbers, nested objects) is ignored, as the provider does (review N11).
      const entry = value as Record<string, unknown>;
      const permission = typeof entry.permission === "string" ? entry.permission.trim() : "";
      const objectType = typeof entry.objectType === "string" ? entry.objectType.trim() : "";
      const objectId = typeof entry.objectId === "string" ? entry.objectId.trim() : "";
      return permission && objectType && objectId ? [{ permission, objectType, objectId }] : [];
    }
    return [];
  });
}

// The scope holds a token that is switched off when the approved body returns,
// so a continuation the body scheduled never sees an open approval.
const approvedBreakGlassGrant = new AsyncLocalStorage<{ approval: string; active: boolean }>();

function approvalOpen(): boolean {
  return approvedBreakGlassGrant.getStore()?.active === true;
}

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
export function agentConfigBreakGlassReasons(
  config: AgentPermissionsConfigLike | null | undefined,
  mode: "effective" | "stored" = "effective",
): string[] {
  if (!config) return [];
  const profile = String(config.profile ?? "")
    .trim()
    .toLowerCase();
  // chat-only drops every capability at runtime, so it confers nothing EFFECTIVE.
  // What it stores still counts ("stored"): another profile change would wake it.
  if (profile === "chat-only" && mode === "effective") return [];
  const reasons = profile === "full-access" ? ["full-access"] : [];
  const capabilities = (config.capabilities ?? []).flatMap((value): CapabilityLike[] => {
    if (typeof value === "string") {
      const [permission, objectType, ...rest] = value.split(":");
      const objectId = rest.join(":");
      return permission && objectType && objectId ? [{ permission, objectType, objectId }] : [];
    }
    return typeof value?.permission === "string" &&
      typeof value.objectType === "string" &&
      typeof value.objectId === "string" &&
      value.permission &&
      value.objectType &&
      value.objectId
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
  options: { warnOperator?: boolean } = {},
): void {
  // An agent that already holds break-glass effectively keeps it; nothing to judge.
  if (agentConfigBreakGlassReasons(before, "effective").length > 0) return;
  // Refused: break-glass becomes effective (a raise, or a dormant one woken by a
  // profile change), or new break-glass is stored even dormant (chat-only with
  // admin:system:* planted for a later profile change to wake). Adjusting an
  // agent that already stores the same dormant break-glass is not refused.
  const storedBefore = new Set(agentConfigBreakGlassReasons(before, "stored"));
  const newlyStored = agentConfigBreakGlassReasons(after, "stored").filter((reason) => !storedBefore.has(reason));
  const effectiveAfter = agentConfigBreakGlassReasons(after, "effective");
  const raised = [...new Set([...effectiveAfter, ...newlyStored])];
  if (raised.length === 0) return;
  if (approvalOpen()) return;
  if (!callerIsAgentOrRemote()) {
    // The operator may do it; say so when it wakes something that was dormant.
    // Only the storage sink warns: command pre-checks and dry runs stay quiet.
    if (options.warnOperator === false) return;
    warnOperatorBreakGlass(
      `waking dormant break-glass on agent ${targetAgentId}`,
      effectiveAfter.filter((reason) => storedBefore.has(reason)),
    );
    return;
  }
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
export function runApprovedBreakGlassGrant<T>(
  approval: string,
  fn: () => T extends PromiseLike<unknown> ? never : T,
): T {
  // The scope must close when fn returns: an async body would let every
  // continuation after an await inherit an open approval (review N7).
  const token = { approval, active: true };
  try {
    return approvedBreakGlassGrant.run(token, () => {
      const result = fn() as T;
      if (result && typeof (result as { then?: unknown }).then === "function") {
        throw new Error("runApprovedBreakGlassGrant: the approved body must be synchronous.");
      }
      return result;
    });
  } finally {
    token.active = false;
  }
}

/**
 * Tell the operator, on stderr, when a write from the terminal wakes or grants
 * break-glass that an agent would have been refused: a dormant agent config
 * becoming effective, or a contact holding break-glass being activated.
 */
export function warnOperatorBreakGlass(action: string, reasons: readonly string[]): void {
  if (reasons.length === 0 || approvalOpen() || callerIsAgentOrRemote()) return;
  process.stderr.write(
    `warning: ${action} gives break-glass power (${[...new Set(reasons)].join(", ")}). Undo it if that was not intended.\n`,
  );
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
  if (approvalOpen()) return;
  if (!callerIsAgentOrRemote()) return;
  throw new CliExpectedError(
    `${action}: writing ${[...new Set(reasons)].join(", ")} confers break-glass power; only an approved request or the operator terminal writes it.`,
    "FULL_ACCESS_APPROVAL_REQUIRED",
    3,
    `Break-glass reaches a contact only through operator approval: ${BREAK_GLASS_REQUEST_COMMAND}`,
  );
}

/**
 * Break-glass a tag or profile slug confers, read the way the contact-policy
 * provider reads it: admin names in any spelling, and the definition stored
 * under the normalized slug (`permission.legacy.root` is read as
 * `permission-legacy-root`) as well as under the spelling given.
 */
export function slugBreakGlassReasons(raw: string, lookup: (slug: string) => TagDefinition | null): string[] {
  const given = raw.trim().toLowerCase();
  const normalized = normalizePermissionTag(raw) ?? given;
  const slugs = [...new Set([normalized, given].filter(Boolean))];
  return [...new Set(slugs.flatMap((slug) => tagDefinitionBreakGlassReasons(slug, lookup(slug))))];
}

/**
 * Break-glass a chat grant's profile confers, read the way the provider reads
 * grants: the slug exactly as stored (admin names and the definition under that
 * slug), with no spelling normalization. Tags are read normalized; grants are not.
 */
export function grantProfileBreakGlassReasons(
  profileSlug: string,
  lookup: (slug: string) => TagDefinition | null,
): string[] {
  const slug = profileSlug.trim();
  const reasons = ADMIN_PROFILE_SLUGS.includes(slug) ? [`${slug} (admin profile)`] : [];
  const definition = lookup(slug);
  const capabilities =
    isPermissionProfileDefinition(definition) && definition ? definitionCapabilities(definition) : [];
  return [...new Set([...reasons, ...breakGlassCapabilities(capabilities)])];
}
