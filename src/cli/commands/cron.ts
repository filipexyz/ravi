/**
 * Cron Commands - Manage scheduled jobs
 */

import "reflect-metadata";
import { Group, Command, Arg, Option } from "../decorators.js";
import { fail, getContext } from "../context.js";
import { nats } from "../../nats.js";
import { getScopeContext, isScopeEnforced, canAccessResource } from "../../permissions/scope.js";
import { getAgent } from "../../router/config.js";
import { deriveSourceFromSessionKey } from "../../router/session-key.js";
import { resolveSession } from "../../router/sessions.js";
import { getDefaultTimezone, getAccountForAgent, getDefaultAgentId } from "../../router/router-db.js";
import {
  dbCreateCronJob,
  dbGetCronJob,
  dbListCronJobs,
  dbUpdateCronJob,
  dbDeleteCronJob,
  parseScheduleInput,
  describeSchedule,
  formatDurationMs,
  parseDurationMs,
  isValidCronExpression,
  type CronJobInput,
  type CronJob,
  type CronSchedule,
} from "../../cron/index.js";
import { buildCronShowOutput, type CronRoutingResolution, type CronRoutingSource } from "../cron-show-output.js";

function resolveCronRouting(job: CronJob): CronRoutingResolution {
  if (!job.replySession) {
    return { kind: "none" };
  }

  const resolved = resolveSession(job.replySession);
  if (resolved?.name) {
    let source: CronRoutingSource | undefined;
    if (resolved.lastChannel && resolved.lastTo) {
      source = {
        channel: resolved.lastChannel,
        accountId: job.accountId ?? resolved.lastAccountId ?? "",
        chatId: resolved.lastTo,
      };
    }

    return {
      kind: "resolved-session",
      replySession: job.replySession,
      sessionName: resolved.name,
      source,
    };
  }

  const derived = deriveSourceFromSessionKey(job.replySession);
  const source = derived
    ? {
        channel: derived.channel,
        accountId: job.accountId ?? derived.accountId ?? "",
        chatId: derived.chatId,
        ...(derived.threadId ? { threadId: derived.threadId } : {}),
      }
    : undefined;

  return {
    kind: "derived-key",
    replySession: job.replySession,
    source,
  };
}

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

function serializeCronJob(job: CronJob) {
  return {
    ...job,
    effectiveAgentId: job.agentId ?? getDefaultAgentId(),
    scheduleDescription: describeSchedule(job.schedule),
    routing: resolveCronRouting(job),
  };
}

@Group({
  name: "cron",
  description: "Scheduled job management",
  scope: "resource",
})
export class CronCommands {
  @Command({ name: "list", description: "List all scheduled jobs" })
  list(@Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean) {
    let jobs = dbListCronJobs();

    // Scope isolation: filter to own agent's jobs
    const scopeCtx = getScopeContext();
    if (isScopeEnforced(scopeCtx)) {
      jobs = jobs.filter((j) => canAccessResource(scopeCtx, j.agentId));
    }

    if (asJson) {
      printJson({ total: jobs.length, jobs: jobs.map(serializeCronJob) });
      return;
    }

    if (jobs.length === 0) {
      console.log("\nNo cron jobs configured.\n");
      console.log("Usage:");
      console.log('  ravi cron add "Daily Report" --cron "0 9 * * *" --message "Generate report"');
      console.log('  ravi cron add "Check emails" --every 30m --message "Check for new emails"');
      return;
    }

    console.log("\nScheduled Jobs:\n");
    console.log("  ID        NAME                      ENABLED  SCHEDULE                 NEXT RUN");
    console.log("  --------  ------------------------  -------  -----------------------  --------------------");

    for (const job of jobs) {
      const id = job.id.padEnd(8);
      const name = job.name.slice(0, 24).padEnd(24);
      const enabled = (job.enabled ? "yes" : "no").padEnd(7);
      const schedule = describeSchedule(job.schedule).slice(0, 23).padEnd(23);
      const nextRun = job.nextRunAt
        ? new Date(job.nextRunAt).toLocaleString()
        : job.schedule.type === "at"
          ? "(expired)"
          : "-";

      console.log(`  ${id}  ${name}  ${enabled}  ${schedule}  ${nextRun}`);
    }

    console.log(`\n  Total: ${jobs.length} jobs`);
    console.log("\nUsage:");
    console.log("  ravi cron show <id>     # Show job details");
    console.log("  ravi cron run <id>      # Manually run job");
    console.log("  ravi cron rm <id>       # Delete job");
  }

