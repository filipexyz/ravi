import "reflect-metadata";
import { readFileSync, rmSync } from "node:fs";
import { Arg, Command, Group, Option } from "../decorators.js";
import { fail } from "../context.js";
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

@Group({
  name: "workflows.specs",
  description: "Workflow substrate specs",
  scope: "open",
})
export class WorkflowSpecCommands {
  @Command({ name: "create", description: "Create one workflow spec from narrow JSON definition" })
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
  list(@Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean) {
    const specs = listWorkflowSpecs();
    if (asJson) {
      console.log(JSON.stringify(specs, null, 2));
    } else if (specs.length === 0) {
      console.log("No workflow specs found.");
    } else {
      console.log("");
      for (const spec of specs) {
        console.log(`${spec.id} :: ${spec.title} :: ${spec.nodes.length} nodes :: ${spec.edges.length} edges`);
      }
    }
    return specs;
  }

  @Command({ name: "show", description: "Show one workflow spec" })
  show(
    @Arg("specId", { description: "Workflow spec id" }) specId: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const spec = getWorkflowSpec(specId);
    if (!spec) {
      fail(`Workflow spec not found: ${specId}`);
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
  start(
    @Arg("specId", { description: "Workflow spec id" }) specId: string,
    @Option({ flags: "--run-id <id>", description: "Optional workflow run id" }) runId?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
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
  }

  @Command({ name: "list", description: "List workflow runs" })
  list(@Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean) {
    const runs = listWorkflowRuns();
    if (asJson) {
      console.log(JSON.stringify(runs, null, 2));
    } else if (runs.length === 0) {
      console.log("No workflow runs found.");
    } else {
      console.log("");
      for (const run of runs) {
        console.log(`${run.id} :: ${run.status} :: ${run.workflowSpecId} :: ${run.title}`);
      }
    }
    return runs;
  }

  @Command({ name: "show", description: "Show one workflow run with node state" })
  show(
    @Arg("runId", { description: "Workflow run id" }) runId: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const details = getWorkflowRunDetails(runId);
    if (!details) {
      fail(`Workflow run not found: ${runId}`);
    }

    if (asJson) {
      console.log(JSON.stringify(details, null, 2));
    } else {
      printWorkflowRun(details);
    }
    return details;
  }

  @Command({ name: "release", description: "Release a manual node transition or gate" })
  release(
    @Arg("runId", { description: "Workflow run id" }) runId: string,
    @Arg("nodeKey", { description: "Node key" }) nodeKey: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const actor = getTaskActor();
    const result = releaseWorkflowNodeRun(runId, nodeKey, actor);
    if (asJson) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`\n✓ Released ${nodeKey} in ${runId}`);
      printWorkflowRun(result.details);
    }
    return result;
  }

  @Command({ name: "skip", description: "Skip one optional workflow node" })
  skip(
    @Arg("runId", { description: "Workflow run id" }) runId: string,
    @Arg("nodeKey", { description: "Node key" }) nodeKey: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const result = skipWorkflowNodeRun(runId, nodeKey);
    if (asJson) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`\n✓ Skipped optional node ${nodeKey} in ${runId}`);
      printWorkflowRun(result.details);
    }
    return result;
  }

  @Command({ name: "cancel", description: "Cancel one workflow node run" })
  cancel(
    @Arg("runId", { description: "Workflow run id" }) runId: string,
    @Arg("nodeKey", { description: "Node key" }) nodeKey: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const result = cancelWorkflowNodeRun(runId, nodeKey);
    if (asJson) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`\n✓ Cancelled node ${nodeKey} in ${runId}`);
      printWorkflowRun(result.details);
    }
    return result;
  }

  @Command({ name: "archive-node", description: "Archive one node run from workflow aggregate state" })
  archiveNode(
    @Arg("runId", { description: "Workflow run id" }) runId: string,
    @Arg("nodeKey", { description: "Node key" }) nodeKey: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const result = archiveWorkflowNodeRun(runId, nodeKey);
    if (asJson) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`\n✓ Archived node ${nodeKey} in ${runId}`);
      printWorkflowRun(result.details);
    }
    return result;
  }

  @Command({ name: "task-attach", description: "Attach an existing task to a workflow task node" })
  taskAttach(
    @Arg("runId", { description: "Workflow run id" }) runId: string,
    @Arg("nodeKey", { description: "Task node key" }) nodeKey: string,
    @Arg("taskId", { description: "Existing task id" }) taskId: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const result = attachTaskToWorkflowNodeRun(runId, nodeKey, taskId);
    if (asJson) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`\n✓ Attached task ${taskId} to ${nodeKey} in ${runId}`);
      printWorkflowRun(result.details);
    }
    return result;
  }

  @Command({ name: "task-create", description: "Create a new task attempt for one workflow task node" })
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
    try {
      assertCanAttachTaskToWorkflowNodeRun(runId, nodeKey);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
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
      fail(error instanceof Error ? error.message : String(error));
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
