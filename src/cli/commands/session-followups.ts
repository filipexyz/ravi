import "reflect-metadata";
import { z } from "zod";
import { Arg, Command, Group, Option, Scope } from "../decorators.js";
import { fail, getContext } from "../context.js";
import { buildCliOffsetPagination } from "../pagination.js";
import { jsonObjectSchema } from "../return-schemas.js";
import {
  commandEnvelopeReturnSchema,
  declareCommandReturns,
  pagedItemsReturnSchema,
} from "./operational-return-schemas.js";
import {
  calculateNextRun,
  describeSchedule,
  formatDurationMs,
  parseDateTime,
  parseDurationMs,
} from "../../cron/schedule.js";
import { requireDeliveryBarrier } from "../../delivery-barriers.js";
import {
  createSessionFollowupCadence,
  getSessionFollowupCadence,
  listSessionFollowupCadences,
  listSessionFollowupRuns,
  retrySessionFollowupRuns,
  runSessionFollowupNow,
  updateSessionFollowupCadence,
  updateSessionFollowupCadenceState,
  type SessionFollowupCadence,
  type SessionFollowupStep,
  type SessionFollowupTargetType,
} from "../../session-followups/index.js";

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

function parseScopedRef(
  value: string | undefined,
  fallback: { type: string; id: string },
): { type: string; id: string } {
  const raw = value?.trim();
  if (!raw) return fallback;
  const separator = raw.indexOf(":");
  if (separator <= 0 || separator === raw.length - 1) {
    fail("Scoped refs must use <type:id>, e.g. agent:main or system:ravi");
  }
  return { type: raw.slice(0, separator), id: raw.slice(separator + 1) };
}

function defaultOwner(): { type: string; id: string } {
  const ctx = getContext();
  return ctx?.agentId ? { type: "agent", id: ctx.agentId } : { type: "system", id: "ravi" };
}

function resolveTarget(input: { targetSession?: string; targetChat?: string; targetList?: string }): {
  targetType: SessionFollowupTargetType;
  targetRef: string;
} {
  const values = [
    input.targetSession?.trim() ? { targetType: "session" as const, targetRef: input.targetSession.trim() } : null,
    input.targetChat?.trim() ? { targetType: "chat" as const, targetRef: input.targetChat.trim() } : null,
    input.targetList?.trim() ? { targetType: "reading_list" as const, targetRef: input.targetList.trim() } : null,
  ].filter(Boolean) as Array<{ targetType: SessionFollowupTargetType; targetRef: string }>;
  if (values.length !== 1) {
    fail("Choose exactly one target: --target-session, --target-chat, or --target-list.");
  }
  return values[0];
}

function normalizeOptionValues(value?: string | string[]): string[] {
  if (!value) return [];
  return (Array.isArray(value) ? value : [value]).map((item) => item.trim()).filter(Boolean);
}

function parseStepSpecs(value?: string | string[]): SessionFollowupStep[] {
  return normalizeOptionValues(value).map((raw) => {
    const separator = raw.indexOf("=");
    if (separator <= 0 || separator === raw.length - 1) {
      fail('--step must use <duration=message>, e.g. --step "2h=Follow up if nobody answered."');
    }
    return {
      afterMs: parseDurationMs(raw.slice(0, separator).trim()),
      messageTemplate: raw.slice(separator + 1).trim(),
    };
  });
}

function resolveSchedule(input: {
  every?: string;
  at?: string;
  cron?: string;
  timezone?: string;
  steps?: string | string[];
  message?: string;
}) {
  const steps = parseStepSpecs(input.steps);
  if (steps.length > 0) {
    const conflicting = [input.every?.trim(), input.at?.trim(), input.cron?.trim()].filter(Boolean);
    if (conflicting.length > 0) fail("Use --step by itself, or use exactly one of --every, --at, or --cron.");
    return { type: "every" as const, every: steps[0]?.afterMs, steps };
  }

  const values = [input.every?.trim(), input.at?.trim(), input.cron?.trim()].filter(Boolean);
  if (values.length !== 1) {
    fail("Choose exactly one schedule: --every, --at, --cron, or one or more --step values.");
  }
  if (input.every?.trim()) return { type: "every" as const, every: parseDurationMs(input.every.trim()) };
  if (input.at?.trim()) return { type: "at" as const, at: parseDateTime(input.at.trim()) };
  return { type: "cron" as const, cron: input.cron!.trim(), timezone: input.timezone?.trim() || undefined };
}

