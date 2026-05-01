import "reflect-metadata";
import { Arg, Command, Group, Option } from "../decorators.js";
import { fail } from "../context.js";
import { formatDurationMs, parseDurationMs } from "../../cron/schedule.js";
import {
  TASK_AUTOMATION_EVENTS,
  TASK_REPORT_EVENTS,
  createTaskAutomation,
  deleteTaskAutomation,
  getTaskAutomation,
  listTaskAutomationRuns,
  listTaskAutomations,
  updateTaskAutomation,
} from "../../tasks/index.js";
import type { TaskAutomationEventType, TaskPriority, TaskReportEvent } from "../../tasks/types.js";

const VALID_PRIORITIES = new Set<TaskPriority>(["low", "normal", "high", "urgent"]);

function requirePriority(value?: string): TaskPriority | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (!VALID_PRIORITIES.has(normalized as TaskPriority)) {
    fail(`Invalid priority: ${value}. Use low|normal|high|urgent.`);
  }
  return normalized as TaskPriority;
}

function parseAutomationEvents(value?: string): TaskAutomationEventType[] {
  if (!value?.trim()) {
    fail(`--on is required. Use ${TASK_AUTOMATION_EVENTS.join(",")}.`);
  }

  const parsed = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (parsed.length === 0) {
    fail(`--on is required. Use ${TASK_AUTOMATION_EVENTS.join(",")}.`);
  }

  const invalid = parsed.filter((entry) => !TASK_AUTOMATION_EVENTS.includes(entry as TaskAutomationEventType));
  if (invalid.length > 0) {
    fail(`Invalid event(s): ${invalid.join(", ")}. Use ${TASK_AUTOMATION_EVENTS.join(",")}.`);
  }

  return [...new Set(parsed as TaskAutomationEventType[])];
}

function parseReportEvents(value?: string): TaskReportEvent[] | undefined {
  if (!value?.trim()) return undefined;
  const parsed = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (parsed.length === 0) {
    fail(`Invalid --report-events value. Use ${TASK_REPORT_EVENTS.join(",")}.`);
  }

  const invalid = parsed.filter((entry) => !TASK_REPORT_EVENTS.includes(entry as TaskReportEvent));
  if (invalid.length > 0) {
    fail(`Invalid report event(s): ${invalid.join(", ")}. Use ${TASK_REPORT_EVENTS.join(",")}.`);
  }

  return [...new Set(parsed as TaskReportEvent[])];
}

function parseProfileInputs(raw?: string[] | string): Record<string, string> | undefined {
  const values = Array.isArray(raw) ? raw : raw ? [raw] : [];
  if (values.length === 0) {
    return undefined;
  }

  const resolved: Record<string, string> = {};
  for (const value of values) {
    const index = value.indexOf("=");
    if (index <= 0) {
      fail(`Invalid --input value: ${value}. Use key=value.`);
    }
    const key = value.slice(0, index).trim();
    const entryValue = value.slice(index + 1);
    if (!key) {
      fail(`Invalid --input value: ${value}. Use key=value.`);
    }
    resolved[key] = entryValue;
  }

  return resolved;
}

