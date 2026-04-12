import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

const publishCalls: Array<{ sessionName: string; payload: Record<string, unknown> }> = [];

mock.module("../omni/session-stream.js", () => ({
  publishSessionPrompt: mock(async (sessionName: string, payload: Record<string, unknown>) => {
    publishCalls.push({ sessionName, payload });
  }),
}));

const { commentTask, createTask, dbDeleteTask, dbDispatchTask } = await import("./index.js");

const createdTaskIds: string[] = [];

beforeEach(() => {
  publishCalls.length = 0;
});

afterEach(() => {
  while (createdTaskIds.length > 0) {
    const id = createdTaskIds.pop();
    if (id) dbDeleteTask(id);
  }
});

describe("task comments steering", () => {
  it("steers the active assignee session when a new comment lands on an active task", async () => {
    const created = createTask({
      title: "Comment steer smoke",
      instructions: "Use comments to steer active work",
      createdBy: "test",
    });
    createdTaskIds.push(created.task.id);

    dbDispatchTask(created.task.id, {
      agentId: "dev",
      sessionName: `${created.task.id}-work`,
      assignedBy: "test",
    });

    const result = await commentTask(created.task.id, {
      author: "operator",
      authorAgentId: "main",
      authorSessionName: "dev",
      body: "ajusta a direção do patch antes de continuar",
    });

    expect(result.steeredSessionName).toBe(`${created.task.id}-work`);
    expect(publishCalls).toHaveLength(1);
    expect(publishCalls[0]).toEqual({
      sessionName: `${created.task.id}-work`,
      payload: expect.objectContaining({
        deliveryBarrier: "after_response",
      }),
    });
    expect(String(publishCalls[0]?.payload.prompt)).toContain("Novo comentário na task");
    expect(String(publishCalls[0]?.payload.prompt)).toContain("ajusta a direção do patch antes de continuar");
  });

  it("keeps comment steering profile-first for runtime-only tasks", async () => {
    const created = createTask({
      title: "Runtime-only comment steer",
      instructions: "Do not leak TASK.md into the steer prompt",
      createdBy: "test",
      profileId: "task-doc-none",
    });
    createdTaskIds.push(created.task.id);

    dbDispatchTask(created.task.id, {
      agentId: "dev",
      sessionName: `${created.task.id}-work`,
      assignedBy: "test",
    });

    await commentTask(created.task.id, {
      author: "operator",
      authorAgentId: "main",
      authorSessionName: "dev",
      body: "sincroniza pelo runtime sem cair no legado doc-first",
    });

    expect(publishCalls).toHaveLength(1);
    expect(String(publishCalls[0]?.payload.prompt)).toContain("Profile: task-doc-none");
    expect(String(publishCalls[0]?.payload.prompt)).not.toContain("TASK.md");
  });
});
