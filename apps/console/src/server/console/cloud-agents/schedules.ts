// Console-owned schedules (D8): a 5-field cron in a timezone, a prompt (null
// runs the agent's HEARTBEAT.md), and the person who scheduled it, as whom
// every scheduled run acts (D6).

import { randomUUID } from "node:crypto";

import { and, eq, lte, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";

import { canAccessProject } from "@/server/console/project-access";
import { isUuidRef } from "@/server/console/ref";
import { db, schema } from "@/server/db";

import {
  activeMemberRole,
  assertCloudAgentsEnabled,
  CLOUD_WRITE_ROLES,
  type CloudContext,
  type CloudDeps,
  requireCloudProject,
  type ResolvedCloudDeps,
} from "./access";
import { nextCronRun } from "./cron";
import { CloudDefinitionError, parseBudgetUsd, parseSchedule } from "./definition";
import { type CloudAgentConfig, type CloudAgentRow, deployedAgentFiles, deployInProject, loadAgentForCaller, personName } from "./deploy";
import { cloudError, errorSummary } from "./errors";
import { recordCloudAudit } from "./records";
import { startCloudRun } from "./runs";
import type { CloudSchedule } from "./types";

const MAX_PROMPT_CHARS = 100_000;

const createSchema = z
  .object({
    project: z.string().trim().min(1).max(200),
    agent: z.string().trim().min(1).max(200),
    cron: z.string().trim().min(1).max(120),
    timezone: z.string().trim().min(1).max(64),
    prompt: z.string().min(1).max(MAX_PROMPT_CHARS).nullable().optional(),
    budgetUsd: z.number().nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

const updateSchema = z
  .object({
    cron: z.string().trim().min(1).max(120).optional(),
    timezone: z.string().trim().min(1).max(64).optional(),
    prompt: z.string().min(1).max(MAX_PROMPT_CHARS).nullable().optional(),
    budgetUsd: z.number().nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

type ScheduleRow = typeof schema.cloudAgentSchedules.$inferSelect;

export async function listCloudSchedules(ctx: CloudContext, projectRef: unknown): Promise<{ schedules: CloudSchedule[] }> {
  const deps = await assertCloudAgentsEnabled(ctx);
  const project = await requireCloudProject(ctx.workspace, projectRef, "read");
  return { schedules: await selectSchedules(deps, eq(schema.cloudAgentSchedules.projectId, project.id)) };
}

export async function createCloudSchedule(ctx: CloudContext, body: unknown): Promise<{ schedule: CloudSchedule }> {
  const deps = await assertCloudAgentsEnabled(ctx);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) throw cloudError("validation_failed", "Send { project, agent, cron, timezone, prompt?, budgetUsd?, enabled? }.");
  const input = parsed.data;
  const project = await requireCloudProject(ctx.workspace, input.project, "write");
  const timing = validTiming(input.cron, input.timezone);
  const budgetCents = budgetCentsOf(input.budgetUsd);
  const agent = await scheduleAgent(ctx, deps, project, input.agent);
  const prompt = input.prompt ?? null;
  if (prompt === null && !(agent.configJson as Partial<CloudAgentConfig>).hasHeartbeat) {
    throw cloudError("validation_failed", "This agent has no HEARTBEAT.md: give the schedule a prompt.");
  }
  const now = deps.now();
  const enabled = input.enabled ?? true;
  const id = randomUUID();
  const [row] = await db
    .insert(schema.cloudAgentSchedules)
    .values({
      id,
      organizationId: project.organizationId,
      projectId: project.id,
      agentId: agent.id,
      cron: timing.cron,
      timezone: timing.timezone,
      promptEncrypted: prompt === null ? null : deps.codec.encrypt(prompt, { organizationId: project.organizationId, purpose: "schedule_prompt", recordId: id }),
      actorUserId: ctx.workspace.user.id,
      budgetUsdCents: budgetCents,
      enabled,
      nextRunAt: enabled ? nextCronRun(timing.cron, timing.timezone, now) : null,
    })
    .returning();
  await audit(ctx, row!, "cloud_agents.schedule.created", null, scheduleAuditView(row!));
  return { schedule: await serializeScheduleById(deps, row!.id) };
}

export async function updateCloudSchedule(ctx: CloudContext, scheduleId: string, body: unknown): Promise<{ schedule: CloudSchedule }> {
  const deps = await assertCloudAgentsEnabled(ctx);
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) throw cloudError("validation_failed", "Send any of { cron, timezone, prompt, budgetUsd, enabled }.");
  const row = await loadScheduleForCaller(ctx, scheduleId);
  const input = parsed.data;
  const timing = validTiming(input.cron ?? row.cron, input.timezone ?? row.timezone);
  const now = deps.now();
  const changes: Partial<ScheduleRow> = { cron: timing.cron, timezone: timing.timezone, updatedAt: now, lastError: null };
  // What a scheduled run does is the editor's choice from now on, so it acts for them (D6).
  let redefined = timing.cron !== row.cron || timing.timezone !== row.timezone;
  if (input.budgetUsd !== undefined) {
    changes.budgetUsdCents = budgetCentsOf(input.budgetUsd);
    redefined ||= changes.budgetUsdCents !== row.budgetUsdCents;
  }
  if (input.prompt !== undefined) {
    const current = row.promptEncrypted
      ? deps.codec.decrypt(row.promptEncrypted, { organizationId: row.organizationId, purpose: "schedule_prompt", recordId: row.id })
      : null;
    redefined ||= input.prompt !== current;
    if (input.prompt === null) {
      const [agent] = await db.select().from(schema.cloudAgents).where(eq(schema.cloudAgents.id, row.agentId)).limit(1);
      if (!(agent?.configJson as Partial<CloudAgentConfig> | undefined)?.hasHeartbeat) {
        throw cloudError("validation_failed", "This agent has no HEARTBEAT.md: keep a prompt.");
      }
      changes.promptEncrypted = null;
    } else {
      changes.promptEncrypted = deps.codec.encrypt(input.prompt, { organizationId: row.organizationId, purpose: "schedule_prompt", recordId: row.id });
    }
  }
  const enabled = input.enabled ?? row.enabled;
  changes.enabled = enabled;
  // Turning a schedule back on, or changing what it runs, makes the editor its actor.
  if (redefined || (input.enabled === true && !row.enabled)) changes.actorUserId = ctx.workspace.user.id;
  changes.nextRunAt = enabled ? nextCronRun(timing.cron, timing.timezone, now) : null;
  const [updated] = await db.update(schema.cloudAgentSchedules).set(changes).where(eq(schema.cloudAgentSchedules.id, row.id)).returning();
  await audit(ctx, updated!, "cloud_agents.schedule.updated", scheduleAuditView(row), scheduleAuditView(updated!));
  return { schedule: await serializeScheduleById(deps, row.id) };
}

export async function deleteCloudSchedule(ctx: CloudContext, scheduleId: string): Promise<{ deleted: true; id: string }> {
  await assertCloudAgentsEnabled(ctx);
  const row = await loadScheduleForCaller(ctx, scheduleId);
  await db.delete(schema.cloudAgentSchedules).where(eq(schema.cloudAgentSchedules.id, row.id));
  await audit(ctx, row, "cloud_agents.schedule.deleted", scheduleAuditView(row), null);
  return { deleted: true, id: row.id };
}

/**
 * Tick: starts each due schedule once per `next_run_at`, as its actor. The
 * slot is claimed by moving `next_run_at` forward before the run starts; the
 * run's idempotency key is the slot, so a retried tick never starts it twice.
 * A schedule whose actor may no longer run is disabled.
 */
export async function runDueCloudSchedules(cloudDeps: CloudDeps, deps: ResolvedCloudDeps, limit = 20, shouldStop: () => boolean = () => false) {
  const now = deps.now();
  const due = await db
    .select()
    .from(schema.cloudAgentSchedules)
    .where(and(eq(schema.cloudAgentSchedules.enabled, true), lte(schema.cloudAgentSchedules.nextRunAt, now)))
    .orderBy(schema.cloudAgentSchedules.nextRunAt)
    .limit(limit);
  let started = 0;
  let disabled = 0;
  for (const schedule of due) {
    // Unclaimed slots stay due for the next tick.
    if (shouldStop()) break;
    const slot = schedule.nextRunAt!;
    const next = nextCronRun(schedule.cron, schedule.timezone, now);
    const [claimed] = await db
      .update(schema.cloudAgentSchedules)
      .set({ nextRunAt: next, updatedAt: now })
      .where(and(eq(schema.cloudAgentSchedules.id, schedule.id), eq(schema.cloudAgentSchedules.nextRunAt, slot)))
      .returning();
    if (!claimed) continue;

    const role = await activeMemberRole(schedule.organizationId, schedule.actorUserId);
    const [agent] = await db.select().from(schema.cloudAgents).where(eq(schema.cloudAgents.id, schedule.agentId)).limit(1);
    const workspace = { user: { id: schedule.actorUserId }, organization: { id: schedule.organizationId }, membership: { role: role ?? "none" } };
    const allowed =
      role !== null &&
      CLOUD_WRITE_ROLES.has(role) &&
      agent !== undefined &&
      agent.status !== "archived" &&
      (await canAccessProject(workspace, schedule.projectId, "write"));
    if (!allowed) {
      await db
        .update(schema.cloudAgentSchedules)
        .set({ enabled: false, nextRunAt: null, lastError: "The person who scheduled this can no longer run this agent.", updatedAt: now })
        .where(eq(schema.cloudAgentSchedules.id, schedule.id));
      await recordCloudAudit({
        organizationId: schedule.organizationId,
        projectId: schedule.projectId,
        actorType: "system",
        actorId: null,
        action: "cloud_agents.schedule.disabled",
        targetType: "cloud_agent_schedule",
        targetId: schedule.id,
        requestId: null,
        metadata: { reason: "actor_lost_access", actorUserId: schedule.actorUserId },
      });
      disabled += 1;
      continue;
    }

    try {
      const prompt = schedule.promptEncrypted
        ? deps.codec.decrypt(schedule.promptEncrypted, { organizationId: schedule.organizationId, purpose: "schedule_prompt", recordId: schedule.id })
        : (await deployedAgentFiles(agent)).find((file) => file.path === "HEARTBEAT.md")?.content.trim();
      if (!prompt) throw cloudError("validation_failed", "The schedule has no prompt and the agent no HEARTBEAT.md.");
      const { run } = await startCloudRun(
        { workspace, requestId: `schedule:${schedule.id}`, surface: "tick", deps: cloudDeps },
        {
          project: schedule.projectId,
          agent: schedule.agentId,
          prompt,
          ...(schedule.budgetUsdCents !== null ? { budgetUsd: schedule.budgetUsdCents / 100 } : {}),
          idempotencyKey: `schedule:${schedule.id}:${slot.toISOString()}`,
        },
        { trigger: "schedule", scheduleId: schedule.id },
      );
      await db
        .update(schema.cloudAgentSchedules)
        .set({ lastRunAt: now, lastRunId: run.id, lastError: null, updatedAt: now })
        .where(eq(schema.cloudAgentSchedules.id, schedule.id));
      started += 1;
    } catch (error) {
      const summary = errorSummary(error);
      const runId = (error as { details?: { runId?: unknown } }).details?.runId;
      await db
        .update(schema.cloudAgentSchedules)
        .set({
          lastRunAt: now,
          ...(typeof runId === "string" ? { lastRunId: runId } : {}),
          lastError: `${summary.code}: ${summary.message}`.slice(0, 500),
          updatedAt: now,
        })
        .where(eq(schema.cloudAgentSchedules.id, schedule.id));
    }
  }
  return { due: due.length, started, disabled };
}

// ---------------------------------------------------------------------------

async function scheduleAgent(
  ctx: CloudContext,
  deps: ResolvedCloudDeps,
  project: { id: string; slug: string; organizationId: string },
  agentRef: string,
): Promise<CloudAgentRow> {
  if (isUuidRef(agentRef)) {
    const [row] = await db
      .select()
      .from(schema.cloudAgents)
      .where(and(eq(schema.cloudAgents.id, agentRef), eq(schema.cloudAgents.projectId, project.id), ne(schema.cloudAgents.status, "archived")))
      .limit(1);
    if (row) return row;
  }
  const existing = await db
    .select({ agent: schema.cloudAgents })
    .from(schema.cloudAgents)
    .innerJoin(schema.libraryItems, eq(schema.libraryItems.id, schema.cloudAgents.libraryItemId))
    .where(
      and(
        eq(schema.cloudAgents.projectId, project.id),
        eq(schema.cloudAgents.status, "ready"),
        isUuidRef(agentRef) ? eq(schema.libraryItems.id, agentRef) : eq(schema.libraryItems.slug, agentRef),
      ),
    )
    .orderBy(sql`${schema.libraryItems.projectId} is null`)
    .limit(1);
  if (existing[0]) return existing[0].agent;
  return (await deployInProject(ctx, deps, { project, agentRef, versionNumber: null })).row;
}

async function loadScheduleForCaller(ctx: CloudContext, scheduleId: string) {
  if (!isUuidRef(scheduleId)) throw cloudError("not_found", "Schedule not found.");
  const [row] = await db
    .select()
    .from(schema.cloudAgentSchedules)
    .where(and(eq(schema.cloudAgentSchedules.id, scheduleId), eq(schema.cloudAgentSchedules.organizationId, ctx.workspace.organization.id)))
    .limit(1);
  if (!row) throw cloudError("not_found", "Schedule not found.");
  await loadAgentForCaller(ctx, row.agentId, "write");
  return row;
}

function validTiming(cron: string, timezone: string) {
  try {
    return parseSchedule(cron, timezone);
  } catch (error) {
    if (error instanceof CloudDefinitionError) throw cloudError("validation_failed", error.message);
    throw error;
  }
}

function budgetCentsOf(budgetUsd: number | null | undefined) {
  if (budgetUsd === undefined || budgetUsd === null) return null;
  try {
    return Math.round(parseBudgetUsd(budgetUsd) * 100);
  } catch (error) {
    if (error instanceof CloudDefinitionError) throw cloudError("validation_failed", error.message);
    throw error;
  }
}

function scheduleAuditView(row: ScheduleRow) {
  return {
    agentId: row.agentId,
    cron: row.cron,
    timezone: row.timezone,
    enabled: row.enabled,
    budgetUsdCents: row.budgetUsdCents,
    hasPrompt: row.promptEncrypted !== null,
    actorUserId: row.actorUserId,
  };
}

async function audit(ctx: CloudContext, row: ScheduleRow, action: string, before: Record<string, unknown> | null, after: Record<string, unknown> | null) {
  await recordCloudAudit({
    organizationId: row.organizationId,
    projectId: row.projectId,
    actorType: ctx.surface === "cli" ? "cli" : "user",
    actorId: ctx.workspace.user.id,
    action,
    targetType: "cloud_agent_schedule",
    targetId: row.id,
    requestId: ctx.requestId,
    before,
    after,
  });
}

async function serializeScheduleById(deps: ResolvedCloudDeps, scheduleId: string) {
  const [schedule] = await selectSchedules(deps, eq(schema.cloudAgentSchedules.id, scheduleId));
  if (!schedule) throw cloudError("not_found", "Schedule not found.");
  return schedule;
}

async function selectSchedules(deps: ResolvedCloudDeps, where: ReturnType<typeof eq>): Promise<CloudSchedule[]> {
  const actor = alias(schema.users, "cloud_schedule_actor");
  const rows = await db
    .select({ schedule: schema.cloudAgentSchedules, agentName: schema.cloudAgents.name, actorName: actor.displayName, actorEmail: actor.primaryEmail })
    .from(schema.cloudAgentSchedules)
    .innerJoin(schema.cloudAgents, eq(schema.cloudAgents.id, schema.cloudAgentSchedules.agentId))
    .innerJoin(actor, eq(actor.id, schema.cloudAgentSchedules.actorUserId))
    .where(where)
    .orderBy(schema.cloudAgentSchedules.createdAt);
  return rows.map(({ schedule, agentName, actorName, actorEmail }) => {
    let prompt: string | null = null;
    if (schedule.promptEncrypted) {
      try {
        prompt = deps.codec.decrypt(schedule.promptEncrypted, { organizationId: schedule.organizationId, purpose: "schedule_prompt", recordId: schedule.id });
      } catch {
        prompt = null;
      }
    }
    return {
      id: schedule.id,
      agentId: schedule.agentId,
      agentName,
      cron: schedule.cron,
      timezone: schedule.timezone,
      prompt,
      budgetUsd: schedule.budgetUsdCents === null ? null : schedule.budgetUsdCents / 100,
      enabled: schedule.enabled,
      actor: { id: schedule.actorUserId, name: personName(actorName, actorEmail) },
      nextRunAt: schedule.nextRunAt?.toISOString() ?? null,
      lastRunAt: schedule.lastRunAt?.toISOString() ?? null,
      lastRunId: schedule.lastRunId,
    };
  });
}
