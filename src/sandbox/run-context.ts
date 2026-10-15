// Sandbox run authority: the pair of runtime contexts a connected sandbox run
// dispatches with on the home daemon (Console `sandbox-gateway/listener` SPEC
// §Authorization And Dispatch; OSS `.ravi/specs/sandbox/listener`).
//
// Root `sandbox-run-root` snapshots the home agent's own capabilities; the
// child `sandbox-run` holds EXACTLY the grant caps that root authorizes for
// the concrete home task (grant ∩ local). A grant cap the agent lacks is
// dropped and recorded in the child's metadata; nothing is ever added. Only
// the host CLI (06b) creates this authority, from the grant it received at
// mint and verified with 04a; the listener only reads it and never mints.

import { canWithCapabilityContext, isAgentSuperadmin } from "../permissions/provider-runtime.js";
import { type ContextCapability, type ContextRecord, dbGetAgent, dbGetContext } from "../router/router-db.js";
import {
  createRuntimeContext,
  issueRuntimeContext,
  revokeRuntimeContext,
  snapshotAgentCapabilities,
} from "../runtime/context-registry.js";
import {
  canonicalizeStringList,
  isAllowlistedSandboxCommand,
  isSandboxAgentId,
  ORG_ID_RE,
  parseSandboxCap,
  SANDBOX_GRANT_JTI_RE,
  SANDBOX_RUN_ID_RE,
  SANDBOX_TASK_ID_RE,
  INSTALLATION_ID_RE,
} from "../sandbox-listener/contract.js";
import { sha256Base64url } from "../sandbox-listener/gate-assertion.js";
import {
  dbDeleteInactiveSandboxRuns,
  dbGetSandboxRun,
  dbInsertSandboxRun,
  dbPruneAcknowledgedServedJtis,
  dbRevokeSandboxRun,
  type SandboxRunRecord,
} from "./runs-db.js";

export const SANDBOX_RUN_ROOT_CONTEXT_KIND = "sandbox-run-root";
export const SANDBOX_RUN_CONTEXT_KIND = "sandbox-run";
/** Acknowledged served-jti rows are kept this long after acknowledgement (covers the replay window twice over). */
export const SANDBOX_ACKNOWLEDGED_JTI_RETENTION_MS = 10 * 60 * 1000;

export type SandboxRunAuthorityErrorCode =
  | "run_id_invalid"
  | "jti_invalid"
  | "agent_invalid"
  | "agent_unknown"
  | "agent_superadmin"
  | "task_invalid"
  | "org_invalid"
  | "installation_invalid"
  | "cmds_invalid"
  | "grant_required"
  | "expires_invalid"
  | "run_exists";

export class SandboxRunAuthorityError extends Error {
  constructor(
    readonly code: SandboxRunAuthorityErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SandboxRunAuthorityError";
  }
}

export interface CreateSandboxRunAuthorityInput {
  runId: string;
  /** The grant's `jti`. */
  jti: string;
  /** `grant.agent`: the home agent, never the operator. */
  agentId: string;
  /** `grant.task`. */
  homeTaskId: string | null | undefined;
  /** `grant.caps`, in the daemon capability grammar. */
  caps: readonly string[];
  /** `grant.cmds`. */
  cmds: readonly string[];
  /** The grant compact JWS, already verified by the caller with `verifySandboxGrant`. */
  grant: string;
  org: string;
  installationId: string;
  /** `grant.exp` in Unix milliseconds. */
  expiresAt: number;
  e2bSandboxId?: string | null;
  now?: number;
}

/** A context record without its secret key: run authority is loaded by context id, never presented by key. */
export type SandboxRunContextRecord = Omit<ContextRecord, "contextKey">;

export interface SandboxRunAuthority {
  run: SandboxRunRecord;
  /** The root context, without `contextKey`. */
  root: SandboxRunContextRecord;
  /** The child context, without `contextKey`. */
  child: SandboxRunContextRecord;
  /** Grant caps the agent does not hold locally (or outside the milestone-1 grammar), not granted to the child. */
  droppedCaps: string[];
}

