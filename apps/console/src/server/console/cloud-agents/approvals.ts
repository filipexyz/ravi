// Approvals: a tool call a cloud run paused on (`evaluated_permission: ask`)
// waits for a person. Approve claims the decision, confirms at the provider and
// rolls the claim back when the provider fails; for a `ravi` write the Console MCP later consumes the approved row
// (same run, tool and input hash) instead of an `rmc1` confirmation.

import { randomUUID } from "node:crypto";

import { and, desc, eq, inArray, isNotNull, isNull, lt } from "drizzle-orm";
import { z } from "zod";

import { db, schema } from "@/server/db";

import { CLOUD_ADMIN_ROLES, assertCloudAgentsEnabled, assertWriteRole, type CloudContext, type ResolvedCloudDeps } from "./access";
import { canonicalJson, sha256Hex } from "./compiler";
import { callProvider, organizationProvider } from "./credential";
import { cloudError, isCloudAgentsError } from "./errors";
import { activeRunWhere, type CloudRunRow, isActiveStatus, loadRunForCaller, mirrorTraceEvents, runUrl } from "./lifecycle";
import type { CloudAgentProvider } from "./providers/types";
import { notifyCloudActor, recordCloudAudit } from "./records";

export const CLOUD_APPROVAL_TTL_MS = 24 * 60 * 60_000;
const CONFIRMATION_ARGUMENT = "confirmationToken";
const DENY_MESSAGE = "A person denied this tool call in Ravi. Do not retry it; explain what you would have done.";
const EXPIRED_MESSAGE = "Nobody approved this tool call in Ravi within 24 hours. Do not retry it.";

const decisionSchema = z
  .object({ decision: z.enum(["approve", "deny"]), reason: z.string().trim().max(500).optional() })
  .strict();

/**
 * The input hash approvals and the Console MCP agree on: sha256 of the
 * canonical JSON of the tool input without `confirmationToken`. Equal to
 * `canonicalInputHash` in `src/server/mcp/console-tools.ts` (a test checks it).
 */
export function toolInputHash(input: unknown) {
  const record = input && typeof input === "object" && !Array.isArray(input) ? { ...(input as Record<string, unknown>) } : input;
  if (record && typeof record === "object" && !Array.isArray(record)) delete (record as Record<string, unknown>)[CONFIRMATION_ARGUMENT];
  return sha256Hex(canonicalJson(record ?? {}));
}

/** One pending approval per tool use the provider paused on; the actor gets an inbox item. */
export async function createApprovals(
  run: CloudRunRow,
  deps: ResolvedCloudDeps,
  toolUses: { id: string; tool: string; server: string | null; input: unknown; at: Date }[],
  agentName: string,
) {
  if (toolUses.length === 0) return [];
  const now = deps.now();
  const values = toolUses.map((toolUse) => {
    const id = randomUUID();
    return {
      id,
      runId: run.id,
      organizationId: run.organizationId,
      providerEventId: toolUse.id,
      toolName: toolUse.tool,
      serverName: toolUse.server,
      inputHash: toolInputHash(toolUse.input),
      inputPreviewEncrypted: deps.codec.encrypt(previewOf(toolUse.input), {
        organizationId: run.organizationId,
        purpose: "approval_input",
        recordId: id,
      }),
      status: "pending",
      expiresAt: new Date(now.getTime() + CLOUD_APPROVAL_TTL_MS),
    };
  });
  const rows = await db
    .insert(schema.cloudAgentApprovals)
    .values(values)
    .onConflictDoNothing()
    .returning();
  if (rows.length === 0) return rows;

  const url = await runUrl(deps, run);
  for (const approval of rows) {
    const inboxItemId = await notifyCloudActor({
      organizationId: run.organizationId,
      projectId: run.projectId,
      userId: run.actorUserId,
      eventType: "cloud_agents.approval.requested",
      severity: "action_required",
      title: `${agentName} asks to run ${approval.toolName}`,
      summary: `A cloud run is waiting for your approval${approval.serverName ? ` (${approval.serverName})` : ""}. It expires in 24 hours.`,
      sourceId: approval.id,
      dedupeKey: `cloud_agents:approval:${approval.id}:requested`,
      url,
      payload: { runId: run.id, approvalId: approval.id, tool: approval.toolName, server: approval.serverName },
      occurredAt: now,
    });
    if (inboxItemId) {
      await db.update(schema.cloudAgentApprovals).set({ inboxItemId }).where(eq(schema.cloudAgentApprovals.id, approval.id));
    }
  }
  await mirrorTraceEvents(
    run,
    rows.map((approval) => ({
      sourceEventId: `approval:${approval.id}:requested`,
      at: now,
      type: "approval" as const,
      tool: approval.toolName,
      status: "pending",
    })),
  );
  return rows;
}