function parseCheckpointInterval(value?: string): number | undefined {
  if (!value?.trim()) return undefined;
  try {
    return parseDurationMs(value.trim());
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

function formatTime(ts?: number): string {
  if (!ts) return "-";
  return new Date(ts).toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function requireAutomation(id: string) {
  const automation = getTaskAutomation(id);
  if (!automation) {
    fail(`Task automation not found: ${id}`);
  }
  return automation;
}

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

@Group({
  name: "tasks.automations",
  description: "Event-driven follow-up task automations",
  scope: "open",
})
export class TaskAutomationCommands {
  @Command({ name: "list", description: "List configured task automations" })
  list(@Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean) {
    const automations = listTaskAutomations();
    const payload = { total: automations.length, automations };

    if (asJson) {
      console.log(JSON.stringify(payload, null, 2));
    } else if (automations.length === 0) {
      console.log("\nNo task automations configured.\n");
      console.log("Usage:");
      console.log(
        '  ravi tasks automations add "QC after done" --on task.done --title "Run QC for {{data.task.title}}" --instructions "Review deliverable for {{data.task.id}}" --agent qa',
      );
    } else {
      console.log("\nTask Automations:\n");
      console.log("  ID        ENABLED  EVENTS                              TARGET               FIRES  NAME");
      console.log(
        "  --------  -------  ----------------------------------  -------------------  -----  ------------------------------",
      );
      for (const automation of automations) {
        const events = automation.eventTypes.join(",").slice(0, 34).padEnd(34);
        const target = `${automation.profileId ?? "(inherit)"}/${automation.agentId ?? "open"}`.padEnd(19);
        console.log(
          `  ${automation.id.padEnd(8)}  ${(automation.enabled ? "yes" : "no").padEnd(7)}  ${events}  ${target}  ${String(automation.fireCount).padEnd(5)}  ${automation.name.slice(0, 30)}`,
        );
      }
      console.log("");
    }
    return payload;
  }

  @Command({ name: "show", description: "Show one task automation and its recent runs" })
  show(
    @Arg("id", { description: "Task automation ID" }) id: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const automation = requireAutomation(id);
    const runs = listTaskAutomationRuns(id, 10);

    const payload = { automation, runs };
    if (asJson) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(`\nTask automation: ${automation.name}\n`);
      console.log(`  ID:              ${automation.id}`);
      console.log(`  Enabled:         ${automation.enabled ? "yes" : "no"}`);
      console.log(`  Events:          ${automation.eventTypes.join(", ")}`);
      console.log(`  Profile:         ${automation.profileId ?? "(inherit trigger task profile)"}`);
      console.log(`  Agent:           ${automation.agentId ?? "(create open task only)"}`);
      console.log(`  Session:         ${automation.sessionNameTemplate ?? "(default task session name)"}`);
      console.log(`  Priority:        ${automation.priority ?? "(inherit trigger task priority)"}`);
      console.log(
        `  Checkpoint:      ${
          typeof automation.checkpointIntervalMs === "number"
            ? formatDurationMs(automation.checkpointIntervalMs)
            : automation.inheritCheckpoint
              ? "(inherit trigger task checkpoint)"
              : "(fresh default)"
        }`,
      );
      console.log(
        `  Report to:       ${
          automation.reportToSessionNameTemplate ??
          (automation.inheritReportTo ? "(inherit trigger task report target)" : "(fresh default)")
        }`,
      );
      console.log(
        `  Report events:   ${
          automation.reportEvents?.join(",") ??
          (automation.inheritReportEvents ? "(inherit trigger task report events)" : "(fresh default)")
        }`,
      );
      console.log(`  Parent link:     ${automation.inheritParentTask ? "child of trigger task" : "detached"}`);
      console.log(`  Worktree:        ${automation.inheritWorktree ? "inherit trigger task worktree" : "fresh"}`);
      if (automation.filter) {
        console.log(`  Filter:          ${automation.filter}`);
      }
      if (automation.profileInput && Object.keys(automation.profileInput).length > 0) {
        console.log(
          `  Input:           ${Object.entries(automation.profileInput)
            .map(([key, value]) => `${key}=${value}`)
            .join(", ")}`,
        );
      }
      console.log(`  Fires:           ${automation.fireCount}`);
      console.log(`  Last fired:      ${formatTime(automation.lastFiredAt)}`);
      console.log(`  Created:         ${formatTime(automation.createdAt)}`);
      console.log(`  Updated:         ${formatTime(automation.updatedAt)}`);

      console.log("\n  Title template:");
      console.log(`    ${automation.titleTemplate.split("\n").join("\n    ")}`);
      console.log("\n  Instructions template:");
      console.log(`    ${automation.instructionsTemplate.split("\n").join("\n    ")}`);

      if (runs.length > 0) {
        console.log("\nRecent runs:");
        for (const run of runs) {
          console.log(
            `  - ${formatTime(run.createdAt)} :: ${run.status} :: ${run.triggerEventType} :: trigger ${run.triggerTaskId}${run.spawnedTaskId ? ` -> ${run.spawnedTaskId}` : ""}${run.message ? ` :: ${run.message}` : ""}`,
          );
        }
      }
    }
    return payload;
  }

  @Command({ name: "add", description: "Create a new task automation" })
  add(
    @Arg("name", { description: "Task automation name" }) name: string,
    @Option({ flags: "--on <events>", description: `Comma-separated events: ${TASK_AUTOMATION_EVENTS.join(",")}` })
    events?: string,
    @Option({ flags: "--title <text>", description: "Follow-up task title template" }) titleTemplate?: string,
    @Option({ flags: "--instructions <text>", description: "Follow-up task instructions template" })
    instructionsTemplate?: string,
    @Option({ flags: "--profile <id>", description: "Follow-up task profile (default: inherit trigger task profile)" })
    profileId?: string,
    @Option({ flags: "--priority <level>", description: "low|normal|high|urgent (default: inherit trigger task)" })
    priority?: string,
    @Option({ flags: "--agent <id>", description: "Auto-dispatch follow-up tasks to this agent" }) agentId?: string,
    @Option({ flags: "--session <template>", description: "Optional session name template for auto-dispatch" })
    sessionNameTemplate?: string,
    @Option({ flags: "--checkpoint <duration>", description: "Override follow-up checkpoint interval" })
    checkpoint?: string,
    @Option({ flags: "--report-to <template>", description: "Override follow-up report target session" })
    reportToSessionNameTemplate?: string,
    @Option({
      flags: "--report-events <events>",
      description: `Comma-separated report events: ${TASK_REPORT_EVENTS.join(",")}`,
    })
    reportEvents?: string,
    @Option({ flags: "--filter <expression>", description: "Optional filter expression on task event data" })
    filter?: string,
    @Option({ flags: "--input <key=value...>", description: "Profile input templates for the follow-up task" })
    profileInputRaw?: string[] | string,
    @Option({ flags: "--disabled", description: "Create the automation disabled" }) disabled?: boolean,
    @Option({ flags: "--detached", description: "Do not link the follow-up task as a child of the trigger task" })
    detached?: boolean,
    @Option({ flags: "--fresh-worktree", description: "Do not inherit the trigger task worktree" })
    freshWorktree?: boolean,
    @Option({ flags: "--fresh-checkpoint", description: "Do not inherit the trigger task checkpoint" })
    freshCheckpoint?: boolean,
    @Option({ flags: "--fresh-report-to", description: "Do not inherit the trigger task report target" })
    freshReportTo?: boolean,
    @Option({ flags: "--fresh-report-events", description: "Do not inherit the trigger task report events" })
    freshReportEvents?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    if (!titleTemplate?.trim()) {
      fail("--title is required");
    }
    if (!instructionsTemplate?.trim()) {
      fail("--instructions is required");
    }

    const automation = createTaskAutomation({
      name,
      eventTypes: parseAutomationEvents(events),
      titleTemplate: titleTemplate.trim(),
      instructionsTemplate: instructionsTemplate.trim(),
      ...(profileId?.trim() ? { profileId: profileId.trim() } : {}),
      ...(requirePriority(priority) ? { priority: requirePriority(priority) } : {}),
      ...(agentId?.trim() ? { agentId: agentId.trim() } : {}),
      ...(sessionNameTemplate?.trim() ? { sessionNameTemplate: sessionNameTemplate.trim() } : {}),
      ...(typeof parseCheckpointInterval(checkpoint) === "number"
        ? { checkpointIntervalMs: parseCheckpointInterval(checkpoint) }
        : {}),
      ...(reportToSessionNameTemplate?.trim()
        ? { reportToSessionNameTemplate: reportToSessionNameTemplate.trim() }
        : {}),
      ...(parseReportEvents(reportEvents) ? { reportEvents: parseReportEvents(reportEvents) } : {}),
      ...(filter?.trim() ? { filter: filter.trim() } : {}),
      ...(parseProfileInputs(profileInputRaw) ? { profileInput: parseProfileInputs(profileInputRaw) } : {}),
      enabled: disabled !== true,
      inheritParentTask: detached !== true,
      inheritWorktree: freshWorktree !== true,
      inheritCheckpoint: freshCheckpoint !== true,
      inheritReportTo: freshReportTo !== true,
      inheritReportEvents: freshReportEvents !== true,
    });

    const payload = {
      status: "created" as const,
      target: { type: "task-automation" as const, id: automation.id },
      changedCount: 1,
      automation,
    };
    if (asJson) {
      printJson(payload);
    } else {
      console.log(`\n✓ Created task automation: ${automation.id}`);
      console.log(`  Name:      ${automation.name}`);
      console.log(`  Events:    ${automation.eventTypes.join(", ")}`);
      console.log(`  Target:    ${automation.profileId ?? "(inherit)"}/${automation.agentId ?? "open"}`);
      console.log(`  Enabled:   ${automation.enabled ? "yes" : "no"}`);
    }
    return payload;
  }

  @Command({ name: "enable", description: "Enable a task automation" })
  enable(
    @Arg("id", { description: "Task automation ID" }) id: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const automation = requireAutomation(id);
    const updated = updateTaskAutomation(id, { enabled: true });
    const payload = {
      status: "enabled" as const,
      target: { type: "task-automation" as const, id: updated.id },
      changedCount: 1,
      automation: updated,
    };
    if (asJson) {
      printJson(payload);
    } else {
      console.log(`✓ Enabled task automation: ${updated.id} (${automation.name})`);
    }
    return payload;
  }

  @Command({ name: "disable", description: "Disable a task automation" })
  disable(
    @Arg("id", { description: "Task automation ID" }) id: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const automation = requireAutomation(id);
    const updated = updateTaskAutomation(id, { enabled: false });
    const payload = {
      status: "disabled" as const,
      target: { type: "task-automation" as const, id: updated.id },
      changedCount: 1,
      automation: updated,
    };
    if (asJson) {
      printJson(payload);
    } else {
      console.log(`✓ Disabled task automation: ${updated.id} (${automation.name})`);
    }
    return payload;
  }

  @Command({ name: "rm", description: "Delete a task automation", aliases: ["delete", "remove"] })
  remove(
    @Arg("id", { description: "Task automation ID" }) id: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const automation = requireAutomation(id);
    if (!deleteTaskAutomation(id)) {
      fail(`Task automation not found: ${id}`);
    }
    const payload = {
      status: "deleted" as const,
      target: { type: "task-automation" as const, id },
      changedCount: 1,
      automation,
    };
    if (asJson) {
      printJson(payload);
    } else {
      console.log(`✓ Deleted task automation: ${id} (${automation.name})`);
    }
    return payload;
  }
}
