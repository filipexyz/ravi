import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getOrCreateSession } from "../router/sessions.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { handleRuntimeGoalControl } from "./goal-control-host.js";
import { getSessionGoal, syncRuntimeSessionGoal } from "./session-goals.js";
import type { RuntimeHostStreamingSession } from "./host-session.js";
import type { RuntimeControlNatsRequest } from "./control-host.js";
import type { RuntimeControlRequest, RuntimeControlResult, RuntimeGoal, SessionRuntimeProvider } from "./types.js";

const key = "agent:dev:main";
const snapshot: RuntimeGoal = {
  objective: "Finish the fixture",
  status: "active",
  tokenBudget: 100,
  tokensUsed: 12,
  timeUsedSeconds: 3,
  createdAt: 1000,
  updatedAt: 2000,
};

describe("provider-neutral goal host", () => {
  let stateDir: string | null;
  let calls: string[];
  let reply: RuntimeControlResult;
  let supported: boolean;
  let providerResult: RuntimeControlResult;
  let storedResult: RuntimeControlResult | undefined;
  let streamingSessions: Map<string, RuntimeHostStreamingSession>;

  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-goal-host-");
    getOrCreateSession(key, "dev", "/tmp/dev", {
      name: "dev",
      runtimeProvider: "fixture-goals",
      providerSessionId: "thread_fixture",
      runtimeSessionParams: { cwd: "/tmp/dev", storage: "fixture-store" },
    });
    calls = [];
    supported = true;
    storedResult = undefined;
    streamingSessions = new Map();
    providerResult = { ok: true, operation: "goal.set", goal: snapshot, data: { changed: true } };
  });
  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
  });

  const control = async (request: RuntimeControlRequest) => {
    expect(request.threadId).toBe("thread_fixture");
    calls.push("control");
    return providerResult;
  };

  function live(active: boolean) {
    const session = {
      queryHandle: { provider: "fixture-goals", control },
      starting: false,
      turnActive: active,
    } as unknown as RuntimeHostStreamingSession;
    streamingSessions.set("dev", session);
    return session;
  }

  async function run(request: RuntimeControlRequest, extra: Partial<RuntimeControlNatsRequest> = {}) {
    await handleRuntimeGoalControl(
      { sessionName: "dev", replyTopic: "reply", request, ...extra },
      {
        streamingSessions,
        safeEmit: async (_topic, data) => {
          reply = data.result as RuntimeControlResult;
        },
        retireIdle: async () => {
          calls.push("retire");
          streamingSessions.delete("dev");
        },
        wake: async () => {
          expect(getSessionGoal(key)?.status).toBe("active");
          calls.push("wake");
        },
        providerFactory: () =>
          ({
            id: "fixture-goals",
            getCapabilities: () => ({
              runtimeControl: { supported, operations: supported ? ["goal.set", "goal.get", "goal.clear"] : [] },
              sessionState: { mode: "thread-id", requiresCwdMatch: true },
            }),
            controlSession: async (input, request) => {
              expect(input.sessionId).toBe("thread_fixture");
              expect(input.sessionParams?.storage).toBe("fixture-store");
              calls.push("stored");
              const result = await control(request);
              return storedResult ?? result;
            },
          }) as SessionRuntimeProvider,
      },
    );
    return reply;
  }

  it("sets the runtime goal before projecting status and waking a cold session", async () => {
    const result = await run(
      { operation: "goal.set", goal: { objective: snapshot.objective, status: "active" } },
      { goalMetadata: { taskId: "task_fixture" } },
    );
    expect(result.ok).toBe(true);
    expect(calls).toEqual(["stored", "control", "wake"]);
    expect(getSessionGoal(key)).toMatchObject({ ...snapshot, taskId: "task_fixture" });
  });

  it("unloads an idle runtime before activation and uses the managed input path", async () => {
    live(false);
    await run({ operation: "goal.set", goal: { status: "active" } });
    expect(calls).toEqual(["retire", "stored", "control", "wake"]);
  });

  it("updates an active runtime in place without an extra prompt or caller thread redirect", async () => {
    live(true);
    await run({ operation: "goal.set", threadId: "unrelated_thread", goal: { status: "active" } });
    expect(calls).toEqual(["control"]);
  });

  it("reads a cold snapshot without starting inference", async () => {
    providerResult = { ok: true, operation: "goal.get", goal: snapshot };
    await run({ operation: "goal.get" });
    expect(calls).toEqual(["stored", "control"]);
  });

  it("uses managed activation if the provider finished before the host observed completion", async () => {
    live(true);
    storedResult = providerResult;
    providerResult = {
      ok: false,
      operation: "goal.set",
      state: { provider: "fixture-goals", activeTurn: false },
      data: { execution: "requires_managed_wake" },
    };
    expect((await run({ operation: "goal.set", goal: { status: "active" } })).ok).toBe(true);
    expect(calls).toEqual(["control", "retire", "stored", "control", "wake"]);
  });

  it("preserves the previous projection when the runtime rejects a mutation", async () => {
    syncRuntimeSessionGoal(key, { ...snapshot, status: "blocked" });
    providerResult = { ok: false, operation: "goal.set", error: "fixture rejection" };
    expect((await run({ operation: "goal.set", goal: { status: "active" } })).ok).toBe(false);
    expect(getSessionGoal(key)?.status).toBe("blocked");
    expect(calls).not.toContain("wake");
  });

  it("fails explicitly for a provider without goals and does not invent local state", async () => {
    supported = false;
    expect((await run({ operation: "goal.set", goal: { status: "active" } })).error).toContain(
      "does not support native goals",
    );
    expect(getSessionGoal(key)).toBeNull();
    expect(calls).toEqual([]);
  });

  it("does not wake for an existing create-only goal", async () => {
    providerResult.data = { changed: false };
    await run({ operation: "goal.set", goal: { objective: "Another objective", createOnly: true } });
    expect(calls).toEqual(["stored", "control"]);
  });

  it("clears the projection only after the runtime confirms its absence", async () => {
    syncRuntimeSessionGoal(key, snapshot);
    providerResult = { ok: true, operation: "goal.clear", goal: null };
    await run({ operation: "goal.clear" });
    expect(getSessionGoal(key)).toBeNull();
    expect(calls).not.toContain("wake");
  });

  it("does not mutate while the session is still starting", async () => {
    live(true).starting = true;
    expect((await run({ operation: "goal.set", goal: { status: "active" } })).ok).toBe(false);
    expect(calls).toEqual([]);
  });
});