function serializeCadence(cadence: SessionFollowupCadence): Record<string, unknown> {
  return {
    ...cadence,
    scheduleDescription: formatFollowupSchedule(cadence),
    steps: cadence.schedule.steps,
    nextRunAtIso: cadence.nextRunAt ? new Date(cadence.nextRunAt).toISOString() : null,
    lastRunAtIso: cadence.lastRunAt ? new Date(cadence.lastRunAt).toISOString() : null,
  };
}

function formatFollowupSchedule(cadence: SessionFollowupCadence): string {
  if (cadence.schedule.type !== "every") return describeSchedule(cadence.schedule);
  const steps = cadence.schedule.steps ?? [];
  if (steps.length === 0 && cadence.schedule.every)
    return `after ${formatDurationMs(cadence.schedule.every)} of inactivity`;
  return steps.map((step, index) => `${index + 1}. after ${formatDurationMs(step.afterMs)}`).join(", ");
}

function requireCadence(id: string): SessionFollowupCadence {
  const cadence = getSessionFollowupCadence(id);
  if (!cadence) fail(`Session followup cadence not found: ${id}`);
  return cadence;
}

function resolveSingleStepMessageSchedule(
  cadence: SessionFollowupCadence,
  messageTemplate: string | undefined,
): SessionFollowupCadence["schedule"] | undefined {
  if (!messageTemplate || cadence.schedule.type !== "every") return undefined;
  const steps = cadence.schedule.steps ?? [];
  if (steps.length > 1) return undefined;
  const afterMs = steps[0]?.afterMs ?? cadence.schedule.every;
  if (!afterMs) return undefined;
  return {
    type: "every",
    every: afterMs,
    steps: [{ ...(steps[0] ?? { afterMs }), afterMs, messageTemplate }],
  };
}

const sessionFollowupStepReturnSchema = z.object({
  afterMs: z.number(),
  messageTemplate: z.string(),
  label: z.string().optional(),
});

const sessionFollowupScheduleReturnSchema = z.object({
  type: z.enum(["every", "at", "cron"]),
  every: z.number().optional(),
  at: z.number().optional(),
  cron: z.string().optional(),
  timezone: z.string().optional(),
  steps: z.array(sessionFollowupStepReturnSchema).optional(),
});

const sessionFollowupCadenceReturnSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  enabled: z.boolean(),
  ownerType: z.string(),
  ownerId: z.string(),
  targetType: z.enum(["session", "chat", "reading_list"]),
  targetRef: z.string(),
  schedule: sessionFollowupScheduleReturnSchema,
  deliveryBarrier: z.enum(["immediate_interrupt", "after_tool", "after_response", "after_task"]),
  messageTemplate: z.string(),
  metadata: jsonObjectSchema.optional(),
  nextRunAt: z.number().optional(),
  lastRunAt: z.number().optional(),
  lastStatus: z.enum(["ok", "skipped", "failed"]).optional(),
  lastError: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  scheduleDescription: z.string(),
  steps: z.array(sessionFollowupStepReturnSchema).optional(),
  nextRunAtIso: z.string().nullable(),
  lastRunAtIso: z.string().nullable(),
});

const sessionFollowupCadenceEnvelopeReturnSchema = z.object({
  followup: sessionFollowupCadenceReturnSchema,
});

@Group({
  name: "sessions.followups",
  description: "Manage session followup cadences",
})
export class SessionFollowupCommands {
  @Scope("admin")
  @Command({ name: "list", description: "List session followup cadences" })
  list(
    @Option({ flags: "--include-disabled", description: "Include paused/disabled cadences" }) includeDisabled?: boolean,
    @Option({ flags: "--target-type <type>", description: "Filter by target type: session|chat|reading_list" })
    targetType?: string,
    @Option({ flags: "--limit <n>", description: "Page size (default: 50, max: 500)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Number of matching rows to skip" }) offset?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const page = listSessionFollowupCadences({
      includeDisabled,
      targetType: targetType as SessionFollowupTargetType | undefined,
      limit,
      offset,
    });
    const pagination = buildCliOffsetPagination({
      baseCommand: ["ravi", "sessions", "followups", "list"],
      limit: page.limit,
      offset: page.offset,
      returned: page.items.length,
      total: page.total,
      options: [includeDisabled ? "--include-disabled" : undefined, "--target-type", targetType],
    });
    const items = page.items.map(serializeCadence);
    const payload = { total: page.total, pagination, followups: items, items };
    if (asJson) {
      printJson(payload);
      return payload;
    }
    if (items.length === 0) {
      console.log("No session followups found.");
      return payload;
    }
    console.log(`\nSession followups (${items.length} returned of ${page.total}):\n`);
    for (const cadence of page.items) {
      const status = cadence.enabled ? "enabled" : "paused";
      console.log(`- ${cadence.name} (${cadence.id}) ${status}`);
      console.log(`  target: ${cadence.targetType}:${cadence.targetRef}`);
      console.log(`  schedule: ${formatFollowupSchedule(cadence)}`);
      console.log(`  next: ${cadence.nextRunAt ? new Date(cadence.nextRunAt).toLocaleString() : "-"}`);
    }
    if (pagination.nextCommand) console.log(`\nNext page:\n  ${pagination.nextCommand}`);
    return payload;
  }