export function createSandboxRunAuthority(input: CreateSandboxRunAuthorityInput): SandboxRunAuthority {
  const now = input.now ?? Date.now();
  if (!SANDBOX_RUN_ID_RE.test(input.runId)) throw new SandboxRunAuthorityError("run_id_invalid", "Invalid run id.");
  if (!SANDBOX_GRANT_JTI_RE.test(input.jti)) throw new SandboxRunAuthorityError("jti_invalid", "Invalid grant jti.");
  if (!isSandboxAgentId(input.agentId)) {
    throw new SandboxRunAuthorityError("agent_invalid", "The grant agent is not a valid sandbox agent id.");
  }
  const homeTaskId = input.homeTaskId ?? null;
  if (homeTaskId !== null && !SANDBOX_TASK_ID_RE.test(homeTaskId)) {
    throw new SandboxRunAuthorityError("task_invalid", "Invalid home task id.");
  }
  if (!ORG_ID_RE.test(input.org)) throw new SandboxRunAuthorityError("org_invalid", "Invalid org id.");
  if (!INSTALLATION_ID_RE.test(input.installationId)) {
    throw new SandboxRunAuthorityError("installation_invalid", "Invalid installation id.");
  }
  if (input.cmds.length === 0 || !input.cmds.every(isAllowlistedSandboxCommand)) {
    throw new SandboxRunAuthorityError("cmds_invalid", "Grant commands are outside the static allowlist.");
  }
  if (typeof input.grant !== "string" || input.grant.length === 0) {
    throw new SandboxRunAuthorityError("grant_required", "The verified grant is required.");
  }
  if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= now) {
    throw new SandboxRunAuthorityError("expires_invalid", "The grant has already expired.");
  }
  if (!dbGetAgent(input.agentId)) {
    throw new SandboxRunAuthorityError("agent_unknown", `Agent not found: ${input.agentId}`);
  }
  if (dbGetSandboxRun(input.runId)) {
    throw new SandboxRunAuthorityError("run_exists", "A run record with this id already exists.");
  }

  const localCapabilities = snapshotAgentCapabilities(input.agentId);
  // A superadmin agent would turn every grant into full authority; the
  // sandbox agent is a non-operator by construction (ADR 0001, 0002 #3).
  if (isAgentSuperadmin(input.agentId) || localCapabilities.some(isAdminSystemCapability)) {
    throw new SandboxRunAuthorityError("agent_superadmin", "A superadmin agent cannot back a sandbox run.");
  }

  const root = createRuntimeContext({
    kind: SANDBOX_RUN_ROOT_CONTEXT_KIND,
    agentId: input.agentId,
    capabilities: localCapabilities,
    expiresAt: input.expiresAt,
    metadata: { sandboxRunId: input.runId, authorityMode: "sandbox-run" },
  });

  const kept: ContextCapability[] = [];
  const droppedCaps: string[] = [];
  for (const cap of canonicalizeStringList(input.caps)) {
    const parsed = parseSandboxCap(cap);
    // Milestone 1: only `read|mutate:task:<homeTaskId>`; anything else is dropped, never widened.
    const authorized =
      parsed !== null &&
      parsed.taskId === homeTaskId &&
      canWithCapabilityContext(root, parsed.kind, "task", parsed.taskId);
    if (authorized)
      kept.push({ permission: parsed.kind, objectType: "task", objectId: parsed.taskId, source: "grant" });
    else droppedCaps.push(cap);
  }

  let child: ContextRecord;
  try {
    child = issueRuntimeContext({
      parent: root,
      cliName: `sandbox-run:${input.runId}`,
      kind: SANDBOX_RUN_CONTEXT_KIND,
      capabilities: kept,
      ttlMs: input.expiresAt - now,
      metadata: {
        sandboxRunId: input.runId,
        grantJti: input.jti,
        homeTaskId,
        cmds: canonicalizeStringList(input.cmds),
        droppedCaps,
      },
    });
  } catch (error) {
    revokeRuntimeContext(root.contextId, { cascade: true, reason: "sandbox_run_issue_failed" });
    throw error;
  }

  let run: SandboxRunRecord;
  try {
    run = dbInsertSandboxRun({
      runId: input.runId,
      jti: input.jti,
      agentId: input.agentId,
      homeTaskId,
      caps: canonicalizeStringList(input.caps),
      cmds: canonicalizeStringList(input.cmds),
      grantJws: input.grant,
      grantSha256: sha256Base64url(input.grant),
      org: input.org,
      installationId: input.installationId,
      rootContextId: root.contextId,
      contextId: child.contextId,
      e2bSandboxId: input.e2bSandboxId ?? null,
      createdAt: now,
      expiresAt: input.expiresAt,
    });
  } catch (error) {
    revokeRuntimeContext(root.contextId, { cascade: true, reason: "sandbox_run_insert_failed" });
    throw error;
  }
  // No caller presents these contexts by key (the listener loads the child by
  // id), so the keys never leave this function.
  return { run, root: withoutContextKey(root), child: withoutContextKey(child), droppedCaps };
}

