import "reflect-metadata";
import { Arg, Command, Group, Option } from "../decorators.js";
import { fail } from "../context.js";
import {
  addTaskDependency,
  emitTaskEvent,
  getTaskDependencySurface,
  getTaskDetails,
  removeTaskDependency,
} from "../../tasks/index.js";

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

function formatStatus(status: string): string {
  switch (status) {
    case "waiting":
      return "waiting";
    case "dispatched":
      return "queued";
    case "in_progress":
      return "working";
    default:
      return status;
  }
}

async function emitMutation(result: {
  task: { id: string };
  event: { type: string };
  relatedEvents?: Array<{ task: { id: string }; event: { type: string } }>;
  wasNoop?: boolean;
}) {
  if (result.wasNoop) {
    return;
  }
  await emitTaskEvent(result.task as never, result.event as never);
  for (const related of result.relatedEvents ?? []) {
    await emitTaskEvent(related.task as never, related.event as never);
  }
}

@Group({
  name: "tasks.deps",
  description: "Inspect and mutate task dependency gating",
  scope: "open",
})
export class TaskDependencyCommands {
  @Command({ name: "add", description: "Add one gating dependency to a task" })
  async add(
    @Arg("taskId", { description: "Downstream task id" }) taskId: string,
    @Arg("dependencyTaskId", { description: "Upstream task id that must reach done" }) dependencyTaskId: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const result = await addTaskDependency(taskId, dependencyTaskId);
    await emitMutation(result);

    if (asJson) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    const verb = result.wasNoop ? "already present" : "added";
    console.log(`\n✓ Dependency ${verb}: ${taskId} -> ${dependencyTaskId}`);
    console.log(`  Readiness: ${result.readiness.label}`);
    if (result.readiness.hasLaunchPlan) {
      console.log("  Launch plan remains armed; task will auto-dispatch when ready.");
    }
  }

  @Command({ name: "rm", description: "Remove one gating dependency from a task", aliases: ["remove"] })
  async rm(
    @Arg("taskId", { description: "Downstream task id" }) taskId: string,
    @Arg("dependencyTaskId", { description: "Upstream task id to remove from gating" }) dependencyTaskId: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const result = await removeTaskDependency(taskId, dependencyTaskId);
    await emitMutation(result);

    if (asJson) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    const verb = result.wasNoop ? "already absent" : "removed";
    console.log(`\n✓ Dependency ${verb}: ${taskId} -> ${dependencyTaskId}`);
    console.log(`  Readiness: ${result.readiness.label}`);
    if (result.readiness.hasLaunchPlan) {
      console.log("  Launch plan remains armed.");
    }
  }

  @Command({ name: "ls", description: "List gating dependencies and dependents for a task", aliases: ["list"] })
  ls(
    @Arg("taskId", { description: "Task id to inspect" }) taskId: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const details = getTaskDetails(taskId);
    if (!details.task) {
      fail(`Task not found: ${taskId}`);
    }

    const dependencySurface = getTaskDependencySurface(details.task, details.activeAssignment);
    if (asJson) {
      console.log(
        JSON.stringify(
          {
            taskId,
            readiness: dependencySurface.readiness,
            launchPlan: dependencySurface.launchPlan,
            dependencies: dependencySurface.dependencies,
            dependents: dependencySurface.dependents,
          },
          null,
          2,
        ),
      );
      return;
    }

    console.log(`\nTask deps:   ${taskId}`);
    console.log(`Readiness:   ${dependencySurface.readiness.label}`);
    console.log(
      `Launch plan: ${dependencySurface.launchPlan ? `${dependencySurface.launchPlan.agentId}/${dependencySurface.launchPlan.sessionName}` : "-"}`,
    );

    console.log("\nDependencies:");
    if (dependencySurface.dependencies.length === 0) {
      console.log("  - none");
    } else {
      for (const dependency of dependencySurface.dependencies) {
        const satisfaction = dependency.satisfied ? `done @ ${formatTime(dependency.satisfiedAt)}` : "pending";
        console.log(
          `  - ${dependency.relatedTaskId} :: ${formatStatus(dependency.relatedTaskStatus)} :: ${dependency.relatedTaskProgress}% :: ${satisfaction} :: ${dependency.relatedTaskTitle}`,
        );
      }
    }

    console.log("\nDependents:");
    if (dependencySurface.dependents.length === 0) {
      console.log("  - none");
    } else {
      for (const dependent of dependencySurface.dependents) {
        const satisfaction = dependent.satisfied ? `done @ ${formatTime(dependent.satisfiedAt)}` : "pending";
        console.log(
          `  - ${dependent.relatedTaskId} :: ${formatStatus(dependent.relatedTaskStatus)} :: ${dependent.relatedTaskProgress}% :: ${satisfaction} :: ${dependent.relatedTaskTitle}`,
        );
      }
    }

    if (dependencySurface.dependencies.length === 0 && dependencySurface.dependents.length === 0) {
      console.log("\nExamples:");
      console.log(`  ravi tasks deps add ${taskId} <upstream-task>`);
      console.log(`  ravi tasks create "Blocked work" --instructions "..." --depends-on ${taskId}`);
    }
  }
}
