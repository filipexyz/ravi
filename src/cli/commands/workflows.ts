import "reflect-metadata";
import { readFileSync, rmSync } from "node:fs";
import { Arg, Command, CommandAccess, Group, Option, Returns } from "../decorators.js";
import { ContractError, contractDryRun, contractFail, pickFields, suggestSimilar } from "../agent-contract.js";
import { fail } from "../context.js";
import { buildCliOffsetPagination, paginateCliItems } from "../pagination.js";
import {
  WorkflowSpecDefinitionSchema,
  archiveWorkflowNodeRun,
  assertCanAttachTaskToWorkflowNodeRun,
  attachTaskToWorkflowNodeRun,
  cancelWorkflowNodeRun,
  createWorkflowSpec,
  getWorkflowRunDetails,
  getWorkflowSpec,
  listWorkflowRuns,
  listWorkflowSpecs,
  releaseWorkflowNodeRun,
  skipWorkflowNodeRun,
  startWorkflowRun,
} from "../../workflows/index.js";
import {
  createTask,
  dbDeleteTask,
  emitTaskEvent,
  getDefaultTaskSessionNameForTask,
  getCanonicalTaskDir,
  getTaskActor,
  queueOrDispatchTask,
  requireTaskRuntimeAgent,
} from "../../tasks/index.js";
import type { TaskPriority } from "../../tasks/types.js";
import {
  workflowRunDetailsReturnSchema,
  workflowRunMutationReturnSchema,
  workflowRunsListReturnSchema,
  workflowSpecReturnSchema,
  workflowSpecsListReturnSchema,
  workflowTaskCreateReturnSchema,
} from "./operational-return-schemas.js";

const VALID_PRIORITIES = new Set<TaskPriority>(["low", "normal", "high", "urgent"]);

