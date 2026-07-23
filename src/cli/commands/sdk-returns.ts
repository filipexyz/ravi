import "reflect-metadata";
import { z } from "zod";
import { Arg, CliOnly, Command, CommandAccess, Group, Option, Returns } from "../decorators.js";
import { fail } from "../context.js";
import { buildCliOffsetPagination } from "../pagination.js";
import {
  RETURN_SCHEMA_KINDS,
  RETURN_SCHEMA_STATUSES,
  assignReturnSchemaCommands,
  buildReturnSchemaTaskPlan,
  getReturnSchemaCommand,
  listReturnSchemaCommands,
  markReturnSchemaCommand,
  syncReturnSchemaWorkflow,
  validateReturnSchemaWorkflow,
  type ReturnSchemaKind,
  type ReturnSchemaStatus,
} from "../../sdk/return-schemas/workflow.js";

const returnSchemaStatusSchema = z.enum(RETURN_SCHEMA_STATUSES);
const returnSchemaKindSchema = z.enum(RETURN_SCHEMA_KINDS);

const timestampSchema = z.string();
const nullableStringSchema = z.string().nullable();

const returnSchemaRecordSchema = z.object({
  fullName: z.string(),
  groupPath: z.string(),
  commandName: z.string(),
  className: z.string(),
  methodName: z.string(),
  scope: z.string(),
  returnKind: returnSchemaKindSchema,
  status: returnSchemaStatusSchema,
  schemaHash: nullableStringSchema,
  schemaJson: nullableStringSchema,
  firstSeenAt: timestampSchema,
  lastSeenAt: timestampSchema,
  updatedAt: timestampSchema,
  typedAt: nullableStringSchema,
  validatedAt: nullableStringSchema,
  reviewedAt: nullableStringSchema,
  removedAt: nullableStringSchema,
  owner: nullableStringSchema,
  taskId: nullableStringSchema,
  notes: nullableStringSchema,
});

const countByStatusSchema = z.record(returnSchemaStatusSchema, z.number());
const countByKindSchema = z.record(returnSchemaKindSchema, z.number());

const returnSchemaSummarySchema = z.object({
  generatedAt: z.string(),
  dbPath: z.string(),
  total: z.number(),
  publicCommands: z.number(),
  cliOnly: z.number(),
  typedPublic: z.number(),
  binaryPublic: z.number(),
  missingPublic: z.number(),
  baselineMissingPublic: z.number(),
  weakPublic: z.number(),
  baselineWeakPublic: z.number(),
  newlyWeak: z.array(z.string()),
  strengthenedButStillListed: z.array(z.string()),
  cliOnlyCommands: z.array(z.string()),
  reviewedPublic: z.number(),
  unreviewedPublic: z.number(),
  unreviewedPublicCommands: z.array(z.string()),
  newlyUntyped: z.array(z.string()),
  resolvedButStillListed: z.array(z.string()),
  byStatus: countByStatusSchema,
  byKind: countByKindSchema,
  topMissingGroups: z.array(z.object({ group: z.string(), count: z.number() })),
});

const paginationSchema = z.object({
  limit: z.number(),
  offset: z.number(),
  returned: z.number(),
  total: z.number(),
  hasMore: z.boolean(),
  nextOffset: z.number().nullable(),
  nextCommand: z.string().nullable(),
});

const returnsSyncSchema = z.object({
  summary: returnSchemaSummarySchema,
  inserted: z.number(),
  updated: z.number(),
  removed: z.number(),
});

const returnsListSchema = z.object({
  total: z.number(),
  pagination: paginationSchema,
  filters: z.object({
    status: returnSchemaStatusSchema.nullable(),
    kind: returnSchemaKindSchema.nullable(),
    group: z.string().nullable(),
    search: z.string().nullable(),
  }),
  items: z.array(returnSchemaRecordSchema),
  commands: z.array(returnSchemaRecordSchema),
});

const returnsShowSchema = z.object({
  command: returnSchemaRecordSchema,
});

const returnsMarkSchema = z.object({
  command: returnSchemaRecordSchema,
});

const returnsAssignSchema = z.object({
  taskId: z.string(),
  status: returnSchemaStatusSchema,
  matched: z.number(),
  updated: z.number(),
  commands: z.array(z.string()),
});