function withoutContextKey(record: ContextRecord): SandboxRunContextRecord {
  const { contextKey: _contextKey, ...rest } = record;
  return rest;
}

function isAdminSystemCapability(capability: ContextCapability): boolean {
  return capability.permission === "admin" && capability.objectType === "system" && capability.objectId === "*";
}

export interface RevokeSandboxRunResult {
  run: SandboxRunRecord;
  revokedContextIds: string[];
}

/** Revokes the root (cascading to the child) and blanks the stored grant. Idempotent. */
export function revokeSandboxRun(
  runId: string,
  reason = "sandbox_run_revoked",
  now = Date.now(),
): RevokeSandboxRunResult | null {
  const existing = dbGetSandboxRun(runId);
  if (!existing) return null;
  const revokedContextIds: string[] = [];
  const root = dbGetContext(existing.rootContextId);
  if (root && !root.revokedAt) {
    const result = revokeRuntimeContext(root.contextId, { cascade: true, reason, revokedAt: now });
    revokedContextIds.push(result.context.contextId, ...result.cascaded.map((ctx) => ctx.contextId));
  }
  const run = dbRevokeSandboxRun(runId, reason, now) ?? existing;
  return { run, revokedContextIds };
}

/** The run row when it exists, is not revoked and has not expired; otherwise null. */
export function getLiveSandboxRun(runId: string, now = Date.now()): SandboxRunRecord | null {
  const run = dbGetSandboxRun(runId);
  if (!run || run.revokedAt !== null || run.expiresAt <= now || run.grantJws === null) return null;
  return run;
}

/** The run's child context, only while it is live and still bound to the run's agent. */
export function getLiveSandboxRunContext(run: SandboxRunRecord, now = Date.now()): ContextRecord | null {
  const child = dbGetContext(run.contextId);
  if (!child || child.kind !== SANDBOX_RUN_CONTEXT_KIND || child.agentId !== run.agentId) return null;
  if (child.revokedAt && child.revokedAt <= now) return null;
  if (child.expiresAt && child.expiresAt <= now) return null;
  if (child.metadata?.parentContextId !== run.rootContextId) return null;
  return child;
}

/**
 * Every daemon start, listener configured or not: revoke and delete every expired or revoked run and drop
 * acknowledged served jtis past retention. Unacknowledged served jtis are
 * never touched (they still have to reach Console).
 */
export function pruneSandboxRunsAtStart(now = Date.now()): { runsDeleted: number; jtisPruned: number } {
  const inactive = dbDeleteInactiveSandboxRuns(now);
  for (const run of inactive) {
    const root = dbGetContext(run.rootContextId);
    if (root && !root.revokedAt) {
      revokeRuntimeContext(root.contextId, { cascade: true, reason: "sandbox_run_expired", revokedAt: now });
    }
  }
  const jtisPruned = dbPruneAcknowledgedServedJtis(now - SANDBOX_ACKNOWLEDGED_JTI_RETENTION_MS);
  return { runsDeleted: inactive.length, jtisPruned };
}