  @Command({ name: "show", description: "Show job details" })
  show(
    @Arg("id", { description: "Job ID" }) id: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const job = dbGetCronJob(id);
    if (!job || !canAccessResource(getScopeContext(), job.agentId)) {
      fail(`Job not found: ${id}`);
    }

    if (asJson) {
      printJson({ job: serializeCronJob(job) });
      return;
    }

    const agentId = job.agentId ?? getDefaultAgentId();
    const routing = resolveCronRouting(job);

    for (const line of buildCronShowOutput(job, describeSchedule(job.schedule), agentId, routing)) {
      console.log(line);
    }
  }

  @Command({ name: "add", description: "Add a new scheduled job" })
  async add(
    @Arg("name", { description: "Job name" }) name: string,
    @Option({ flags: "--cron <expr>", description: "Cron expression (e.g., '0 9 * * *')" }) cronExpr?: string,
    @Option({ flags: "--every <interval>", description: "Interval (e.g., 30m, 1h)" }) every?: string,
    @Option({ flags: "--at <datetime>", description: "One-shot time (e.g., 2025-02-01T15:00)" }) at?: string,
    @Option({ flags: "--tz <timezone>", description: "Timezone (e.g., America/Sao_Paulo)" }) tz?: string,
    @Option({ flags: "--message <text>", description: "Prompt message" }) message?: string,
    @Option({ flags: "--isolated", description: "Run in isolated session" }) isolated?: boolean,
    @Option({ flags: "--delete-after", description: "Delete job after first run" }) deleteAfter?: boolean,
    @Option({ flags: "--agent <id>", description: "Agent ID (default: default agent)" }) agent?: string,
    @Option({ flags: "--account <name>", description: "Account for channel delivery (auto-detected from agent)" })
    account?: string,
    @Option({ flags: "--description <text>", description: "Job description" }) description?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const warnings: string[] = [];

    // Validate message is provided
    if (!message) {
      fail("--message is required");
    }

    // Validate exactly one schedule type is provided
    const scheduleCount = [cronExpr, every, at].filter(Boolean).length;
    if (scheduleCount === 0) {
      fail("One of --cron, --every, or --at is required");
    }
    if (scheduleCount > 1) {
      fail("Only one of --cron, --every, or --at can be specified");
    }

    // Warn if --tz is used without --cron
    if (tz && !cronExpr) {
      const warning = "Warning: --tz is only used with --cron, ignoring";
      if (asJson) {
        warnings.push(warning);
      } else {
        console.log(warning);
      }
    }

    // Use default timezone for cron if not specified
    const timezone = cronExpr ? (tz ?? getDefaultTimezone()) : undefined;

    // Validate agent if provided
    if (agent) {
      const ag = getAgent(agent);
      if (!ag) {
        fail(`Agent not found: ${agent}`);
      }
    }

    // Parse schedule
    let schedule: CronSchedule;
    try {
      if (cronExpr) {
        if (!isValidCronExpression(cronExpr)) {
          fail(`Invalid cron expression: ${cronExpr}`);
        }
        schedule = { type: "cron", cron: cronExpr, timezone };
      } else if (every) {
        schedule = { type: "every", every: parseDurationMs(every) };
      } else if (at) {
        schedule = parseScheduleInput(at);
      } else {
        fail("No schedule provided");
      }
    } catch (err) {
      fail(`Invalid schedule: ${err instanceof Error ? err.message : err}`);
    }

    // Resolve agent: explicit flag > caller agent (from session context) > system default
    const ctx = getContext();
    const resolvedAgent = agent ?? ctx?.agentId;

    // Resolve account: explicit flag > auto-detect from agent's account mapping
    const resolvedAccount = account ?? (resolvedAgent ? getAccountForAgent(resolvedAgent) : undefined);

    // Capture reply session from caller context (e.g., agent:comm:whatsapp:main:group:123)
    const replySession = ctx?.sessionKey;

    // Create job
    const input: CronJobInput = {
      name,
      schedule,
      message,
      agentId: resolvedAgent,
      accountId: resolvedAccount,
      replySession,
      description,
      sessionTarget: isolated ? "isolated" : "main",
      deleteAfterRun: deleteAfter,
    };

    try {
      const job = dbCreateCronJob(input);

      // Signal daemon to refresh timers
      await nats.emit("ravi.cron.refresh", {});

      if (asJson) {
        printJson({
          status: "created",
          target: { type: "cron", id: job.id },
          changedCount: 1,
          warnings,
          job: serializeCronJob(job),
        });
        return;
      }

      console.log(`\n✓ Created job: ${job.id}`);
      console.log(`  Name:       ${job.name}`);
      console.log(`  Schedule:   ${describeSchedule(job.schedule)}`);
      if (job.nextRunAt) {
        console.log(`  Next run:   ${new Date(job.nextRunAt).toLocaleString()}`);
      }
    } catch (err) {
      fail(`Error creating job: ${err instanceof Error ? err.message : err}`);
    }
  }