function parseWorkflowDefinition(definition?: string, filePath?: string) {
  if (definition?.trim() && filePath?.trim()) {
    fail("Use either --definition or --file, not both.");
  }
  const raw = definition?.trim() ? definition : filePath?.trim() ? readFileSync(filePath.trim(), "utf-8") : null;
  if (!raw) {
    fail("Provide --definition '<json>' or --file <path>.");
  }

  try {
    return WorkflowSpecDefinitionSchema.parse(JSON.parse(raw));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

function requirePriority(value?: string): TaskPriority {
  const normalized = (value ?? "normal").trim().toLowerCase() as TaskPriority;
  if (!VALID_PRIORITIES.has(normalized)) {
    fail(`Invalid priority: ${value}. Use low|normal|high|urgent.`);
  }
  return normalized;
}

function printWorkflowRun(details: NonNullable<ReturnType<typeof getWorkflowRunDetails>>): void {
  console.log(`\nWorkflow run ${details.run.id}`);
  console.log(`Spec:        ${details.spec.id}`);
  console.log(`Title:       ${details.run.title}`);
  console.log(`Status:      ${details.run.status}`);
  console.log(
    `Nodes:       ${details.counts.done}/${details.counts.total} done | ${details.counts.ready} ready | ${details.counts.awaitingRelease} awaiting release | ${details.counts.pending} pending | ${details.counts.running} running | ${details.counts.blocked} blocked | ${details.counts.failed} failed`,
  );

  console.log("\nNodes:");
  for (const node of details.nodes) {
    const currentTask = node.currentTask
      ? `${node.currentTask.id} (${node.currentTask.visualStatus}, ${node.currentTask.progress}%)`
      : "-";
    const waitingOn = node.waitingOnNodeKeys.length > 0 ? node.waitingOnNodeKeys.join(", ") : "-";
    console.log(
      `  - ${node.specNodeKey} :: ${node.status} :: ${node.kind}/${node.requirement}/${node.releaseMode} :: task ${currentTask} :: waiting on ${waitingOn}`,
    );
  }
}

async function emitCreatedTask(result: Awaited<ReturnType<typeof createTask>>) {
  await emitTaskEvent(result.task, result.event);
  for (const related of result.relatedEvents) {
    await emitTaskEvent(related.task, related.event);
  }
}

async function emitDispatchResult(result: Awaited<ReturnType<typeof queueOrDispatchTask>>) {
  await emitTaskEvent(result.task, result.event);
  if (result.mode === "launch_planned") {
    return;
  }
}

// ============================================================
// Manual v2 contract helpers (error envelope + suggestions).
// Text mode keeps the legacy `fail()` behavior; `--json` emits the
// {success:false, error:{code, ...suggestions}} envelope. Exit taxonomy:
// 1 not-found/provider · 2 usage · 3 policy (write brake / dry-run).
//
// Suggestion sources are the exact lists `workflows specs list` /
// `workflows runs list` print, and the node keys of the referenced run.
// ============================================================

function failWorkflowSpecNotFound(op: string, specId: string, asJson?: boolean): never {
  const candidates = listWorkflowSpecs()
    .slice(0, 40)
    .flatMap((spec) => [spec.id, spec.title]);
  contractFail(op, "WORKFLOW_SPEC_NOT_FOUND", `Workflow spec not found: ${specId}`, {
    asJson,
    details: {
      suggestedAction: "Check the spec id (see suggestions; list with: ravi workflows specs list --json)",
      suggestions: suggestSimilar(specId, candidates),
    },
  });
}

function failWorkflowRunNotFound(op: string, runId: string, asJson?: boolean): never {
  const candidates = listWorkflowRuns()
    .slice(0, 40)
    .flatMap((run) => [run.id, run.title]);
  contractFail(op, "WORKFLOW_RUN_NOT_FOUND", `Workflow run not found: ${runId}`, {
    asJson,
    details: {
      suggestedAction: "Check the workflow run id (see suggestions; list with: ravi workflows runs list --json)",
      suggestions: suggestSimilar(runId, candidates),
    },
  });
}

function failWorkflowNodeNotFound(op: string, runId: string, nodeKey: string, asJson?: boolean): never {
  const details = getWorkflowRunDetails(runId);
  const candidates = (details?.nodes ?? []).flatMap((node) => [node.specNodeKey, node.label ?? ""]);
  contractFail(op, "WORKFLOW_NODE_NOT_FOUND", `Workflow node not found in run ${runId}: ${nodeKey}`, {
    asJson,
    details: {
      suggestedAction: "Check the node key (see suggestions; inspect with: ravi workflows runs show <run-id> --json)",
      suggestions: suggestSimilar(nodeKey, candidates),
    },
  });
}

/**
 * Node-level ops pre-resolve the run so a missing RUN surfaces as
 * `WORKFLOW_RUN_NOT_FOUND` instead of the service's ambiguous
 * `Workflow node K not found in run R.` throw (the service cannot tell the
 * two cases apart: an unknown run also has no node rows).
 */
function requireWorkflowRunDetailsForContract(
  op: string,
  runId: string,
  asJson?: boolean,
): NonNullable<ReturnType<typeof getWorkflowRunDetails>> {
  const details = getWorkflowRunDetails(runId);
  if (!details) failWorkflowRunNotFound(op, runId, asJson);
  return details;
}

/**
 * The workflows service layer throws on unknown refs (`Workflow spec not
 * found: X`, `Workflow node K not found in run R.`, `Task not found: X`); map
 * those throws to the contract envelope, let ContractError pass through
 * untouched (so the write brake keeps exit 3), and keep every other error on
 * the legacy fail() path.
 */
function rethrowWorkflowCommandError(op: string, error: unknown, asJson?: boolean): never {
  if (error instanceof ContractError) throw error;
  const message = error instanceof Error ? error.message : String(error);
  const spec = /^Workflow spec not found: (.+)$/.exec(message);
  if (spec?.[1]) failWorkflowSpecNotFound(op, spec[1], asJson);
  const node = /^Workflow node (.+) not found in run (.+)\.$/.exec(message);
  if (node?.[1] && node[2]) failWorkflowNodeNotFound(op, node[2], node[1], asJson);
  const task = /^Task not found: (.+)$/.exec(message);
  if (task?.[1]) {
    contractFail(op, "TASK_NOT_FOUND", message, {
      asJson,
      details: { suggestedAction: "Check the task id (list with: ravi tasks list --json)" },
    });
  }
  fail(message);
}

@Group({
  name: "workflows.specs",
  description: "Workflow substrate specs",
  scope: "open",
})
export class WorkflowSpecCommands {
  @Command({ name: "create", description: "Create one workflow spec from narrow JSON definition" })
  @CommandAccess({ kind: "mutate", resource: "workflows.specs", action: "create", risk: "medium" })
  @Returns(workflowSpecReturnSchema)
  create(
    @Arg("specId", { description: "Stable workflow spec id" }) specId: string,
    @Option({ flags: "--definition <json>", description: "Inline JSON definition with title/nodes/edges/policy" })
    definition?: string,
    @Option({ flags: "--file <path>", description: "Path to a JSON workflow definition" }) filePath?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const parsed = parseWorkflowDefinition(definition, filePath);
    const actor = getTaskActor();
    const spec = createWorkflowSpec({
      id: specId,
      title: parsed.title,
      ...(parsed.summary ? { summary: parsed.summary } : {}),
      ...(parsed.policy ? { policy: parsed.policy } : {}),
      nodes: parsed.nodes,
      edges: parsed.edges ?? [],
      ...(actor.actor ? { createdBy: actor.actor } : {}),
      ...(actor.agentId ? { createdByAgentId: actor.agentId } : {}),
      ...(actor.sessionName ? { createdBySessionName: actor.sessionName } : {}),
    });

    if (asJson) {
      console.log(JSON.stringify(spec, null, 2));
    } else {
      console.log(`\n✓ Workflow spec created: ${spec.id}`);
      console.log(`  Title: ${spec.title}`);
      console.log(`  Nodes: ${spec.nodes.length}`);
      console.log(`  Edges: ${spec.edges.length}`);
    }
    return spec;
  }

  @Command({ name: "list", description: "List workflow specs" })
  @CommandAccess({ kind: "read", resource: "workflows.specs", action: "list", risk: "low" })
  @Returns(workflowSpecsListReturnSchema)
  list(
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--limit <n>", description: "Page size (default: 50, max: 500)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Number of matching workflow specs to skip (default: 0)" })
    offset?: string,
    @Option({ flags: "--fields <csv>", description: "Compact mode: keep only these top-level fields per item" })
    fields?: string,
  ) {
    const specs = listWorkflowSpecs();
    const page = paginateCliItems(specs, { limit, offset });
    const pagination = buildCliOffsetPagination({
      fields,
      baseCommand: ["ravi", "workflows", "specs", "list"],
      limit: page.limit,
      offset: page.offset,
      returned: page.items.length,
      total: page.total,
    });
    const projectedSpecs = pickFields(page.items, fields);
    const payload = { total: page.total, pagination, items: projectedSpecs, specs: projectedSpecs };
    if (asJson) {
      console.log(JSON.stringify(payload, null, 2));
    } else if (page.items.length === 0) {
      console.log("No workflow specs found.");
    } else {
      console.log("");
      for (const spec of page.items) {
        console.log(`${spec.id} :: ${spec.title} :: ${spec.nodes.length} nodes :: ${spec.edges.length} edges`);
      }
      if (pagination.nextCommand) {
        console.log("\nNext page:");
        console.log(`  ${pagination.nextCommand}`);
      }
    }
    return payload;
  }

  @Command({ name: "show", description: "Show one workflow spec" })
  @CommandAccess({ kind: "read", resource: "workflows.specs", action: "show", risk: "low" })
  @Returns(workflowSpecReturnSchema)
  show(
    @Arg("specId", { description: "Workflow spec id" }) specId: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const spec = getWorkflowSpec(specId);
    if (!spec) {
      failWorkflowSpecNotFound("workflows specs show", specId, asJson);
    }

    if (asJson) {
      console.log(JSON.stringify(spec, null, 2));
    } else {
      console.log(`\nWorkflow spec ${spec.id}`);
      console.log(`Title:  ${spec.title}`);
      console.log(`Policy: ${spec.policy.completionMode ?? "all_required"}`);

      console.log("\nNodes:");
      for (const node of spec.nodes) {
        console.log(`  - ${node.key} :: ${node.label} :: ${node.kind}/${node.requirement}/${node.releaseMode}`);
      }

      console.log("\nEdges:");
      if (spec.edges.length === 0) {
        console.log("  - none");
      } else {
        for (const edge of spec.edges) {
          console.log(`  - ${edge.from} -> ${edge.to}`);
        }
      }
    }
    return spec;
  }
}

@Group({
  name: "workflows.runs",
  description: "Workflow substrate runs",
  scope: "open",
})
export class WorkflowRunCommands {
  @Command({ name: "start", description: "Instantiate one workflow run from a spec" })
  @CommandAccess({
    kind: "mutate",
    resource: "workflows.runs",
    action: "start",
    risk: "high",
    requiresConfirmation: true,
  })
  @Returns(workflowRunDetailsReturnSchema)
  start(
    @Arg("specId", { description: "Workflow spec id" }) specId: string,
    @Option({ flags: "--run-id <id>", description: "Optional workflow run id" }) runId?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({
      flags: "--execute",
      description: "Actually start the workflow run; default is a dry-run that only shows the plan (exit 3)",
    })
    execute?: boolean,
  ) {
    try {
      // Validation before the brake: the spec must resolve before the dry-run
      // plan is shown.
      const spec = getWorkflowSpec(specId);
      if (!spec) {
        failWorkflowSpecNotFound("workflows runs start", specId, asJson);
      }

      if (execute !== true) {
        // Write brake (Manual v2 7.8): starting a run instantiates real node
        // runs that gate coordinated work (same class as `projects workflows
        // start`), so dry-run by default and exit 3 before any write.
        contractDryRun(
          "workflows runs start",
          {
            specId: spec.id,
            runId: runId?.trim() || null,
            titlePresent: Boolean(spec.title?.trim()),
            nodeCount: spec.nodes.length,
          },
          { asJson },
        );
      }

      const actor = getTaskActor();
      const details = startWorkflowRun(specId, {
        ...(runId?.trim() ? { runId: runId.trim() } : {}),
        ...(actor.actor ? { createdBy: actor.actor } : {}),
        ...(actor.agentId ? { createdByAgentId: actor.agentId } : {}),
        ...(actor.sessionName ? { createdBySessionName: actor.sessionName } : {}),
      });

      if (asJson) {
        console.log(JSON.stringify(details, null, 2));
      } else {
        console.log(`\n✓ Workflow run started: ${details.run.id}`);
        printWorkflowRun(details);
      }
      return details;
    } catch (error) {
      rethrowWorkflowCommandError("workflows runs start", error, asJson);
    }
  }

  @Command({ name: "list", description: "List workflow runs" })
  @CommandAccess({ kind: "read", resource: "workflows.runs", action: "list", risk: "low" })
  @Returns(workflowRunsListReturnSchema)
  list(
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--limit <n>", description: "Page size (default: 50, max: 500)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Number of matching workflow runs to skip (default: 0)" })
    offset?: string,
    @Option({ flags: "--fields <csv>", description: "Compact mode: keep only these top-level fields per item" })
    fields?: string,
  ) {
    const runs = listWorkflowRuns();
    const page = paginateCliItems(runs, { limit, offset });
    const pagination = buildCliOffsetPagination({
      fields,
      baseCommand: ["ravi", "workflows", "runs", "list"],
      limit: page.limit,
      offset: page.offset,
      returned: page.items.length,
      total: page.total,
    });
    const projectedRuns = pickFields(page.items, fields);
    const payload = { total: page.total, pagination, items: projectedRuns, runs: projectedRuns };
    if (asJson) {
      console.log(JSON.stringify(payload, null, 2));
    } else if (page.items.length === 0) {
      console.log("No workflow runs found.");
    } else {
      console.log("");
      for (const run of page.items) {
        console.log(`${run.id} :: ${run.status} :: ${run.workflowSpecId} :: ${run.title}`);
      }
      if (pagination.nextCommand) {
        console.log("\nNext page:");
        console.log(`  ${pagination.nextCommand}`);
      }
    }
    return payload;
  }

  @Command({ name: "show", description: "Show one workflow run with node state" })
  @CommandAccess({ kind: "read", resource: "workflows.runs", action: "show", risk: "low" })
  @Returns(workflowRunDetailsReturnSchema)
  show(
    @Arg("runId", { description: "Workflow run id" }) runId: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const details = getWorkflowRunDetails(runId);
    if (!details) {
      failWorkflowRunNotFound("workflows runs show", runId, asJson);
    }

    if (asJson) {
      console.log(JSON.stringify(details, null, 2));
    } else {
      printWorkflowRun(details);
    }
    return details;
  }

  @Command({ name: "release", description: "Release a manual node transition or gate" })
  @CommandAccess({ kind: "mutate", resource: "workflows.runs", action: "release", risk: "medium" })
  @Returns(workflowRunMutationReturnSchema)
  release(
    @Arg("runId", { description: "Workflow run id" }) runId: string,
    @Arg("nodeKey", { description: "Node key" }) nodeKey: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    try {
      requireWorkflowRunDetailsForContract("workflows runs release", runId, asJson);
      const actor = getTaskActor();
      const result = releaseWorkflowNodeRun(runId, nodeKey, actor);
      if (asJson) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`\n✓ Released ${nodeKey} in ${runId}`);
        printWorkflowRun(result.details);
      }
      return result;
    } catch (error) {
      rethrowWorkflowCommandError("workflows runs release", error, asJson);
    }
  }

  @Command({ name: "skip", description: "Skip one optional workflow node" })
  @CommandAccess({ kind: "mutate", resource: "workflows.runs", action: "skip", risk: "medium" })
  @Returns(workflowRunMutationReturnSchema)
  skip(
    @Arg("runId", { description: "Workflow run id" }) runId: string,
    @Arg("nodeKey", { description: "Node key" }) nodeKey: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    try {
      requireWorkflowRunDetailsForContract("workflows runs skip", runId, asJson);
      const result = skipWorkflowNodeRun(runId, nodeKey);
      if (asJson) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`\n✓ Skipped optional node ${nodeKey} in ${runId}`);
        printWorkflowRun(result.details);
      }
      return result;
    } catch (error) {
      rethrowWorkflowCommandError("workflows runs skip", error, asJson);
    }
  }

  @Command({ name: "cancel", description: "Cancel one workflow node run" })
  @CommandAccess({ kind: "mutate", resource: "workflows.runs", action: "cancel", risk: "medium" })
  @Returns(workflowRunMutationReturnSchema)
  cancel(
    @Arg("runId", { description: "Workflow run id" }) runId: string,
    @Arg("nodeKey", { description: "Node key" }) nodeKey: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    // Deliberately NOT braked (declared): cancel is the emergency stop for a
    // live node run — a still-active node keeps gating the aggregate until it
    // is cancelled, so putting an exit-3 dry-run in front of the stop action
    // would delay exactly the operation that limits damage (anti-safety).
    try {
      requireWorkflowRunDetailsForContract("workflows runs cancel", runId, asJson);
      const result = cancelWorkflowNodeRun(runId, nodeKey);
      if (asJson) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`\n✓ Cancelled node ${nodeKey} in ${runId}`);
        printWorkflowRun(result.details);
      }
      return result;
    } catch (error) {
      rethrowWorkflowCommandError("workflows runs cancel", error, asJson);
    }
  }

  @Command({ name: "archive-node", description: "Archive one node run from workflow aggregate state" })
  @CommandAccess({
    kind: "mutate",
    resource: "workflows.runs",
    action: "archive-node",
    risk: "medium",
    requiresConfirmation: true,
  })
  @Returns(workflowRunMutationReturnSchema)
  archiveNode(
    @Arg("runId", { description: "Workflow run id" }) runId: string,
    @Arg("nodeKey", { description: "Node key" }) nodeKey: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({
      flags: "--execute",
      description: "Actually archive the node run; default is a dry-run that only shows the plan (exit 3)",
    })
    execute?: boolean,
  ) {
    try {
      // Validation before the brake: run and node must resolve before the
      // dry-run plan is shown.
      const details = requireWorkflowRunDetailsForContract("workflows runs archive-node", runId, asJson);
      const node = details.nodes.find((candidate) => candidate.specNodeKey === nodeKey);
      if (!node) {
        failWorkflowNodeNotFound("workflows runs archive-node", runId, nodeKey, asJson);
      }

      if (execute !== true) {
        // Write brake (Manual v2 7.8): archiving is destructive — there is no
        // unarchive, and an archived node is permanently excluded from the
        // aggregate and rejects every further mutation (release/skip/cancel/
        // attach). Dry-run by default, exit 3 before the write.
        contractDryRun(
          "workflows runs archive-node",
          {
            runId,
            nodeKey,
            status: node.status,
            currentTaskId: node.currentTask?.id ?? null,
          },
          { asJson },
        );
      }

      const result = archiveWorkflowNodeRun(runId, nodeKey);
      if (asJson) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`\n✓ Archived node ${nodeKey} in ${runId}`);
        printWorkflowRun(result.details);
      }
      return result;
    } catch (error) {
      rethrowWorkflowCommandError("workflows runs archive-node", error, asJson);
    }
  }

  @Command({ name: "task-attach", description: "Attach an existing task to a workflow task node" })
  @CommandAccess({ kind: "mutate", resource: "workflows.runs", action: "task-attach", risk: "medium" })
  @Returns(workflowRunMutationReturnSchema)
  taskAttach(
    @Arg("runId", { description: "Workflow run id" }) runId: string,
    @Arg("nodeKey", { description: "Task node key" }) nodeKey: string,
    @Arg("taskId", { description: "Existing task id" }) taskId: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    try {
      requireWorkflowRunDetailsForContract("workflows runs task-attach", runId, asJson);
      const result = attachTaskToWorkflowNodeRun(runId, nodeKey, taskId);
      if (asJson) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`\n✓ Attached task ${taskId} to ${nodeKey} in ${runId}`);
        printWorkflowRun(result.details);
      }
      return result;
    } catch (error) {
      rethrowWorkflowCommandError("workflows runs task-attach", error, asJson);
    }
  }

  @Command({ name: "task-create", description: "Create a new task attempt for one workflow task node" })
  @CommandAccess({ kind: "mutate", resource: "workflows.runs", action: "task-create", risk: "medium" })
  @Returns(workflowTaskCreateReturnSchema)
  async taskCreate(
    @Arg("runId", { description: "Workflow run id" }) runId: string,
    @Arg("nodeKey", { description: "Task node key" }) nodeKey: string,
    @Option({ flags: "--title <text>", description: "Task title" }) title?: string,
    @Option({ flags: "--instructions <text>", description: "Task instructions" }) instructions?: string,
    @Option({ flags: "--priority <level>", description: "low|normal|high|urgent", defaultValue: "normal" })
    priority?: string,
    @Option({ flags: "--profile <id>", description: "Task profile id" }) profileId?: string,
    @Option({ flags: "--agent <id>", description: "Optional agent to dispatch immediately" }) agentId?: string,
    @Option({ flags: "--session <name>", description: "Optional session name for immediate dispatch" })
    sessionName?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    if (!title?.trim()) {
      fail("--title is required");
    }
    if (!instructions?.trim()) {
      fail("--instructions is required");
    }
    if (agentId?.trim()) {
      try {
        requireTaskRuntimeAgent(agentId.trim());
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
      }
    }
    requireWorkflowRunDetailsForContract("workflows runs task-create", runId, asJson);
    try {
      assertCanAttachTaskToWorkflowNodeRun(runId, nodeKey);
    } catch (error) {
      rethrowWorkflowCommandError("workflows runs task-create", error, asJson);
    }

    const actor = getTaskActor();
    const created = await createTask({
      title: title.trim(),
      instructions: instructions.trim(),
      priority: requirePriority(priority),
      ...(profileId?.trim() ? { profileId: profileId.trim() } : {}),
      ...(actor.actor ? { createdBy: actor.actor } : {}),
      ...(actor.agentId ? { createdByAgentId: actor.agentId } : {}),
      ...(actor.sessionName ? { createdBySessionName: actor.sessionName } : {}),
    });
    let attached;
    try {
      attached = attachTaskToWorkflowNodeRun(runId, nodeKey, created.task.id);
    } catch (error) {
      dbDeleteTask(created.task.id);
      rmSync(getCanonicalTaskDir(created.task.id), { recursive: true, force: true });
      rethrowWorkflowCommandError("workflows runs task-create", error, asJson);
    }
    await emitCreatedTask(created);
    let launch: Awaited<ReturnType<typeof queueOrDispatchTask>> | null = null;
    if (agentId?.trim()) {
      launch = await queueOrDispatchTask(created.task.id, {
        agentId: agentId.trim(),
        sessionName: sessionName?.trim() || getDefaultTaskSessionNameForTask(created.task),
        assignedBy: actor.actor,
        ...(actor.agentId ? { assignedByAgentId: actor.agentId } : {}),
        ...(actor.sessionName ? { assignedBySessionName: actor.sessionName } : {}),
      });
      await emitDispatchResult(launch);
    }

    const workflow = launch ? getWorkflowRunDetails(runId) : attached.details;
    const payload = {
      task: created.task,
      workflow,
      ...(launch ? { launch } : {}),
    };

    if (asJson) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(`\n✓ Created task ${created.task.id} for workflow node ${nodeKey}`);
      if (launch) {
        console.log(`  Launch: ${launch.mode === "dispatched" ? "dispatched" : "launch planned"}`);
      }
      printWorkflowRun(getWorkflowRunDetails(runId)!);
    }
    return payload;
  }
}
