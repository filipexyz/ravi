import { cronOwnerActsAsOperator } from "../link/connector-turn.js";
import { dbGetAgent, getDefaultAgentId } from "../router/router-db.js";
import { createRuntimeContext, revokeRuntimeContext, snapshotAgentCapabilities } from "../runtime/context-registry.js";
import type { ContextRecord } from "../router/router-db.js";
import type { CronRunAuthority } from "./authority.js";
import type { CronJob } from "./types.js";
import { CRON_SHELL_CONTEXT_KIND } from "./shell-context-kind.js";

export { CRON_SHELL_CONTEXT_KIND, isShellCronRootContext } from "./shell-context-kind.js";

/** Revocation reason when the shell command ends (any outcome). */
export const CRON_SHELL_CONTEXT_DONE_REASON = "cron_shell_completed";
/** Extra lifetime past the command's timeout, so a slow exit does not lose the key mid-call. */
const CRON_SHELL_CONTEXT_GRACE_MS = 60_000;

export interface ShellCronContext {
  context: ContextRecord;
  /** Revoke the context; safe to call more than once. */
  release: () => void;
}

export interface ShellCronContextDeps {
  ownerActsAsOperator?: (ownerPrincipal: string) => boolean;
  defaultAgentId?: () => string;
  capabilitiesFor?: (agentId: string) => ReturnType<typeof snapshotAgentCapabilities>;
  agentExists?: (agentId: string) => boolean;
}

/**
 * The context a shell cron run carries as `RAVI_CONTEXT_KEY`, so `ravi ...`
 * inside the command reaches the installed daemon's gateway and acts for the
 * job's owner (Bases, Pages and every other command), instead of falling back
 * to a local CLI that may not open the real state.
 *
 * Only a run whose admitted owner acts as the operator gets one: shell jobs are
 * operator-only (connectors 13b), and a job with no traceable human owner, or
 * one transferred to a contact, runs as before, with no key. The context:
 *
 * - is a root `cron-shell` context the daemon creates (never a CLI child), so
 *   its `cronRunAuthority` snapshot is honored like a cron turn's;
 * - carries the job's agent capabilities (the same ceiling an agent cron turn
 *   of that agent has), never more;
 * - expires shortly after the command's timeout and is revoked as soon as the
 *   command ends.
 */
export function issueShellCronContext(
  job: Pick<CronJob, "id" | "agentId">,
  authority: CronRunAuthority,
  timeoutMs: number,
  deps: ShellCronContextDeps = {},
): ShellCronContext | null {
  if (authority.jobId !== job.id || !authority.ownerIsOperator) return null;
  const actsAsOperator = deps.ownerActsAsOperator ?? ((owner: string) => cronOwnerActsAsOperator(owner));
  if (!actsAsOperator(authority.ownerPrincipal)) return null;
  const agentId = job.agentId ?? (deps.defaultAgentId ?? getDefaultAgentId)();
  // Capabilities come from a real agent; a job naming a missing one runs as
  // before, with no key, instead of failing the command.
  if (!(deps.agentExists ?? ((id: string) => Boolean(dbGetAgent(id))))(agentId)) return null;
  const context = createRuntimeContext({
    kind: CRON_SHELL_CONTEXT_KIND,
    agentId,
    capabilities: (deps.capabilitiesFor ?? snapshotAgentCapabilities)(agentId),
    ttlMs: Math.max(1, timeoutMs) + CRON_SHELL_CONTEXT_GRACE_MS,
    metadata: {
      actorPrincipal: `automation:cron:${job.id}`,
      actorResolution: "resolved",
      executorAgentId: agentId,
      cronRunAuthority: authority,
      source: "cron-shell",
    },
  });
  let released = false;
  return {
    context,
    release: () => {
      if (released) return;
      released = true;
      revokeRuntimeContext(context.contextId, { cascade: true, reason: CRON_SHELL_CONTEXT_DONE_REASON });
    },
  };
}

/** Replace every occurrence of the key in captured output before it is logged or stored. */
export function redactContextKey(text: string, key: string | undefined): string {
  if (!key || !text) return text;
  return text.split(key).join("[REDACTED:context-key]");
}