  @Command({ name: "enable", description: "Enable a job" })
  async enable(
    @Arg("id", { description: "Job ID" }) id: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const job = dbGetCronJob(id);
    if (!job || !canAccessResource(getScopeContext(), job.agentId)) {
      fail(`Job not found: ${id}`);
    }

    try {
      // Recalculate nextRunAt in case job was disabled for a while
      // Passing schedule triggers recalculation in dbUpdateCronJob
      dbUpdateCronJob(id, { enabled: true, schedule: { ...job.schedule } });

      await nats.emit("ravi.cron.refresh", {});

      const updatedJob = dbGetCronJob(id)!;
      if (asJson) {
        printJson({
          status: "enabled",
          target: { type: "cron", id },
          changedCount: 1,
          job: serializeCronJob(updatedJob),
        });
        return;
      }
      console.log(`✓ Enabled job: ${id} (${job.name})`);
      if (updatedJob.nextRunAt) {
        console.log(`  Next run: ${new Date(updatedJob.nextRunAt).toLocaleString()}`);
      }
    } catch (err) {
      fail(`Error: ${err instanceof Error ? err.message : err}`);
    }
  }

  @Command({ name: "disable", description: "Disable a job" })
  async disable(
    @Arg("id", { description: "Job ID" }) id: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const job = dbGetCronJob(id);
    if (!job || !canAccessResource(getScopeContext(), job.agentId)) {
      fail(`Job not found: ${id}`);
    }

    try {
      dbUpdateCronJob(id, { enabled: false });
      await nats.emit("ravi.cron.refresh", {});
      if (asJson) {
        const updatedJob = dbGetCronJob(id) ?? { ...job, enabled: false };
        printJson({
          status: "disabled",
          target: { type: "cron", id },
          changedCount: 1,
          job: serializeCronJob(updatedJob),
        });
        return;
      }
      console.log(`✓ Disabled job: ${id} (${job.name})`);
    } catch (err) {
      fail(`Error: ${err instanceof Error ? err.message : err}`);
    }
  }

