import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";

afterAll(() => mock.restore());

const actualCliContextModule = await import("../context.js");
const actualTagsModule = await import("../../tags/index.js");
const createCalls: Array<Record<string, unknown>> = [];
const listCalls: Array<Record<string, unknown>> = [];
const tagAttachCalls: Array<Record<string, unknown>> = [];

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
  CommandAccess: () => () => {},
  Scope: () => () => {},
  Returns: Object.assign(() => () => {}, { binary: () => () => {} }),
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
  dbListInsights: (query: Record<string, unknown>) => {
    listCalls.push(query);
    return [];
  },
  dbGetInsight: () => null,
  dbSearchInsights: () => [],
  dbUpsertInsightLink: () => ({}),
  dbAddInsightComment: () => ({}),
}));

mock.module("../../tags/index.js", () => ({
  ...actualTagsModule,
  attachTagSlugsToAsset: (input: { tags: string[] }) => {
    tagAttachCalls.push(input as unknown as Record<string, unknown>);
    return input.tags.map((tag) => ({ tagSlug: tag.trim().toLowerCase() }));
  },
  canonicalAssetIdsForTag: (assetType: string, tag?: string) =>
    assetType === "insight" && tag?.trim() ? ["ins-123"] : undefined,
  canonicalTagSlugsForAsset: () => ["needs.review"],
}));

const { InsightCommands } = await import("./insights.js");

describe("InsightCommands create", () => {
  beforeEach(() => {
    createCalls.length = 0;
    listCalls.length = 0;
    tagAttachCalls.length = 0;
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

  it("attaches canonical tags when creating insights", () => {
    new InsightCommands().create(
      "Tag the operational learning for later filtering.",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
      ["needs.review,ops.memory"],
    );

    expect(tagAttachCalls[0]).toMatchObject({
      assetType: "insight",
      assetId: "ins-123",
      tags: ["needs.review", "ops.memory"],
      source: "insights.cli",
      createdBy: "task-8a0dc2ed-work",
    });
  });

  it("filters insights through canonical tag asset ids", () => {
    new InsightCommands().list(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "needs.review",
      undefined,
      "10",
      true,
    );

    expect(listCalls[0]).toMatchObject({
      insightIds: ["ins-123"],
      limit: 10,
    });
  });
});