const returnsValidateSchema = z.object({
  ok: z.boolean(),
  strict: z.boolean(),
  summary: returnSchemaSummarySchema,
  issues: z.array(
    z.object({
      level: z.enum(["error", "warning"]),
      code: z.string(),
      command: z.string().optional(),
      message: z.string(),
    }),
  ),
});

const returnsPlanSchema = z.object({
  generatedAt: z.string(),
  totalMissingPublic: z.number(),
  tasks: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      groups: z.array(z.string()),
      missingPublic: z.number(),
      commands: z.array(z.string()),
    }),
  ),
});

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

function parseStatus(value: string | undefined, label: string): ReturnSchemaStatus | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (!RETURN_SCHEMA_STATUSES.includes(normalized as ReturnSchemaStatus)) {
    fail(`${label} must be one of: ${RETURN_SCHEMA_STATUSES.join(", ")}`);
  }
  return normalized as ReturnSchemaStatus;
}

function parseKind(value: string | undefined): ReturnSchemaKind | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (!RETURN_SCHEMA_KINDS.includes(normalized as ReturnSchemaKind)) {
    fail(`--kind must be one of: ${RETURN_SCHEMA_KINDS.join(", ")}`);
  }
  return normalized as ReturnSchemaKind;
}

function parseLimit(value: string | undefined): number {
  if (!value?.trim()) return 50;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) fail("--limit must be a positive integer.");
  return Math.min(parsed, 1000);
}

function parseOffset(value: string | undefined): number {
  if (!value?.trim()) return 0;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) fail("--offset must be a non-negative integer.");
  return parsed;
}

function printSummary(summary: z.infer<typeof returnSchemaSummarySchema>): void {
  console.log(
    `CLI return schemas: ${summary.publicCommands} public commands, ${summary.missingPublic} missing @Returns (${summary.typedPublic} JSON, ${summary.binaryPublic} binary).`,
  );
  console.log(`Tracking DB: ${summary.dbPath}`);
  if (summary.newlyUntyped.length > 0) {
    console.log(`New untyped public commands: ${summary.newlyUntyped.length}`);
  }
  if (summary.resolvedButStillListed.length > 0) {
    console.log(`Baseline can shrink: ${summary.resolvedButStillListed.length}`);
  }
  if (summary.weakPublic > 0) {
    console.log(`Weak public return schemas: ${summary.weakPublic} (baseline ${summary.baselineWeakPublic})`);
  }
  if (summary.newlyWeak.length > 0) {
    console.log(`New weak public return schemas: ${summary.newlyWeak.length}`);
  }
  if (summary.cliOnlyCommands.length > 0) {
    console.log(`CLI-only commands hidden from SDK/docs: ${summary.cliOnlyCommands.length}`);
  }
  if (summary.unreviewedPublic > 0) {
    console.log(`Unreviewed typed public return schemas: ${summary.unreviewedPublic}`);
  }
  if (summary.topMissingGroups.length > 0) {
    console.log("Top missing groups:");
    for (const item of summary.topMissingGroups.slice(0, 10)) {
      console.log(`  ${item.group}: ${item.count}`);
    }
  }
}