  @Command({ name: "set", description: "Set job property" })
  async set(
    @Arg("id", { description: "Job ID" }) id: string,
    @Arg("key", {
      description:
        "Property: name, message, cron, every, tz, agent, account, description, session, reply-session, delete-after",
    })
    key: string,
    @Arg("value", { description: "Property value" }) value: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const job = dbGetCronJob(id);
    if (!job || !canAccessResource(getScopeContext(), job.agentId)) {
      fail(`Job not found: ${id}`);
    }

    try {
      let normalizedValue: unknown = value;
      const logHuman = (message: string) => {
        if (!asJson) console.log(message);
      };

      switch (key) {
        case "name":
          dbUpdateCronJob(id, { name: value });
          logHuman(`✓ Name set: ${id} -> ${value}`);
          break;

        case "message":
          dbUpdateCronJob(id, { message: value });
          logHuman(`✓ Message set: ${id}`);
          break;

        case "cron": {
          if (!isValidCronExpression(value)) {
            fail(`Invalid cron expression: ${value}`);
          }
          const schedule: CronSchedule = { type: "cron", cron: value, timezone: job.schedule.timezone };
          dbUpdateCronJob(id, { schedule });
          normalizedValue = schedule;
          logHuman(`✓ Cron set: ${id} -> ${value}`);
          break;
        }

        case "every": {
          const ms = parseDurationMs(value);
          const schedule: CronSchedule = { type: "every", every: ms };
          dbUpdateCronJob(id, { schedule });
          normalizedValue = schedule;
          logHuman(`✓ Interval set: ${id} -> ${formatDurationMs(ms)}`);
          break;
        }

        case "tz":
        case "timezone": {
          if (job.schedule.type !== "cron") {
            fail(`Timezone only applies to cron schedules, not ${job.schedule.type}`);
          }
          const timezone = value === "null" || value === "-" ? undefined : value;
          if (timezone) {
            // Validate timezone
            try {
              Intl.DateTimeFormat(undefined, { timeZone: timezone });
            } catch {
              fail(`Invalid timezone: ${timezone}`);
            }
          }
          const schedule: CronSchedule = { ...job.schedule, timezone };
          dbUpdateCronJob(id, { schedule });
          normalizedValue = timezone ?? null;
          logHuman(`✓ Timezone set: ${id} -> ${timezone ?? "(system default)"}`);
          break;
        }

        case "agent": {
          const agentId = value === "null" || value === "-" ? undefined : value;
          if (agentId) {
            const ag = getAgent(agentId);
            if (!ag) {
              fail(`Agent not found: ${agentId}`);
            }
          }
          dbUpdateCronJob(id, { agentId });
          normalizedValue = agentId ?? null;
          logHuman(`✓ Agent set: ${id} -> ${agentId ?? "(default)"}`);
          break;
        }

        case "account": {
          const accountId = value === "null" || value === "-" ? undefined : value;
          dbUpdateCronJob(id, { accountId });
          normalizedValue = accountId ?? null;
          logHuman(`✓ Account set: ${id} -> ${accountId ?? "(auto)"}`);
          break;
        }

        case "description":
          normalizedValue = value === "null" || value === "-" ? null : value;
          dbUpdateCronJob(id, { description: normalizedValue === null ? undefined : value });
          logHuman(`✓ Description set: ${id}`);
          break;

        case "session": {
          const validValues = ["main", "isolated"];
          if (!validValues.includes(value)) {
            fail(`Invalid session value: ${value}. Valid: ${validValues.join(", ")}`);
          }
          dbUpdateCronJob(id, { sessionTarget: value as "main" | "isolated" });
          logHuman(`✓ Session set: ${id} -> ${value}`);
          break;
        }

        case "reply-session": {
          const replySession = value === "null" || value === "-" ? undefined : value;
          dbUpdateCronJob(id, { replySession });
          normalizedValue = replySession ?? null;
          logHuman(`✓ Reply session set: ${id} -> ${replySession ?? "(auto)"}`);
          break;
        }

        case "delete-after": {
          const normalizedBooleanInput = value.toLowerCase();
          const boolValue = normalizedBooleanInput === "true" || normalizedBooleanInput === "yes" || value === "1";
          if (!["true", "false", "yes", "no", "1", "0"].includes(normalizedBooleanInput)) {
            fail(`Invalid boolean value: ${value}. Use: true, false, yes, no, 1, 0`);
          }
          dbUpdateCronJob(id, { deleteAfterRun: boolValue });
          normalizedValue = boolValue;
          logHuman(`✓ Delete-after set: ${id} -> ${boolValue ? "yes" : "no"}`);
          break;
        }

        default:
          fail(
            `Unknown property: ${key}. Valid: name, message, cron, every, tz, agent, account, description, session, reply-session, delete-after`,
          );
      }

      // Signal daemon to refresh timers
      await nats.emit("ravi.cron.refresh", {});

      if (asJson) {
        const updatedJob = dbGetCronJob(id);
        printJson({
          status: "updated",
          target: { type: "cron", id },
          changedCount: 1,
          property: key,
          value: normalizedValue,
          job: updatedJob ? serializeCronJob(updatedJob) : null,
        });
      }
    } catch (err) {
      fail(`Error: ${err instanceof Error ? err.message : err}`);
    }
  }

  @Command({ name: "run", description: "Manually run a job (ignores schedule)" })
  async run(
    @Arg("id", { description: "Job ID" }) id: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const job = dbGetCronJob(id);
    if (!job || !canAccessResource(getScopeContext(), job.agentId)) {
      fail(`Job not found: ${id}`);
    }

    if (!asJson) {
      console.log(`\nTriggering job: ${job.name}`);
    }

    try {
      // Send trigger signal to daemon
      await nats.emit("ravi.cron.trigger", { jobId: id });
      if (asJson) {
        printJson({
          status: "triggered",
          target: { type: "cron", id },
          changedCount: 0,
          job: serializeCronJob(job),
        });
        return;
      }
      console.log("✓ Job triggered");
      console.log("  Check daemon logs: ravi daemon logs -f");
    } catch (err) {
      fail(`Error: ${err instanceof Error ? err.message : err}`);
    }
  }

  @Command({ name: "rm", description: "Delete a job", aliases: ["delete", "remove"] })
  async rm(
    @Arg("id", { description: "Job ID" }) id: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const job = dbGetCronJob(id);
    if (!job || !canAccessResource(getScopeContext(), job.agentId)) {
      fail(`Job not found: ${id}`);
    }

    try {
      dbDeleteCronJob(id);
      await nats.emit("ravi.cron.refresh", {});
      if (asJson) {
        printJson({
          status: "deleted",
          target: { type: "cron", id },
          changedCount: 1,
          job: serializeCronJob(job),
        });
        return;
      }
      console.log(`✓ Deleted job: ${id} (${job.name})`);
    } catch (err) {
      fail(`Error: ${err instanceof Error ? err.message : err}`);
    }
  }
}
