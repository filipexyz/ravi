import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import {
  dbAddTaskDependency,
  dbArchiveTask,
  dbCompleteTask,
  dbCreateTask,
  dbDeleteTask,
  dbDispatchTask,
  dbFailTask,
  dbListTaskDependencies,
} from "../tasks/index.js";
import { addTaskToWorkflow, createWorkflow, getWorkflowDetails, removeTaskFromWorkflow } from "./index.js";

const createdTaskIds: string[] = [];
let stateDir: string | null = null;

setDefaultTimeout(20_000);

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-workflow-substrate-test-");
});

afterEach(async () => {
  while (createdTaskIds.length > 0) {
    const id = createdTaskIds.pop();
    if (id) {
      dbDeleteTask(id);
    }
  }
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

function createTask(title: string) {
  const created = dbCreateTask({
    title,
    instructions: `Implement ${title}`,
    createdBy: "test",
  });
  createdTaskIds.push(created.task.id);
  return created.task;
}

describe("workflow substrate v0", () => {
  it("enforces one active workflow per task but allows moving after rm-task", () => {
    const task = createTask("Single workflow membership");
    const first = createWorkflow({ title: "First workflow", createdBy: "test" });
    const second = createWorkflow({ title: "Second workflow", createdBy: "test" });

    addTaskToWorkflow(first.workflow.id, task.id, { actor: "test" });

    expect(() => addTaskToWorkflow(second.workflow.id, task.id, { actor: "test" })).toThrow(
      `Task ${task.id} already belongs to workflow ${first.workflow.id}.`,
    );

    removeTaskFromWorkflow(first.workflow.id, task.id, { actor: "test" });
    const moved = addTaskToWorkflow(second.workflow.id, task.id, { actor: "test" });

    expect(moved.snapshot.members.map((member) => member.taskId)).toEqual([task.id]);

    const previousWorkflow = getWorkflowDetails(first.workflow.id)!;
    expect(previousWorkflow.status).toBe("draft");
    expect(previousWorkflow.members).toEqual([]);
    expect(previousWorkflow.history).toEqual([
      expect.objectContaining({
        taskId: task.id,
        historyState: "removed",
      }),
    ]);
  });

  it("derives internal edges from task_dependencies and turns removed upstreams into external prerequisites", () => {
    const upstream = createTask("Upstream");
    const downstream = createTask("Downstream");
    dbAddTaskDependency(downstream.id, upstream.id);

    const workflow = createWorkflow({ title: "Dependency workflow", createdBy: "test" });
    addTaskToWorkflow(workflow.workflow.id, upstream.id, { actor: "test" });
    addTaskToWorkflow(workflow.workflow.id, downstream.id, { actor: "test" });

    const initial = getWorkflowDetails(workflow.workflow.id)!;
    expect(initial.edges).toEqual([
      {
        fromTaskId: upstream.id,
        toTaskId: downstream.id,
      },
    ]);
    expect(initial.externalPrerequisites).toEqual([]);
    expect(initial.members.find((member) => member.taskId === downstream.id)?.internalUpstreamTaskIds).toEqual([
      upstream.id,
    ]);

    removeTaskFromWorkflow(workflow.workflow.id, upstream.id, { actor: "test" });

    const afterRemoval = getWorkflowDetails(workflow.workflow.id)!;
    expect(afterRemoval.edges).toEqual([]);
    expect(afterRemoval.members.find((member) => member.taskId === downstream.id)?.externalUpstreamTaskIds).toEqual([
      upstream.id,
    ]);
    expect(afterRemoval.externalPrerequisites).toEqual([
      expect.objectContaining({
        taskId: downstream.id,
        dependsOnTaskId: upstream.id,
      }),
    ]);
    expect(dbListTaskDependencies(downstream.id).map((dependency) => dependency.dependsOnTaskId)).toEqual([
      upstream.id,
    ]);
  });

  it("computes draft when only archived members remain and keeps them in history", () => {
    const task = createTask("Archived member");
    const workflow = createWorkflow({ title: "Archive semantics", createdBy: "test" });
    addTaskToWorkflow(workflow.workflow.id, task.id, { actor: "test" });

    expect(getWorkflowDetails(workflow.workflow.id)?.status).toBe("ready");

    dbArchiveTask(task.id, {
      actor: "test",
      reason: "remove from active aggregate",
    });

    const snapshot = getWorkflowDetails(workflow.workflow.id)!;
    expect(snapshot.status).toBe("draft");
    expect(snapshot.aggregate.memberCount).toBe(0);
    expect(snapshot.aggregate.historyCount).toBe(1);
    expect(snapshot.history).toEqual([
      expect.objectContaining({
        taskId: task.id,
        historyState: "archived",
      }),
    ]);
  });

  it("computes ready, running, done, and failed from active members only", () => {
    const readyTask = createTask("Ready member");
    const workflow = createWorkflow({ title: "Aggregate status", createdBy: "test" });
    addTaskToWorkflow(workflow.workflow.id, readyTask.id, { actor: "test" });

    expect(getWorkflowDetails(workflow.workflow.id)?.status).toBe("ready");

    dbDispatchTask(readyTask.id, {
      agentId: "dev",
      sessionName: `${readyTask.id}-work`,
      assignedBy: "test",
    });
    expect(getWorkflowDetails(workflow.workflow.id)?.status).toBe("running");

    dbCompleteTask(readyTask.id, {
      actor: "test",
      message: "finished",
    });
    expect(getWorkflowDetails(workflow.workflow.id)?.status).toBe("done");

    const failedTask = createTask("Failed member");
    const failedWorkflow = createWorkflow({ title: "Failure aggregate", createdBy: "test" });
    addTaskToWorkflow(failedWorkflow.workflow.id, failedTask.id, { actor: "test" });
    dbFailTask(failedTask.id, {
      actor: "test",
      message: "boom",
    });
    expect(getWorkflowDetails(failedWorkflow.workflow.id)?.status).toBe("failed");
  });
});
