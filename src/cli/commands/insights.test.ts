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

let insightsListMock: Array<Record<string, unknown>> = [];
let searchResultsMock: Array<Record<string, unknown>> = [];

mock.module("../context.js", () => ({
  ...actualCliContextModule,
  getContext: () => runtimeContext,
  // Real hasContext checks RAVI_* envs; the contract helpers use it to throw
  // ContractError instead of process.exit, which is what tests need.
  hasContext: () => true,
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
    return insightsListMock;
  },
  dbGetInsight: () => null,
  dbSearchInsights: () => searchResultsMock,
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
const { ContractError } = await import("../agent-contract.js");

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

describe("insights agent-first contract", () => {
  const fullInsight = (id: string): Record<string, unknown> => ({
    id,
    kind: "pattern",
    confidence: "high",
    importance: "high",
    summary: "Sempre linkar o artifact da task.",
    detail: null,
    author: { name: "dev" },
    origin: { kind: "manual" },
    createdAt: 1,
    updatedAt: 2,
    links: [],
    comments: [],
  });

  beforeEach(() => {
    createCalls.length = 0;
    listCalls.length = 0;
    tagAttachCalls.length = 0;
    insightsListMock = [];
    searchResultsMock = [];
  });

  function expectContractError(run: () => unknown): InstanceType<typeof ContractError> {
    const originalLog = console.log;
    console.log = () => {};
    let thrown: unknown;
    try {
      run();
    } catch (error) {
      thrown = error;
    } finally {
      console.log = originalLog;
    }
    expect(thrown).toBeInstanceOf(ContractError);
    return thrown as InstanceType<typeof ContractError>;
  }

  it("emits INSIGHT_NOT_FOUND envelope with suggestions on show --json (exit 1)", () => {
    insightsListMock = [fullInsight("ins-123"), fullInsight("ins-456")];
    const error = expectContractError(() => new InsightCommands().show("ins-999", true));
    expect(error.exitCode).toBe(1);
    const envelope = error.envelope();
    expect(envelope.success).toBe(false);
    expect(envelope.op).toBe("insights show");
    expect(envelope.error.code).toBe("INSIGHT_NOT_FOUND");
    expect(envelope.error.suggestions).toContain("ins-123");
    expect((envelope.error.suggestions as string[]).length).toBeLessThanOrEqual(3);
  });

  it("emits USAGE_ERROR with acceptedValues on invalid --kind for list (exit 2)", () => {
    const error = expectContractError(() =>
      new InsightCommands().list(
        "bogus",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "10",
        true,
      ),
    );
    expect(error.exitCode).toBe(2);
    const envelope = error.envelope();
    expect(envelope.op).toBe("insights list");
    expect(envelope.error.code).toBe("USAGE_ERROR");
    expect(envelope.error.acceptedValues).toContain("observation");
  });

  it("emits USAGE_ERROR on invalid --kind for create (exit 2) and creates nothing", () => {
    const error = expectContractError(() =>
      new InsightCommands().create(
        "Resumo qualquer.",
        undefined,
        "bogus",
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
      ),
    );
    expect(error.exitCode).toBe(2);
    expect(error.envelope().error.code).toBe("USAGE_ERROR");
    expect(createCalls).toHaveLength(0);
  });

  it("emits USAGE_ERROR on invalid --limit for list (exit 2)", () => {
    const error = expectContractError(() =>
      new InsightCommands().list(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "0",
        true,
      ),
    );
    expect(error.exitCode).toBe(2);
    expect(error.envelope().error.code).toBe("USAGE_ERROR");
  });

  it("supports --fields compact mode on insights list", () => {
    insightsListMock = [fullInsight("ins-123")];
    const originalLog = console.log;
    console.log = () => {};
    let payload: { items: Array<Record<string, unknown>>; insights: Array<Record<string, unknown>> };
    try {
      payload = new InsightCommands().list(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "10",
        true,
        undefined,
        undefined,
        "id,kind",
      ) as unknown as typeof payload;
    } finally {
      console.log = originalLog;
    }
    expect(payload.items).toHaveLength(1);
    expect(Object.keys(payload.items[0] ?? {}).sort()).toEqual(["id", "kind"]);
    expect(payload.insights).toEqual(payload.items);
  });

  it("supports --fields compact mode on insights search", () => {
    searchResultsMock = [fullInsight("ins-123")];
    const originalLog = console.log;
    console.log = () => {};
    let payload: { insights: Array<Record<string, unknown>> };
    try {
      payload = new InsightCommands().search("linkar", "10", true, "id,summary") as unknown as typeof payload;
    } finally {
      console.log = originalLog;
    }
    expect(payload.insights).toHaveLength(1);
    expect(Object.keys(payload.insights[0] ?? {}).sort()).toEqual(["id", "summary"]);
  });

  it("keeps create unbraked: writes immediately without any --execute flag", () => {
    const originalLog = console.log;
    console.log = () => {};
    try {
      new InsightCommands().create("Escrita local reversível é imediata.");
    } finally {
      console.log = originalLog;
    }
    expect(createCalls).toHaveLength(1);
  });
});