/**
 * Approve or deny one pending approval of a run. The run's actor decides, or
 * an organization owner or admin. The decision is claimed, then sent to the
 * provider; a provider failure puts the approval back to pending. Repeating the
 * same decision resends it while the provider session still waits (idle).
 */
export async function decideCloudApproval(ctx: CloudContext, runId: string, approvalId: string, body: unknown) {
  const deps = await assertCloudAgentsEnabled(ctx);
  assertWriteRole(ctx.workspace);
  const parsed = decisionSchema.safeParse(body);
  if (!parsed.success) throw cloudError("validation_failed", "Send { decision: \"approve\" | \"deny\", reason? }.");
  const { run, agentName } = await loadRunForCaller(ctx, runId, "write");
  if (run.actorUserId !== ctx.workspace.user.id && !CLOUD_ADMIN_ROLES.has(ctx.workspace.membership.role)) {
    throw cloudError("forbidden", "Only the person the run acts for, or an organization owner or admin, decides its approvals.");
  }
  const [approval] = await db
    .select()
    .from(schema.cloudAgentApprovals)
    .where(and(eq(schema.cloudAgentApprovals.id, approvalId), eq(schema.cloudAgentApprovals.runId, run.id)))
    .limit(1);
  if (!approval) throw cloudError("not_found", "Approval not found.");
  const status = parsed.data.decision === "approve" ? "approved" : "denied";
  const active = isActiveStatus(run.status) && Boolean(run.providerSessionId);
  const message = status === "denied" ? (approval.reason ? `${DENY_MESSAGE} Reason: ${approval.reason}` : DENY_MESSAGE) : undefined;

  if (approval.status !== "pending") {
    if (approval.status !== status) throw cloudError("cloud_run_not_active", `This approval is already ${approval.status}.`);
    if (active && !approval.consumedAt) {
      const { provider } = await organizationProvider(run.organizationId, deps);
      await resendWhileWaiting(run, deps, provider, approval.providerEventId, { allow: status === "approved", message });
    }
    return { run, approval, agentName };
  }
  if (!active) throw cloudError("cloud_run_not_active", "The run has ended.");

  const now = deps.now();
  const reason = parsed.data.reason ?? null;
  const [decided] = await db
    .update(schema.cloudAgentApprovals)
    .set({ status, decidedByUserId: ctx.workspace.user.id, decidedAt: now, reason, updatedAt: now })
    .where(and(eq(schema.cloudAgentApprovals.id, approval.id), eq(schema.cloudAgentApprovals.status, "pending")))
    .returning();
  if (!decided) throw cloudError("cloud_run_not_active", "This approval was decided meanwhile.");
  try {
    const { provider } = await organizationProvider(run.organizationId, deps);
    await callProvider(run.organizationId, deps, () =>
      provider.confirmTool(run.providerSessionId!, approval.providerEventId, {
        allow: status === "approved",
        message: status === "denied" ? (reason ? `${DENY_MESSAGE} Reason: ${reason}` : DENY_MESSAGE) : undefined,
      }),
    );
  } catch (error) {
    await db
      .update(schema.cloudAgentApprovals)
      .set({ status: "pending", decidedByUserId: null, decidedAt: null, reason: null, updatedAt: deps.now() })
      .where(
        and(eq(schema.cloudAgentApprovals.id, approval.id), eq(schema.cloudAgentApprovals.status, status), isNull(schema.cloudAgentApprovals.consumedAt)),
      );
    throw error;
  }

  await recordCloudAudit({
    organizationId: run.organizationId,
    projectId: run.projectId,
    actorType: ctx.surface === "cli" ? "cli" : "user",
    actorId: ctx.workspace.user.id,
    action: "cloud_agents.approval.decided",
    targetType: "cloud_agent_approval",
    targetId: approval.id,
    requestId: ctx.requestId,
    after: { runId: run.id, tool: approval.toolName, server: approval.serverName, decision: status },
  });
  await mirrorTraceEvents(run, [{ sourceEventId: `approval:${approval.id}:decided`, at: now, type: "approval", tool: approval.toolName, status }]);

  // The next status comes from the provider's events; until then the run runs.
  const remaining = await pendingApprovalCount(run.id);
  if (remaining === 0) {
    await db.update(schema.cloudAgentRuns).set({ status: "running", updatedAt: now }).where(activeRunWhere(run.id));
  }
  return { run: { ...run, status: remaining === 0 ? "running" : run.status }, approval: decided, agentName };
}

