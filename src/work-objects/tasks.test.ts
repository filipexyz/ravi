import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { dbCreateTask, dbDeleteTask, getTaskDetails } from "../tasks/index.js";
import {
  createWorkObjectRequestContext,
  executeWorkObjectAction,
  resolveWorkObject,
  suggestWorkObjectOptions,
  updateWorkObject,
} from "./index.js";

const createdTaskIds: string[] = [];
let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-work-objects-test-");
});

afterEach(async () => {
  while (createdTaskIds.length > 0) {
    const id = createdTaskIds.pop();
    if (id) dbDeleteTask(id);
  }
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

function createTestTask(title = "Work Object task") {
  const result = dbCreateTask({
    title,
    instructions: `Instructions for ${title}`,
    priority: "high",
    createdBy: "test",
  });
  createdTaskIds.push(result.task.id);
  return result.task;
}

function testContext() {
  return createWorkObjectRequestContext({
    instanceId: "test-instance",
    channel: { channel: "test", instanceId: "test-instance" },
    actor: { id: "actor-1", displayName: "Test Actor" },
    metadata: { agentId: "dev", sessionName: "dev-session" },
  });
}

describe("task Work Objects", () => {
  it("resolves a task by external ref and URL", async () => {
    const task = createTestTask("Resolve me");
    const byRef = await resolveWorkObject({ externalRef: { type: "task", id: task.id } }, testContext());
    const byUrl = await resolveWorkObject({ url: `https://example.test/work-objects/task/${task.id}` }, testContext());

    expect(byRef?.providerId).toBe("task");
    expect(byRef?.result.title).toBe("Resolve me");
    expect(byRef?.result.externalRef).toEqual({ type: "task", id: task.id });
    expect(byRef?.result.entityType).toBe("task");
    expect(byUrl?.result.externalRef.id).toBe(task.id);
  });

  it("executes a comment action through the task adapter", async () => {
    const task = createTestTask("Comment me");
    const result = await executeWorkObjectAction(
      { type: "task", id: task.id },
      { actionId: "task.comment", value: "Looks good from a Work Object." },
      testContext(),
    );

    expect(result?.providerId).toBe("task");
    expect(result?.result.message).toBe("Comment added.");
    const details = getTaskDetails(task.id);
    expect(details.comments[0]?.body).toBe("Looks good from a Work Object.");
    expect(details.comments[0]?.author).toBe("Test Actor");
  });

  it("returns field errors for invalid or incomplete updates", async () => {
    const task = createTestTask("Validate me");
    const invalidPriority = await updateWorkObject(
      { type: "task", id: task.id },
      { values: { priority: "critical" } },
      testContext(),
    );
    const incomplete = await updateWorkObject(
      { type: "task", id: task.id },
      { values: { status: "blocked" } },
      testContext(),
    );

    expect(invalidPriority?.result.fieldErrors?.priority).toContain("low, normal, high, urgent");
    expect(incomplete?.result.fieldErrors?.status).toContain("requires blockerReason");
  });

  it("does not apply partial mutations when an update has field errors", async () => {
    const task = createTestTask("Atomic update");
    const result = await updateWorkObject(
      { type: "task", id: task.id },
      { values: { comment: "This should not persist.", priority: "critical" } },
      testContext(),
    );

    expect(result?.result.fieldErrors?.priority).toContain("low, normal, high, urgent");
    expect(getTaskDetails(task.id).comments).toHaveLength(0);
  });

  it("preserves the source URL when resolving a task from an HTTP URL", async () => {
    const task = createTestTask("Source URL");
    const url = `https://example.test/work-objects/task/${task.id}`;
    const result = await resolveWorkObject({ url }, testContext());

    expect(result?.result.url).toBe(url);
  });

  it("updates task status when required fields are present", async () => {
    const task = createTestTask("Block me");
    const result = await updateWorkObject(
      { type: "task", id: task.id },
      { values: { status: "blocked", blockerReason: "Waiting on an external API." } },
      testContext(),
    );

    expect(result?.result.object?.status).toBe("blocked");
    expect(getTaskDetails(task.id).task?.blockerReason).toBe("Waiting on an external API.");
  });

  it("updates editable task fields through the task runtime", async () => {
    const task = createTestTask("Edit me");
    const result = await updateWorkObject(
      { type: "task", id: task.id },
      { values: { priority: "urgent", description: "Updated task instructions." } },
      testContext(),
    );
    const details = getTaskDetails(task.id);

    expect(result?.result.object?.fields?.priority?.value).toBe("urgent");
    expect(result?.result.object?.fields?.description?.value).toBe("Updated task instructions.");
    expect(details.task?.priority).toBe("urgent");
    expect(details.task?.instructions).toBe("Updated task instructions.");
    expect(details.events.at(-1)?.type).toBe("task.updated");
  });

  it("exposes Slack task-friendly fields and safe actions", async () => {
    const task = createTestTask("Render me");
    const result = await resolveWorkObject({ externalRef: { type: "task", id: task.id } }, testContext());
    const object = result?.result;

    expect(object?.entityType).toBe("task");
    expect(object?.fields?.status?.tag_color).toBe("gray");
    expect(object?.fields?.priority?.edit?.type).toBe("select");
    expect(object?.fields?.description?.edit?.type).toBe("text");
    expect(object?.fields?.date_created?.type).toBe("timestamp");
    expect(object?.actions?.primaryActions?.map((action) => action.actionId)).toEqual(["task.done", "task.open"]);
  });

  it("suggests task field options", async () => {
    const task = createTestTask("Suggest me");
    const statuses = await suggestWorkObjectOptions(
      { type: "task", id: task.id },
      { fieldId: "status" },
      testContext(),
    );
    const priorities = await suggestWorkObjectOptions(
      { type: "task", id: task.id },
      { fieldId: "priority", query: "ur" },
      testContext(),
    );

    expect(statuses?.result.map((option) => option.value)).toContain("done");
    expect(priorities?.result).toEqual([{ text: "Urgent", value: "urgent" }]);
  });
});