  @Scope("admin")
  @Command({ name: "add", description: "Create a session followup cadence" })
  add(
    @Arg("name", { description: "Followup cadence name" }) name: string,
    @Option({ flags: "--target-session <session>", description: "Target one session by name or key" })
    targetSession?: string,
    @Option({ flags: "--target-chat <chat>", description: "Target one canonical chat id/ref" }) targetChat?: string,
    @Option({ flags: "--target-list <list>", description: "Target every active chat in a reading list" })
    targetList?: string,
    @Option({ flags: "--every <duration>", description: "Idle followup after inactivity, e.g. 30m, 2h, 1d" })
    every?: string,
    @Option({ flags: "--at <iso>", description: "One-shot schedule timestamp" }) at?: string,
    @Option({ flags: "--cron <expr>", description: "Cron expression" }) cron?: string,
    @Option({ flags: "--timezone <tz>", description: "Timezone for cron schedules" }) timezone?: string,
    @Option({
      flags: "--step <duration=message...>",
      description: "Idle followup step; repeat or quote, e.g. --step '2h=First followup' --step '3h=Second followup'",
    })
    steps?: string | string[],
    @Option({ flags: "--message <text>", description: "Followup message template" }) message?: string,
    @Option({ flags: "--barrier <barrier>", description: "Delivery barrier: followup|steer|p0|p1|p2|p3" })
    barrier?: string,
    @Option({ flags: "--owner <type:id>", description: "Owner scope (default: current agent or system:ravi)" })
    owner?: string,
    @Option({ flags: "--description <text>", description: "Description for humans" }) description?: string,
    @Option({ flags: "--disabled", description: "Create disabled/paused" }) disabled?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const target = resolveTarget({ targetSession, targetChat, targetList });
    const schedule = resolveSchedule({ every, at, cron, timezone, steps, message });
    const ownerScope = parseScopedRef(owner, defaultOwner());
    const messageTemplate = message?.trim() || schedule.steps?.[0]?.messageTemplate;
    if (!messageTemplate) fail("--message is required unless --step supplies messages.");
    const cadence = createSessionFollowupCadence({
      name,
      description,
      enabled: !disabled,
      ownerType: ownerScope.type,
      ownerId: ownerScope.id,
      targetType: target.targetType,
      targetRef: target.targetRef,
      schedule,
      deliveryBarrier: requireDeliveryBarrier(barrier ?? "followup", "deliveryBarrier"),
      messageTemplate,
    });
    const payload = { followup: serializeCadence(cadence) };
    if (asJson) {
      printJson(payload);
      return payload;
    }
    console.log(`Created session followup: ${cadence.name} (${cadence.id})`);
    console.log(`Target: ${cadence.targetType}:${cadence.targetRef}`);
    console.log(`Schedule: ${formatFollowupSchedule(cadence)}`);
    console.log(`Next: ${cadence.nextRunAt ? new Date(cadence.nextRunAt).toLocaleString() : "-"}`);
    return payload;
  }