/** Resends a decision the provider may have lost: only while its session is idle (still waiting). */
async function resendWhileWaiting(
  run: CloudRunRow,
  deps: ResolvedCloudDeps,
  provider: CloudAgentProvider,
  toolUseId: string,
  decision: { allow: boolean; message?: string },
) {
  const session = await callProvider(run.organizationId, deps, () => provider.getSession(run.providerSessionId!));
  if (session?.status !== "idle") return;
  try {
    await callProvider(run.organizationId, deps, () => provider.confirmTool(run.providerSessionId!, toolUseId, decision));
  } catch (error) {
    // The provider already took this decision (the session idles for another reason).
    if (isCloudAgentsError(error, "provider_error") && error.details?.kind === "invalid_request") return;
    throw error;
  }
  if ((await pendingApprovalCount(run.id)) === 0) {
    await db.update(schema.cloudAgentRuns).set({ status: "running", updatedAt: deps.now() }).where(activeRunWhere(run.id));
  }
}

export async function pendingApprovalCount(runId: string) {
  const rows = await db
    .select({ id: schema.cloudAgentApprovals.id })
    .from(schema.cloudAgentApprovals)
    .where(and(eq(schema.cloudAgentApprovals.runId, runId), eq(schema.cloudAgentApprovals.status, "pending")));
  return rows.length;
}

/** When the run's latest decision was taken, or null when none was. */
export async function latestDecisionAt(runId: string) {
  const [row] = await db
    .select({ decidedAt: schema.cloudAgentApprovals.decidedAt })
    .from(schema.cloudAgentApprovals)
    .where(and(eq(schema.cloudAgentApprovals.runId, runId), isNotNull(schema.cloudAgentApprovals.decidedAt)))
    .orderBy(desc(schema.cloudAgentApprovals.decidedAt))
    .limit(1);
  return row?.decidedAt ?? null;
}

/** Tick: pending approvals older than 24 h expire and are denied at the provider. */
export async function expireCloudApprovals(deps: ResolvedCloudDeps, limit = 50) {
  const now = deps.now();
  const expired = await db
    .update(schema.cloudAgentApprovals)
    .set({ status: "expired", updatedAt: now })
    .where(
      inArray(
        schema.cloudAgentApprovals.id,
        db
          .select({ id: schema.cloudAgentApprovals.id })
          .from(schema.cloudAgentApprovals)
          .where(and(eq(schema.cloudAgentApprovals.status, "pending"), lt(schema.cloudAgentApprovals.expiresAt, now)))
          .limit(limit),
      ),
    )
    .returning();
  for (const approval of expired) {
    const [run] = await db.select().from(schema.cloudAgentRuns).where(eq(schema.cloudAgentRuns.id, approval.runId)).limit(1);
    if (!run?.providerSessionId || !isActiveStatus(run.status)) continue;
    try {
      const { provider } = await organizationProvider(run.organizationId, deps);
      await callProvider(run.organizationId, deps, () =>
        provider.confirmTool(run.providerSessionId!, approval.providerEventId, { allow: false, message: EXPIRED_MESSAGE }),
      );
    } catch {
      // The run's next sync records the provider's state; the approval stays expired.
    }
  }
  return expired.length;
}

export async function listRunApprovals(runIds: readonly string[]) {
  if (runIds.length === 0) return [];
  return db
    .select({
      approval: schema.cloudAgentApprovals,
      deciderName: schema.users.displayName,
      deciderEmail: schema.users.primaryEmail,
    })
    .from(schema.cloudAgentApprovals)
    .leftJoin(schema.users, eq(schema.users.id, schema.cloudAgentApprovals.decidedByUserId))
    .where(inArray(schema.cloudAgentApprovals.runId, [...runIds]))
    .orderBy(schema.cloudAgentApprovals.createdAt);
}

function previewOf(input: unknown) {
  let text: string;
  try {
    text = JSON.stringify(input, null, 2) ?? "";
  } catch {
    text = String(input);
  }
  return text.length > 2000 ? `${text.slice(0, 1999)}…` : text;
}
