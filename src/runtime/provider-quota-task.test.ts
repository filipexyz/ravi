import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { createTask, getTaskDetails } from "../tasks/service.js";
import { blockTaskForProviderQuota } from "./provider-quota-task.js";

describe("provider quota task convergence", () => {
  let stateDir: string | null = null;

  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-provider-quota-task-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("persists a blocked task so checkpoint reminders stop instead of looping as success", async () => {
    const created = createTask({
      title: "Quota-bound curator",
      instructions: "Test provider quota convergence",
      createdBy: "test",
      profileInput: {
        goal: "Prove quota convergence",
        success_criteria: "Task becomes blocked",
        consumer: "test",
      },
    });
    const blocked = await blockTaskForProviderQuota({
      taskId: created.task.id,
      agentId: "ravi-dev",
      sessionName: `${created.task.id}-curator`,
      error: "You've hit your weekly limit · resets Jul 15, 2am (UTC)",
      emitEvents: false,
    });

    const task = getTaskDetails(created.task.id).task;
    if (!task) throw new Error("Expected quota-bound task to remain queryable after blocking");
    expect(blocked).toBe(true);
    expect(task.status).toBe("blocked");
    expect(task.blockerReason).toContain("weekly limit");
  });
});
