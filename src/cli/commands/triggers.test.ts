import { beforeEach, describe, expect, it, mock } from "bun:test";

const createdTriggers: Array<Record<string, unknown>> = [];
const updatedTriggers: Array<{ id: string; patch: Record<string, unknown> }> = [];

mock.module("../decorators.js", () => ({
  Group: () => () => {},
  Command: () => () => {},
  Arg: () => () => {},
  Option: () => () => {},
}));

mock.module("../context.js", () => ({
  getContext: () => undefined,
  fail: (message: string) => {
    throw new Error(message);
  },
}));

mock.module("../../nats.js", () => ({
  nats: {
    emit: mock(async () => {}),
  },
}));

mock.module("../../permissions/scope.js", () => ({
  getScopeContext: () => undefined,
  isScopeEnforced: () => false,
  canAccessResource: () => true,
}));

mock.module("../../router/config.js", () => ({
  getAgent: () => ({ id: "agent-1" }),
}));

mock.module("../../router/router-db.js", () => ({
  getAccountForAgent: () => undefined,
}));

mock.module("../../cron/schedule.js", () => ({
  parseDurationMs: () => 5000,
  formatDurationMs: () => "5s",
}));

mock.module("../../triggers/index.js", () => ({
  dbCreateTrigger: (input: Record<string, unknown>) => {
    createdTriggers.push(input);
    return {
      id: "trg_1",
      name: input.name,
      topic: input.topic,
      cooldownMs: input.cooldownMs,
      session: input.session,
    };
  },
  dbGetTrigger: () => ({
    id: "trg_1",
    name: "trigger",
    topic: "ravi.external.topic",
    message: "hello",
    agentId: "agent-1",
    cooldownMs: 5000,
    enabled: true,
    session: "isolated",
    fireCount: 0,
    createdAt: Date.now(),
  }),
  dbListTriggers: () => [],
  dbUpdateTrigger: (id: string, patch: Record<string, unknown>) => {
    updatedTriggers.push({ id, patch });
  },
  dbDeleteTrigger: () => {},
}));

const { TriggersCommands } = await import("./triggers.js");

describe("TriggersCommands topic validation", () => {
  beforeEach(() => {
    createdTriggers.length = 0;
    updatedTriggers.length = 0;
  });

  it("rejects ravi.session topics on add", async () => {
    const commands = new TriggersCommands();

    await expect(commands.add("loop", "ravi.session.agent-main.prompt", "hello")).rejects.toThrow(
      "Triggers cannot subscribe",
    );

    expect(createdTriggers).toHaveLength(0);
  });

  it("rejects ravi.session topics on set", async () => {
    const commands = new TriggersCommands();

    await expect(commands.set("trg_1", "topic", "ravi.session.agent-main.runtime")).rejects.toThrow(
      "Triggers cannot subscribe",
    );

    expect(updatedTriggers).toHaveLength(0);
  });
});
