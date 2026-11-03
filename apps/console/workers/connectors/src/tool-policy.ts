/**
 * Tool policies: may a capability run on a connection, and does it need
 * the owner's (or, for an organization account, the manager's) approval
 * first.
 *
 * The effective policy is the strictest of
 *   - the organization ceiling for the capability (`tool_ceilings_json`),
 *   - `writes_allowed = false`, which blocks every write and destructive tool,
 *   - the owner's or manager's choice (`connector_tool_policies`), or, when
 *     nobody has chosen, the default: on a personal connection reads are
 *     always allowed and writes and destructive tools need approval; on a
 *     shared organization account reads are blocked (except free/busy) and
 *     writes need approval.
 * Order: blocked > needs_approval > always_allow. On exec, an agent acting
 * for the person asking also never writes without that person's approval
 * (`proxy.ts`), whatever their own choice says.
 */

import type { CapabilityClass } from "./capabilities/registry";

export type ToolPolicy = "always_allow" | "needs_approval" | "blocked";

export const TOOL_POLICIES: readonly ToolPolicy[] = ["always_allow", "needs_approval", "blocked"];

const STRICTNESS: Record<ToolPolicy, number> = {
  always_allow: 0,
  needs_approval: 1,
  blocked: 2,
};

export function isToolPolicy(value: unknown): value is ToolPolicy {
  return value === "always_allow" || value === "needs_approval" || value === "blocked";
}

export function defaultToolPolicy(capabilityClass: CapabilityClass): ToolPolicy {
  return capabilityClass === "read" ? "always_allow" : "needs_approval";
}

/** Reads a shared organization account allows unless its manager says otherwise. */
export const SHARED_ALLOWED_READS: ReadonlySet<string> = new Set(["gcal.freebusy.query"]);

/**
 * The default on a shared organization account: an agent answering anyone
 * in a conversation must not read the organization's mail or calendar, so
 * reads are blocked except free/busy; writes need the manager's approval.
 */
export function sharedDefaultToolPolicy(capability: { id: string; class: CapabilityClass }): ToolPolicy {
  if (capability.class !== "read") return "needs_approval";
  return SHARED_ALLOWED_READS.has(capability.id) ? "always_allow" : "blocked";
}

/** The strictest of the given policies; `always_allow` when none is given. */
export function strictestToolPolicy(...policies: (ToolPolicy | null | undefined)[]): ToolPolicy {
  let result: ToolPolicy = "always_allow";
  for (const policy of policies) {
    if (policy && STRICTNESS[policy] > STRICTNESS[result]) result = policy;
  }
  return result;
}

/** `policy` allows more than `ceiling`. */
export function isLooserThan(policy: ToolPolicy, ceiling: ToolPolicy | null): boolean {
  return ceiling !== null && STRICTNESS[policy] < STRICTNESS[ceiling];
}

/**
 * The organization's ceiling for one capability, `null` when the
 * organization sets none. A stored value that is not a policy fails
 * closed (`blocked`).
 */
export function toolPolicyCeiling(input: {
  capabilityClass: CapabilityClass;
  ceiling: unknown;
  writesAllowed: boolean;
}): ToolPolicy | null {
  const stored = input.ceiling === undefined || input.ceiling === null
    ? null
    : isToolPolicy(input.ceiling) ? input.ceiling : "blocked";
  const writesBlocked = !input.writesAllowed && input.capabilityClass !== "read" ? "blocked" : null;
  if (!stored && !writesBlocked) return null;
  return strictestToolPolicy(stored, writesBlocked);
}

export function effectiveToolPolicy(input: {
  capabilityClass: CapabilityClass;
  ceiling: unknown;
  writesAllowed: boolean;
  userPolicy: ToolPolicy | null;
  /** What applies when nobody chose; the class default when left out. */
  defaultPolicy?: ToolPolicy;
}): ToolPolicy {
  return strictestToolPolicy(
    toolPolicyCeiling(input),
    input.userPolicy ?? input.defaultPolicy ?? defaultToolPolicy(input.capabilityClass),
  );
}