@Group({
  name: "sdk.returns",
  description: "Track CLI return-schema migration state",
  scope: "open",
})
export class SdkReturnsCommands {
  @Command({ name: "sync", description: "Sync the local return-schema tracking table with the live CLI registry" })
  @CommandAccess({ kind: "mutate", resource: "sdk.returns", action: "sync", risk: "medium" })
  @CliOnly()
  @Returns(returnsSyncSchema)
  sync(@Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean) {
    try {
      const payload = syncReturnSchemaWorkflow();
      if (asJson) {
        printJson(payload);
      } else {
        console.log(
          `Synced return-schema table: ${payload.inserted} inserted, ${payload.updated} updated, ${payload.removed} removed.`,
        );
        printSummary(payload.summary);
      }
      return payload;
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }

  @Command({ name: "status", description: "Show typed-return coverage and migration state" })
  @CommandAccess({ kind: "mutate", resource: "sdk.returns", action: "status", risk: "low" })
  @CliOnly()
  @Returns(returnSchemaSummarySchema)
  status(@Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean) {
    try {
      const payload = syncReturnSchemaWorkflow().summary;
      if (asJson) {
        printJson(payload);
      } else {
        printSummary(payload);
        console.log("By state:");
        for (const status of RETURN_SCHEMA_STATUSES) {
          console.log(`  ${status}: ${payload.byStatus[status]}`);
        }
      }
      return payload;
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }

  @Command({ name: "list", description: "List tracked commands by return-schema migration state" })
  @CommandAccess({ kind: "mutate", resource: "sdk.returns", action: "list", risk: "low" })
  @CliOnly()
  @Returns(returnsListSchema)
  list(
    @Option({ flags: "--status <state>", description: "Filter by migration state" }) statusValue?: string,
    @Option({ flags: "--kind <kind>", description: "Filter by return kind" }) kindValue?: string,
    @Option({ flags: "--group <path>", description: "Filter by command group prefix" }) group?: string,
    @Option({ flags: "--search <text>", description: "Search command, task, or notes" }) search?: string,
    @Option({ flags: "--limit <n>", description: "Page size (default 50, max 1000)" }) limitValue?: string,
    @Option({ flags: "--offset <n>", description: "Number of rows to skip" }) offsetValue?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    try {
      syncReturnSchemaWorkflow();
      const status = parseStatus(statusValue, "--status") ?? null;
      const kind = parseKind(kindValue) ?? null;
      const limit = parseLimit(limitValue);
      const offset = parseOffset(offsetValue);
      const page = listReturnSchemaCommands({
        status,
        kind,
        group: group?.trim() || null,
        search: search?.trim() || null,
        limit,
        offset,
      });
      const pagination = buildCliOffsetPagination({
        baseCommand: ["ravi", "sdk", "returns", "list"],
        limit,
        offset,
        returned: page.items.length,
        total: page.total,
        options: ["--status", status, "--kind", kind, "--group", group, "--search", search],
      });
      const payload = {
        total: page.total,
        pagination,
        filters: {
          status,
          kind,
          group: group?.trim() || null,
          search: search?.trim() || null,
        },
        items: page.items,
        commands: page.items,
      };
      if (asJson) {
        printJson(payload);
      } else {
        console.log(`Return-schema commands (${page.items.length} returned of ${page.total}):`);
        for (const item of page.items) {
          const suffix = item.taskId ? ` task=${item.taskId}` : "";
          console.log(`  ${item.fullName} [${item.returnKind}/${item.status}]${suffix}`);
        }
        if (pagination.nextCommand) {
          console.log("\nNext page:");
          console.log(`  ${pagination.nextCommand}`);
        }
      }
      return payload;
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }

  @Command({ name: "show", description: "Show one tracked return-schema command row" })
  @CommandAccess({ kind: "mutate", resource: "sdk.returns", action: "show", risk: "low", input: ["commandName"] })
  @CliOnly()
  @Returns(returnsShowSchema)
  show(
    @Arg("command", { description: "Full command name, e.g. sessions.list" }) commandName: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    try {
      syncReturnSchemaWorkflow();
      const command = getReturnSchemaCommand(commandName);
      if (!command) fail(`Return schema command not found: ${commandName}`);
      const payload = { command };
      if (asJson) {
        printJson(payload);
      } else {
        console.log(`${command.fullName} [${command.returnKind}/${command.status}]`);
        console.log(`  class: ${command.className}.${command.methodName}`);
        console.log(`  scope: ${command.scope}`);
        console.log(`  schemaHash: ${command.schemaHash ?? "none"}`);
        if (command.taskId) console.log(`  task: ${command.taskId}`);
        if (command.notes) console.log(`  notes: ${command.notes}`);
      }
      return payload;
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }

  @Command({ name: "mark", description: "Mark one command's return-schema migration state" })
  @CommandAccess({ kind: "mutate", resource: "sdk.returns", action: "mark", risk: "medium", input: ["commandName"] })
  @CliOnly()
  @Returns(returnsMarkSchema)
  mark(
    @Arg("command", { description: "Full command name, e.g. sessions.list" }) commandName: string,
    @Option({ flags: "--state <state>", description: "New state" }) statusValue?: string,
    @Option({ flags: "--owner <name>", description: "Owner or reviewer" }) owner?: string,
    @Option({ flags: "--task <id>", description: "Tracking task id" }) taskId?: string,
    @Option({ flags: "--note <text>", description: "Tracking note" }) notes?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    try {
      syncReturnSchemaWorkflow();
      const status = parseStatus(statusValue, "--state");
      if (!status) fail("--state <state> is required.");
      const command = markReturnSchemaCommand({
        fullName: commandName,
        status,
        owner,
        taskId,
        notes,
      });
      const payload = { command };
      if (asJson) {
        printJson(payload);
      } else {
        console.log(`Marked ${command.fullName} as ${command.status}.`);
      }
      return payload;
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }

  @Command({ name: "assign", description: "Assign a filtered batch of return-schema rows to one task" })
  @CommandAccess({ kind: "mutate", resource: "sdk.returns", action: "assign", risk: "medium", input: ["taskId"] })
  @CliOnly()
  @Returns(returnsAssignSchema)
  assign(
    @Option({ flags: "--task <id>", description: "Tracking task id" }) taskId?: string,
    @Option({ flags: "--groups <csv>", description: "Comma-separated group prefixes; omitted means all matching rows" })
    groupsValue?: string,
    @Option({ flags: "--kind <kind>", description: "Return kind to assign (default: missing)" }) kindValue?: string,
    @Option({ flags: "--state <state>", description: "State to set (default: in_progress)" }) statusValue?: string,
    @Option({ flags: "--owner <name>", description: "Owner or reviewer" }) owner?: string,
    @Option({ flags: "--note <text>", description: "Tracking note" }) notes?: string,
    @Option({ flags: "--include-assigned", description: "Also update rows that already have a task id" })
    includeAssigned?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    try {
      syncReturnSchemaWorkflow();
      if (!taskId?.trim()) fail("--task <id> is required.");
      const groups = groupsValue
        ?.split(",")
        .map((group) => group.trim())
        .filter(Boolean);
      const kind = parseKind(kindValue) ?? "missing";
      const status = parseStatus(statusValue, "--state") ?? "in_progress";
      const payload = assignReturnSchemaCommands({
        taskId,
        groups,
        kind,
        status,
        owner,
        notes,
        onlyUnassigned: includeAssigned !== true,
      });
      if (asJson) {
        printJson(payload);
      } else {
        console.log(`Assigned ${payload.updated}/${payload.matched} return-schema rows to ${payload.taskId}.`);
      }
      return payload;
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }

  @Command({ name: "validate", description: "Validate tracking rows against the live CLI registry and debt baseline" })
  @CommandAccess({ kind: "mutate", resource: "sdk.returns", action: "validate", risk: "low" })
  @CliOnly()
  @Returns(returnsValidateSchema)
  validate(
    @Option({
      flags: "--strict",
      description: "Fail on weak-schema baseline debt and unreviewed public return schemas",
    })
    strict?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    try {
      syncReturnSchemaWorkflow();
      const payload = validateReturnSchemaWorkflow({ strict: strict === true });
      if (asJson) {
        printJson(payload);
      } else if (payload.ok) {
        console.log(payload.strict ? "Return-schema tracking is strictly valid." : "Return-schema tracking is valid.");
        printSummary(payload.summary);
      } else {
        console.log(`Return-schema tracking has ${payload.issues.length} issue(s):`);
        for (const issue of payload.issues) {
          console.log(`  ${issue.level}: ${issue.code}${issue.command ? ` ${issue.command}` : ""}`);
          console.log(`    ${issue.message}`);
        }
      }
      if (!payload.ok) process.exitCode = 1;
      return payload;
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }

  @Command({ name: "plan", description: "Print suggested migration task batches for missing public return schemas" })
  @CommandAccess({ kind: "mutate", resource: "sdk.returns", action: "plan", risk: "low" })
  @CliOnly()
  @Returns(returnsPlanSchema)
  plan(@Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean) {
    try {
      syncReturnSchemaWorkflow();
      const payload = buildReturnSchemaTaskPlan();
      if (asJson) {
        printJson(payload);
      } else {
        console.log(`Return-schema migration plan: ${payload.totalMissingPublic} public commands missing @Returns.`);
        for (const task of payload.tasks) {
          console.log(`\n${task.id}: ${task.title}`);
          console.log(`  ${task.missingPublic} commands`);
          console.log(`  groups: ${task.groups.length > 0 ? task.groups.join(", ") : "remaining"}`);
        }
      }
      return payload;
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }
}
