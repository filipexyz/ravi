import { hostname } from "node:os";
import { logger } from "../utils/logger.js";
import { cronOwnerActsAsOperator } from "../link/connector-turn.js";
import { dbGetAgent, getDefaultAgentId } from "../router/router-db.js";
import { createRuntimeContext, revokeRuntimeContext, snapshotAgentCapabilities } from "../runtime/context-registry.js";
import { dbListContexts, type ContextRecord } from "../router/router-db.js";
import { canWithCapabilities } from "../permissions/provider-runtime.js";
import { listCliCommandAccessCandidates } from "../cli/command-access.js";
import type { ContextCapability } from "../router/router-db.js";
import type { CronRunAuthority } from "./authority.js";
import type { CronJob } from "./types.js";
import { CRON_SHELL_CONTEXT_KIND } from "./shell-context-kind.js";

export { CRON_SHELL_CONTEXT_KIND, isShellCronRootContext } from "./shell-context-kind.js";

const log = logger.child("cron:shell-context");

/**
 * The only commands a shell cron run's context may reach: Bases (bases list
 * and show; rows query, get, history, export, add, update, archive, restore;
 * views list, show, query), Pages (list, read, ship) and `self whoami`. Each
 * entry names the CLI group, command and its `@CommandAccess` tuple; a test
 * keeps these in step with the registry.
 */
export const CRON_SHELL_ALLOWED_COMMANDS: ReadonlyArray<{
  group: string;
  command: string;
  kind: "read" | "mutate";
  resource: string;
  action: string;
}> = [
  { group: "bases", command: "list", kind: "read", resource: "bases", action: "list" },
  { group: "bases", command: "show", kind: "read", resource: "bases", action: "show" },
  { group: "bases.rows", command: "query", kind: "read", resource: "bases.rows", action: "query" },
  { group: "bases.rows", command: "get", kind: "read", resource: "bases.rows", action: "get" },
  { group: "bases.rows", command: "history", kind: "read", resource: "bases.rows", action: "history" },
  { group: "bases.rows", command: "export", kind: "read", resource: "bases.rows", action: "export" },
  { group: "bases.rows", command: "add", kind: "mutate", resource: "bases.rows", action: "add" },
  { group: "bases.rows", command: "update", kind: "mutate", resource: "bases.rows", action: "update" },
  { group: "bases.rows", command: "archive", kind: "mutate", resource: "bases.rows", action: "archive" },
  { group: "bases.rows", command: "restore", kind: "mutate", resource: "bases.rows", action: "restore" },
  { group: "bases.views", command: "list", kind: "read", resource: "bases.views", action: "list" },
  { group: "bases.views", command: "show", kind: "read", resource: "bases.views", action: "show" },
  { group: "bases.views", command: "query", kind: "read", resource: "bases.views", action: "query" },
  { group: "pages", command: "list", kind: "read", resource: "pages", action: "list" },
  { group: "pages", command: "read", kind: "read", resource: "pages", action: "read" },
  { group: "pages", command: "ship", kind: "mutate", resource: "pages", action: "ship" },
  { group: "self", command: "whoami", kind: "read", resource: "self", action: "whoami" },
];

/**
 * The narrow tuple of every allowlisted command the job's agent may run.
 * Eligibility uses every grant the gateway itself accepts for that command
 * (`commandAccessCandidates`: the semantic tuple, its wildcards and the legacy
 * `execute:group:*` grants), so the key never loses a command the agent can
 * run directly; the key only ever carries the narrow `kind:resource:action`
 * tuple, never the legacy or wildcard grant that qualified it.
 */
export function scopeCronShellCapabilities(agentCapabilities: ContextCapability[]): ContextCapability[] {
  return CRON_SHELL_ALLOWED_COMMANDS.filter((entry) =>
    listCliCommandAccessCandidates({
      group: entry.group,
      command: entry.command,
      source: "gateway",
      access: { kind: entry.kind, resource: entry.resource, action: entry.action, risk: "low" },
    }).some((candidate) =>
      canWithCapabilities(agentCapabilities, candidate.permission, candidate.objectType, candidate.objectId),
    ),
  ).map((entry) => ({
    permission: entry.kind,
    objectType: entry.resource,
    objectId: entry.action,
    source: "cron-shell",
  }));
}

