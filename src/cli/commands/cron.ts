/**
 * Cron Commands - Manage scheduled jobs
 */

import "reflect-metadata";
import { Group, Command, Arg, Option } from "../decorators.js";
import { fail } from "../context.js";
import { notif } from "../../notif.js";
import { getAgent } from "../../router/config.js";
import { getDefaultTimezone } from "../../router/router-db.js";
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
  type CronSchedule,
} from "../../cron/index.js";

@Group({
  name: "cron",
  description: "Scheduled job management",
})
export class CronCommands {
  @Command({ name: "list", description: "List all scheduled jobs" })
  list() {
    const jobs = dbListCronJobs();

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
        : job.schedule.type === "at" ? "(expired)" : "-";

      console.log(`  ${id}  ${name}  ${enabled}  ${schedule}  ${nextRun}`);
    }

    console.log(`\n  Total: ${jobs.length} jobs`);
    console.log("\nUsage:");
    console.log("  ravi cron show <id>     # Show job details");
    console.log("  ravi cron run <id>      # Manually run job");
    console.log("  ravi cron rm <id>       # Delete job");
  }

  @Command({ name: "show", description: "Show job details" })
  show(@Arg("id", { description: "Job ID" }) id: string) {
    const job = dbGetCronJob(id);
    if (!job) {
      fail(`Job not found: ${id}`);
    }

    console.log(`\nCron Job: ${job.name}\n`);
    console.log(`  ID:              ${job.id}`);
    console.log(`  Agent:           ${job.agentId ?? "(default)"}`);
    console.log(`  Enabled:         ${job.enabled ? "yes" : "no"}`);
    console.log(`  Schedule:        ${describeSchedule(job.schedule)}`);
    console.log(`  Session:         ${job.sessionTarget}`);

    if (job.description) {
      console.log(`  Description:     ${job.description}`);
    }

    console.log(`  Delete after:    ${job.deleteAfterRun ? "yes" : "no"}`);
    console.log("");
    console.log(`  Message:`);
    console.log(`    ${job.message.split("\n").join("\n    ")}`);
    console.log("");

    if (job.nextRunAt) {
      console.log(`  Next run:        ${new Date(job.nextRunAt).toLocaleString()}`);
    }
    if (job.lastRunAt) {
      console.log(`  Last run:        ${new Date(job.lastRunAt).toLocaleString()}`);
      console.log(`  Last status:     ${job.lastStatus ?? "-"}`);
      if (job.lastDurationMs) {
        console.log(`  Last duration:   ${job.lastDurationMs}ms`);
      }
      if (job.lastError) {
        console.log(`  Last error:      ${job.lastError}`);
      }
    }

    console.log(`  Created:         ${new Date(job.createdAt).toLocaleString()}`);
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
    @Option({ flags: "--description <text>", description: "Job description" }) description?: string
  ) {
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
      console.log("Warning: --tz is only used with --cron, ignoring");
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

    // Create job
    const input: CronJobInput = {
      name,
      schedule,
      message,
      agentId: agent,
      description,
      sessionTarget: isolated ? "isolated" : "main",
      deleteAfterRun: deleteAfter,
    };

    try {
      const job = dbCreateCronJob(input);

      // Signal daemon to refresh timers
      await notif.emit("ravi.cron.refresh", {});

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
  async enable(@Arg("id", { description: "Job ID" }) id: string) {
    const job = dbGetCronJob(id);
    if (!job) {
      fail(`Job not found: ${id}`);
    }

    try {
      // Recalculate nextRunAt in case job was disabled for a while
      // Passing schedule triggers recalculation in dbUpdateCronJob
      dbUpdateCronJob(id, { enabled: true, schedule: { ...job.schedule } });

      await notif.emit("ravi.cron.refresh", {});

      const updatedJob = dbGetCronJob(id)!;
      console.log(`✓ Enabled job: ${id} (${job.name})`);
      if (updatedJob.nextRunAt) {
        console.log(`  Next run: ${new Date(updatedJob.nextRunAt).toLocaleString()}`);
      }
    } catch (err) {
      fail(`Error: ${err instanceof Error ? err.message : err}`);
    }
  }

  @Command({ name: "disable", description: "Disable a job" })
  async disable(@Arg("id", { description: "Job ID" }) id: string) {
    const job = dbGetCronJob(id);
    if (!job) {
      fail(`Job not found: ${id}`);
    }

    try {
      dbUpdateCronJob(id, { enabled: false });
      await notif.emit("ravi.cron.refresh", {});
      console.log(`✓ Disabled job: ${id} (${job.name})`);
    } catch (err) {
      fail(`Error: ${err instanceof Error ? err.message : err}`);
    }
  }

  @Command({ name: "set", description: "Set job property" })
  async set(
    @Arg("id", { description: "Job ID" }) id: string,
    @Arg("key", { description: "Property: name, message, cron, every, tz, agent, description, session, delete-after" }) key: string,
    @Arg("value", { description: "Property value" }) value: string
  ) {
    const job = dbGetCronJob(id);
    if (!job) {
      fail(`Job not found: ${id}`);
    }

    try {
      switch (key) {
        case "name":
          dbUpdateCronJob(id, { name: value });
          console.log(`✓ Name set: ${id} -> ${value}`);
          break;

        case "message":
          dbUpdateCronJob(id, { message: value });
          console.log(`✓ Message set: ${id}`);
          break;

        case "cron": {
          if (!isValidCronExpression(value)) {
            fail(`Invalid cron expression: ${value}`);
          }
          const schedule: CronSchedule = { type: "cron", cron: value, timezone: job.schedule.timezone };
          dbUpdateCronJob(id, { schedule });
          console.log(`✓ Cron set: ${id} -> ${value}`);
          break;
        }

        case "every": {
          const ms = parseDurationMs(value);
          const schedule: CronSchedule = { type: "every", every: ms };
          dbUpdateCronJob(id, { schedule });
          console.log(`✓ Interval set: ${id} -> ${formatDurationMs(ms)}`);
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
          console.log(`✓ Timezone set: ${id} -> ${timezone ?? "(system default)"}`);
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
          console.log(`✓ Agent set: ${id} -> ${agentId ?? "(default)"}`);
          break;
        }

        case "description":
          dbUpdateCronJob(id, { description: value === "null" || value === "-" ? undefined : value });
          console.log(`✓ Description set: ${id}`);
          break;

        case "session": {
          const validValues = ["main", "isolated"];
          if (!validValues.includes(value)) {
            fail(`Invalid session value: ${value}. Valid: ${validValues.join(", ")}`);
          }
          dbUpdateCronJob(id, { sessionTarget: value as "main" | "isolated" });
          console.log(`✓ Session set: ${id} -> ${value}`);
          break;
        }

        case "delete-after": {
          const boolValue = value === "true" || value === "yes" || value === "1";
          if (!["true", "false", "yes", "no", "1", "0"].includes(value.toLowerCase())) {
            fail(`Invalid boolean value: ${value}. Use: true, false, yes, no, 1, 0`);
          }
          dbUpdateCronJob(id, { deleteAfterRun: boolValue });
          console.log(`✓ Delete-after set: ${id} -> ${boolValue ? "yes" : "no"}`);
          break;
        }

        default:
          fail(`Unknown property: ${key}. Valid: name, message, cron, every, tz, agent, description, session, delete-after`);
      }

      // Signal daemon to refresh timers
      await notif.emit("ravi.cron.refresh", {});
    } catch (err) {
      fail(`Error: ${err instanceof Error ? err.message : err}`);
    }
  }

  @Command({ name: "run", description: "Manually run a job (ignores schedule)" })
  async run(@Arg("id", { description: "Job ID" }) id: string) {
    const job = dbGetCronJob(id);
    if (!job) {
      fail(`Job not found: ${id}`);
    }

    console.log(`\nTriggering job: ${job.name}`);

    try {
      // Send trigger signal to daemon
      await notif.emit("ravi.cron.trigger", { jobId: id });
      console.log("✓ Job triggered");
      console.log("  Check daemon logs: ravi daemon logs -f");
    } catch (err) {
      fail(`Error: ${err instanceof Error ? err.message : err}`);
    }
  }

  @Command({ name: "rm", description: "Delete a job", aliases: ["delete", "remove"] })
  async rm(@Arg("id", { description: "Job ID" }) id: string) {
    const job = dbGetCronJob(id);
    if (!job) {
      fail(`Job not found: ${id}`);
    }

    try {
      dbDeleteCronJob(id);
      await notif.emit("ravi.cron.refresh", {});
      console.log(`✓ Deleted job: ${id} (${job.name})`);
    } catch (err) {
      fail(`Error: ${err instanceof Error ? err.message : err}`);
    }
  }
}