  @Scope("admin")
  @Command({ name: "update", description: "Update a session followup cadence without recreating it" })
  update(
    @Arg("id", { description: "Followup cadence id" }) id: string,
    @Option({ flags: "--name <name>", description: "Update cadence name" }) name?: string,
    @Option({ flags: "--description <text>", description: "Update description; pass empty string to clear" })
    description?: string,
    @Option({ flags: "--message <text>", description: "Update default followup message template" }) message?: string,
    @Option({ flags: "--barrier <barrier>", description: "Delivery barrier: followup|steer|p0|p1|p2|p3" })
    barrier?: string,
    @Option({
      flags: "--step <duration=message...>",
      description: "Replace idle followup steps; repeat or quote, e.g. --step '2h=First' --step '3h=Second'",
    })
    steps?: string | string[],
    @Option({ flags: "--recalculate-next", description: "Recalculate next run from the updated schedule" })
    recalculateNext?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const current = requireCadence(id);
    const parsedSteps = parseStepSpecs(steps);
    const messageTemplate = message?.trim() || parsedSteps[0]?.messageTemplate;
    if (
      parsedSteps.length === 0 &&
      messageTemplate &&
      current.schedule.type === "every" &&
      (current.schedule.steps?.length ?? 0) > 1
    ) {
      fail("Use --step to replace progressive followup messages. --message only updates single-step cadences.");
    }
    const schedule =
      parsedSteps.length > 0
        ? { type: "every" as const, every: parsedSteps[0]?.afterMs, steps: parsedSteps }
        : resolveSingleStepMessageSchedule(current, messageTemplate);

    if (
      name === undefined &&
      description === undefined &&
      messageTemplate === undefined &&
      barrier === undefined &&
      schedule === undefined &&
      recalculateNext !== true
    ) {
      fail("Nothing to update. Use --name, --description, --message, --barrier, --step, or --recalculate-next.");
    }

    const cadence = updateSessionFollowupCadence(id, {
      name,
      description,
      messageTemplate,
      deliveryBarrier: barrier,
      schedule,
      recalculateNextRun: recalculateNext === true,
    });
    if (!cadence) fail(`Session followup cadence not found: ${id}`);
    const payload = { followup: serializeCadence(cadence) };
    if (asJson) {
      printJson(payload);
      return payload;
    }
    console.log(`Updated session followup: ${cadence.name} (${cadence.id})`);
    console.log(`Schedule: ${formatFollowupSchedule(cadence)}`);
    console.log(`Next: ${cadence.nextRunAt ? new Date(cadence.nextRunAt).toLocaleString() : "-"}`);
    return payload;
  }

  @Scope("admin")
  @Command({ name: "inspect", description: "Inspect one session followup cadence and recent runs" })
  inspect(
    @Arg("id", { description: "Followup cadence id" }) id: string,
    @Option({ flags: "--runs <n>", description: "Number of recent runs (default: 20)" }) runs?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const cadence = requireCadence(id);
    const page = listSessionFollowupRuns({ cadenceId: id, limit: runs ?? "20", offset: 0 });
    const payload = { followup: serializeCadence(cadence), runs: page.items, totalRuns: page.total };
    if (asJson) {
      printJson(payload);
      return payload;
    }
    console.log(`Session followup: ${cadence.name} (${cadence.id})`);
    console.log(`Target: ${cadence.targetType}:${cadence.targetRef}`);
    console.log(`Schedule: ${formatFollowupSchedule(cadence)}`);
    console.log(`Next: ${cadence.nextRunAt ? new Date(cadence.nextRunAt).toLocaleString() : "-"}`);
    console.log(`Runs: ${page.items.length} shown of ${page.total}`);
    for (const run of page.items) {
      console.log(`- ${run.id} ${run.status} target=${run.targetType}:${run.targetRef}`);
      if (run.lastError) console.log(`  error: ${run.lastError}`);
    }
    return payload;
  }

  @Scope("admin")
  @Command({ name: "runs", description: "List session followup runs" })
  runs(
    @Option({ flags: "--cadence <id>", description: "Filter by cadence id" }) cadenceId?: string,
    @Option({ flags: "--status <status>", description: "Filter by run status" }) status?: string,
    @Option({ flags: "--limit <n>", description: "Page size (default: 50, max: 500)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Number of matching rows to skip" }) offset?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const page = listSessionFollowupRuns({ cadenceId, status: status as never, limit, offset });
    const pagination = buildCliOffsetPagination({
      baseCommand: ["ravi", "sessions", "followups", "runs"],
      limit: page.limit,
      offset: page.offset,
      returned: page.items.length,
      total: page.total,
      options: ["--cadence", cadenceId, "--status", status],
    });
    const payload = { total: page.total, pagination, runs: page.items, items: page.items };
    if (asJson) {
      printJson(payload);
      return payload;
    }
    if (page.items.length === 0) {
      console.log("No session followup runs found.");
      return payload;
    }
    console.log(`\nSession followup runs (${page.items.length} returned of ${page.total}):\n`);
    for (const run of page.items) {
      console.log(`- ${run.id} ${run.status} cadence=${run.cadenceId} target=${run.targetType}:${run.targetRef}`);
      if (run.lastError) console.log(`  error: ${run.lastError}`);
    }
    if (pagination.nextCommand) console.log(`\nNext page:\n  ${pagination.nextCommand}`);
    return payload;
  }