/** Revocation reason when the daemon starts and finds a dead run's context still live. */
export const CRON_SHELL_CONTEXT_BOOT_REASON = "cron_shell_daemon_restart";

export interface ShellCronIssuer {
  pid: number;
  host: string;
}

export interface OrphanSweepDeps {
  host?: string;
  selfPid?: number;
  /** Whether a process with this pid exists on this host (default: `process.kill(pid, 0)`). */
  isAlive?: (pid: number) => boolean;
  /** Revoke one context (default: cascade revocation with the boot reason). */
  revoke?: (contextId: string) => void;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Revoke the `cron-shell` contexts whose run is provably over, so a key that
 * outlived the daemon that issued it (a crash, a kill) dies before this
 * daemon's gateway accepts any request, instead of at its TTL. Called once
 * at daemon start, before the gateway listens; never on a leadership
 * takeover, so a shell job another live daemon is still running keeps its key.
 *
 * A context is revoked when it records no issuer (an older version, so its
 * run cannot be proven alive), or its issuer is on this host and that process
 * is gone (or its pid is this very process, which cannot have issued it yet).
 * A context issued by a live process, or on another host, is kept: its TTL and
 * the end of its command still bound it. Returns how many were revoked.
 */
export function revokeOrphanedShellCronContexts(deps: OrphanSweepDeps = {}): number {
  const host = deps.host ?? hostname();
  const selfPid = deps.selfPid ?? process.pid;
  const isAlive = deps.isAlive ?? processIsAlive;
  const revoke =
    deps.revoke ??
    ((contextId: string) => revokeRuntimeContext(contextId, { cascade: true, reason: CRON_SHELL_CONTEXT_BOOT_REASON }));
  let revoked = 0;
  for (const context of dbListContexts({ includeInactive: false, kind: CRON_SHELL_CONTEXT_KIND })) {
    const issuer = readShellCronIssuer(context.metadata);
    const dead = !issuer || (issuer.host === host && (issuer.pid === selfPid || !isAlive(issuer.pid)));
    if (!dead) continue;
    try {
      revoke(context.contextId);
      revoked += 1;
    } catch (error) {
      // no-cause: logged with its stack and not rethrown; one context that
      // fails to revoke must not keep the others alive, and it still expires
      // at its TTL.
      log.error("Failed to revoke an orphaned shell cron context", {
        contextId: context.contextId,
        error,
        stack: error instanceof Error ? error.stack : undefined,
      });
    }
  }
  return revoked;
}

function readShellCronIssuer(metadata: Record<string, unknown> | undefined): ShellCronIssuer | null {
  const issuer = metadata?.cronShellIssuer as Record<string, unknown> | undefined;
  if (!issuer || typeof issuer.pid !== "number" || !Number.isInteger(issuer.pid) || issuer.pid <= 0) return null;
  if (typeof issuer.host !== "string" || !issuer.host) return null;
  return { pid: issuer.pid, host: issuer.host };
}

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
 * job's owner on the closed allowlist below (Bases, Pages, `self whoami`),
 * instead of falling back to a local CLI that may not open the real state.
 *
 * Only a run whose admitted owner acts as the operator gets one: shell jobs are
 * operator-only (connectors 13b). A shell job whose owner does not act as the
 * operator (NULL, an agent, a contact) does not run at all: the runner refuses
 * and disables it, so it never reaches this point. The context:
 *
 * - is a root `cron-shell` context the daemon creates (never a CLI child), so
 *   its `cronRunAuthority` snapshot is honored like a cron turn's;
 * - carries only Bases, Pages and `self whoami` capabilities, and of those
 *   only the ones the job's agent has (`scopeCronShellCapabilities`);
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
    capabilities: scopeCronShellCapabilities((deps.capabilitiesFor ?? snapshotAgentCapabilities)(agentId)),
    ttlMs: Math.max(1, timeoutMs) + CRON_SHELL_CONTEXT_GRACE_MS,
    metadata: {
      actorPrincipal: `automation:cron:${job.id}`,
      actorResolution: "resolved",
      executorAgentId: agentId,
      cronRunAuthority: authority,
      // The daemon process that runs the command: a later boot revokes the key
      // once this process is gone (revokeOrphanedShellCronContexts).
      cronShellIssuer: { pid: process.pid, host: hostname() },
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
