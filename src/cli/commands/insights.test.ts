import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";

afterAll(() => mock.restore());

const actualCliContextModule = await import("../context.js");
const createCalls: Array<Record<string, unknown>> = [];

const runtimeContext = {
  contextId: "ctx_123",
  context: { kind: "cli-runtime" },
  agentId: "dev",
  sessionKey: "agent:dev:main",
  sessionName: "task-8a0dc2ed-work",
  source: {
    channel: "whatsapp",
    accountId: "main",
    chatId: "5511999999999",
  },
};

mock.module("../decorators.js", () => ({
  Group: () => () => {},
  Command: () => () => {},
  Arg: () => () => {},
  Option: () => () => {},
}));

mock.module("../context.js", () => ({
  ...actualCliContextModule,
  getContext: () => runtimeContext,
  fail: (message: string) => {
    throw new Error(message);
  },
}));

mock.module("../../insights/index.js", () => ({
  dbCreateInsight: (input: Record<string, unknown>) => {
    createCalls.push(input);
    return {
      id: "ins-123",
      kind: input.kind ?? "observation",
      summary: input.summary,
      detail: input.detail,
      confidence: input.confidence ?? "medium",
      importance: input.importance ?? "normal",
      author: input.author,
      origin: input.origin,
      createdAt: 1,
      updatedAt: 1,
      links: input.links ?? [],
      comments: [],
    };
  },
  dbListInsights: () => [],
  dbGetInsight: () => null,
  dbSearchInsights: () => [],
  dbUpsertInsightLink: () => ({}),
  dbAddInsightComment: () => ({}),
}));

const { InsightCommands } = await import("./insights.js");

describe("InsightCommands create", () => {
  beforeEach(() => {
    createCalls.length = 0;
  });

  it("captures runtime context for author/origin and auto-links the current session and agent", () => {
    new InsightCommands().create(
      "Always link the task artifact when the insight came from active task work.",
      undefined,
      "pattern",
      "high",
      "high",
      "task-8a0dc2ed",
      undefined,
      undefined,
      "/tmp/TASK.md",
      undefined,
      undefined,
      undefined,
      undefined,
      true,
    );

    const input = createCalls[0] as {
      author: Record<string, unknown>;
      origin: Record<string, unknown>;
      links: Array<{ targetType: string; targetId: string }>;
    };

    expect(input.author.agentId).toBe("dev");
    expect(input.author.sessionName).toBe("task-8a0dc2ed-work");
    expect(input.origin.kind).toBe("runtime-context");
    expect(input.origin.contextId).toBe("ctx_123");
    expect(input.links).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ targetType: "task", targetId: "task-8a0dc2ed" }),
        expect.objectContaining({ targetType: "artifact", targetId: "/tmp/TASK.md" }),
        expect.objectContaining({ targetType: "session", targetId: "task-8a0dc2ed-work" }),
        expect.objectContaining({ targetType: "agent", targetId: "dev" }),
      ]),
    );
  });
});