  @Scope("admin")
  @Command({ name: "run", description: "Run a followup cadence now without consuming its next scheduled time" })
  async run(
    @Arg("id", { description: "Followup cadence id" }) id: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const result = await runSessionFollowupNow(id);
    const payload = { result };
    if (asJson) {
      printJson(payload);
      return payload;
    }
    console.log(`Followup run complete: sent=${result.sent} skipped=${result.skipped} failed=${result.failed}`);
    return payload;
  }

  @Scope("admin")
  @Command({ name: "pause", description: "Pause a followup cadence" })
  pause(
    @Arg("id", { description: "Followup cadence id" }) id: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const cadence = updateSessionFollowupCadenceState(id, { enabled: false, nextRunAt: null });
    if (!cadence) fail(`Session followup cadence not found: ${id}`);
    const payload = { followup: serializeCadence(cadence) };
    if (asJson) {
      printJson(payload);
      return payload;
    }
    console.log(`Paused session followup: ${cadence.name} (${cadence.id})`);
    return payload;
  }

  @Scope("admin")
  @Command({ name: "resume", description: "Resume a followup cadence and recalculate next run" })
  resume(
    @Arg("id", { description: "Followup cadence id" }) id: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const current = requireCadence(id);
    const now = Date.now();
    const nextRunAt = current.schedule.type === "every" ? now : calculateNextRun(current.schedule, now);
    const cadence = updateSessionFollowupCadenceState(id, { enabled: true, nextRunAt: nextRunAt ?? null });
    if (!cadence) fail(`Session followup cadence not found: ${id}`);
    const payload = { followup: serializeCadence(cadence) };
    if (asJson) {
      printJson(payload);
      return payload;
    }
    console.log(`Resumed session followup: ${cadence.name} (${cadence.id})`);
    console.log(`Next: ${cadence.nextRunAt ? new Date(cadence.nextRunAt).toLocaleString() : "-"}`);
    return payload;
  }

  @Scope("admin")
  @Command({ name: "snooze", description: "Snooze a followup cadence until a timestamp" })
  snooze(
    @Arg("id", { description: "Followup cadence id" }) id: string,
    @Option({ flags: "--until <iso>", description: "Wake-up timestamp" }) until?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    if (!until?.trim()) fail("--until is required.");
    requireCadence(id);
    const cadence = updateSessionFollowupCadenceState(id, { enabled: true, nextRunAt: parseDateTime(until.trim()) });
    if (!cadence) fail(`Session followup cadence not found: ${id}`);
    const payload = { followup: serializeCadence(cadence) };
    if (asJson) {
      printJson(payload);
      return payload;
    }
    console.log(`Snoozed session followup: ${cadence.name} (${cadence.id})`);
    console.log(`Next: ${cadence.nextRunAt ? new Date(cadence.nextRunAt).toLocaleString() : "-"}`);
    return payload;
  }

  @Scope("admin")
  @Command({ name: "retry", description: "Retry failed/dead followup runs" })
  retry(
    @Arg("run", { required: false, description: "Optional run id" }) runId?: string,
    @Option({ flags: "--cadence <id>", description: "Retry failed/dead runs for one cadence" }) cadenceId?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    if (runId && cadenceId) fail("Use either a run id or --cadence, not both.");
    const retried = retrySessionFollowupRuns({ id: runId, cadenceId });
    const payload = { retried };
    if (asJson) {
      printJson(payload);
      return payload;
    }
    console.log(`Retried ${retried} followup run(s).`);
    return payload;
  }
}

declareCommandReturns(SessionFollowupCommands, {
  add: commandEnvelopeReturnSchema,
  inspect: commandEnvelopeReturnSchema,
  list: pagedItemsReturnSchema,
  pause: commandEnvelopeReturnSchema,
  resume: commandEnvelopeReturnSchema,
  retry: commandEnvelopeReturnSchema,
  run: commandEnvelopeReturnSchema,
  runs: pagedItemsReturnSchema,
  snooze: commandEnvelopeReturnSchema,
  update: sessionFollowupCadenceEnvelopeReturnSchema,
});
