import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { runWithContext } from "../context.js";
import { ContractError } from "../agent-contract.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { dbCreateTask, dbDispatchTask } from "../../tasks/task-db.js";
import { listDecisions } from "../../decisions/store.js";
import { getDb } from "../../router/router-db.js";

mock.module("../../nats.js", () => ({
  nats: { emit: async () => {} },
  ensureConnected: async () => {},
  getNats: () => {},
  isExplicitConnect: () => false,
}));
const { DecisionsCommands, decisionSchema } = await import("./decisions.js");
afterAll(() => mock.restore());
let state: string | null = null;
beforeEach(async () => {
  state = await createIsolatedRaviState("ravi-decision-cli-");
});
afterEach(async () => {
  await cleanupIsolatedRaviState(state);
  state = null;
});
const command = new DecisionsCommands();

describe("decisions CLI contract", () => {
  it("normalizes keys, records actor provenance, returns a concrete shape and refuses a second answer", async () => {
    const { task } = dbCreateTask({ title: "fixture", instructions: "test" });
    await runWithContext({ suppressCliOutput: true }, async () => {
      const result = await command.ask(
        task.id,
        undefined,
        "Window",
        "Which window?",
        "human:contact-fixture",
        true,
        true,
      );
      expect(decisionSchema.parse(result.decision).origin).toEqual({
        type: "task",
        id: task.id,
        chatId: null,
        sessionKey: null,
      });
      expect(result.decision.key).toBe("window");
      const answered = await command.answer(result.decision.id, "After 18h", "Display label", true);
      expect(answered.decision.answeredBy).toBe("operator (for Display label)");
      expect(answered.deliveries).toEqual([]);
      await expect(command.answer(result.decision.id, "Replace", undefined, true)).rejects.toMatchObject({
        code: "DECISION_NOT_OPEN",
        exitCode: 1,
      });
      const shown = await command.show(result.decision.id, true);
      expect(shown.history).toHaveLength(2);
    });
  });
  it("rejects invalid selectors, keys, owners and empty answers before writing", async () => {
    const { task } = dbCreateTask({ title: "fixture", instructions: "test" });
    await runWithContext({ suppressCliOutput: true }, async () => {
      await expect(command.ask(task.id, undefined, "bad key", "Question")).rejects.toMatchObject({ exitCode: 2 });
      await expect(command.ask(task.id, undefined, "k", "Question", "robot:1")).rejects.toMatchObject({ exitCode: 2 });
      await expect(command.ask(task.id, "thread", "k", "Question")).rejects.toMatchObject({ exitCode: 2 });
      await expect(command.answer("missing", " ")).rejects.toMatchObject({ exitCode: 2 });
      expect(listDecisions()).toEqual([]);
    });
  });
  it("bounds list output and keeps filters in the next command", async () => {
    const { task } = dbCreateTask({ title: "fixture", instructions: "test" });
    await runWithContext({ suppressCliOutput: true }, async () => {
      await command.ask(task.id, undefined, "a", "A?");
      await command.ask(task.id, undefined, "b", "B?");
      const page = await command.list(task.id, undefined, false, true, "1", "0");
      expect(page.decisions).toHaveLength(1);
      expect(page.pagination).toMatchObject({ total: 2, hasMore: true, nextOffset: 1 });
      expect(page.pagination.nextCommand).toContain(task.id);
    });
  });
  it("binds self-answer to the current session regardless of --by", async () => {
    const { task } = dbCreateTask({ title: "fixture", instructions: "test" });
    dbDispatchTask(task.id, { agentId: "main", sessionName: "worker" });
    await runWithContext({ suppressCliOutput: true, sessionName: "worker" }, async () => {
      const result = await command.ask(task.id, undefined, "k", "Question");
      await expect(command.answer(result.decision.id, "Yes", "human:owner", true)).rejects.toMatchObject({
        code: "DECISION_SELF_ANSWER",
      });
    });
  });
  it("validates thread identity and authority before its execute brake; preview has no decision/history/outbox writes", async () => {
    const { getOrCreateSession } = await import("../../router/index.js");
    const { dbUpsertChat } = await import("../../router/router-db.js");
    const { createSlackThreadLifecycle, markSlackThreadRootDelivered } = await import(
      "../../channels/slack/thread-lifecycle-store.js"
    );
    const { finalizeSlackThreadCreation } = await import("../../channels/slack/thread-lifecycle.js");
    getOrCreateSession("parent", "main", state!, { name: "parent" });
    const root = dbUpsertChat({ channel: "slack", instanceId: "fixture", platformChatId: "C123", chatType: "channel" });
    createSlackThreadLifecycle({
      requestId: "fixture",
      parentSessionKey: "parent",
      parentSessionName: "parent",
      accountId: "fixture",
      instanceId: "fixture",
      platformChatId: "C123",
      rootCanonicalChatId: root.id,
      initialPrompt: "Fixture",
    });
    markSlackThreadRootDelivered({ requestId: "fixture", providerThreadId: "1713000000.000123" });
    const child = await finalizeSlackThreadCreation("fixture", {
      publishPrompt: async () => {},
      publishEvent: async () => {},
    });
    await runWithContext({ suppressCliOutput: true }, async () => {
      await expect(command.ask(undefined, "missing", "k", "Question")).rejects.toMatchObject({
        code: "DECISION_NOT_FOUND",
        exitCode: 1,
      });
      let error: unknown;
      try {
        await command.ask(undefined, child.childSessionName, "k", "Question", undefined, false, true);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(ContractError);
      expect((error as ContractError).exitCode).toBe(3);
      for (const table of ["decisions", "decision_history", "decision_deliveries"]) {
        expect(getDb().query(`SELECT * FROM ${table}`).all()).toEqual([]);
      }
    });
  });
});
