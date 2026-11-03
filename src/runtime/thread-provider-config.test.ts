import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { finalizeSlackThreadCreation } from "../channels/slack/thread-lifecycle.js";
import {
  createSlackThreadLifecycle,
  getSlackThreadLifecycle,
  markSlackThreadRootDelivered,
} from "../channels/slack/thread-lifecycle-store.js";
import { configureSlackThreadRuntime } from "../channels/slack/thread-runtime.js";
import * as pricing from "../costs/pricing-catalog.js";
import { getRecentHistory, saveMessage } from "../db.js";
import { nats } from "../nats.js";
import { dbCreateAgent, dbGetAgent, dbGetCostForSession, dbUpdateAgent, dbUpsertChat } from "../router/router-db.js";
import {
  getOrCreateSession,
  getSession,
  updateRuntimeProviderState,
  updateSessionRuntimeProviderOverride,
} from "../router/sessions.js";
import { recordAdapterRequestTrace } from "../session-trace/runtime-trace.js";
import { getSessionTurn } from "../session-trace/session-trace-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { logger } from "../utils/logger.js";
import { syncAgentSessionsToAgentRuntime } from "./agent-session-runtime-sync.js";
import { runRuntimeEventLoop } from "./host-event-loop.js";
import type { RuntimeHostStreamingSession, RuntimeMessageTarget } from "./host-session.js";
import { createRuntimeProvider } from "./provider-registry.js";
import { resolveEffectiveSessionRuntime } from "./runtime-selection.js";
import { resolveRuntimeSession } from "./session-resolver.js";
import type { RuntimeEvent, RuntimeSessionHandle } from "./types.js";

const AGENT_ID = "thread-runtime-config";
const REQUEST_ID = "slack-thread:runtime-config";
const PROVIDER_SESSION_BEFORE = "claude-before-configuration";
const PROVIDER_SESSION_AFTER = "claude-after-configuration";
const USER_PROMPT = "Finish the active investigation.";
const ASSISTANT_REPLY = "The active Claude turn finished its investigation.";
const TURN_ID = "active-claude-turn";

let stateDir: string | null = null;
let restoreEffects: () => void;

beforeEach(async () => {
  logger.setLevel("error");
  stateDir = await createIsolatedRaviState("ravi-thread-provider-config-");
  const emit = spyOn(nats, "emit").mockImplementation(async () => {});
  const prewarm = spyOn(pricing, "prewarmPricingCatalog").mockImplementation(() => {});
  const cost = spyOn(pricing, "calculateCost").mockResolvedValue({
    inputCost: 0.01,
    outputCost: 0.02,
    cacheCost: 0,
    totalCost: 0.03,
    pricingStatus: "priced",
  });
  const rejectExternalRequest = () => {
    throw new Error("Unexpected external request in thread provider configuration test");
  };
  const fetch = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(async () => rejectExternalRequest(), { preconnect: rejectExternalRequest }),
  );
  restoreEffects = () => {
    fetch.mockRestore();
    cost.mockRestore();
    prewarm.mockRestore();
    emit.mockRestore();
  };
});

afterAll(() => logger.setLevel("info"));

afterEach(async () => {
  restoreEffects?.();
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

describe("Slack thread provider configuration during an active runtime turn", () => {
  for (const explicitOverride of [true, false]) {
    it(`keeps provider clear after Claude completes (${explicitOverride ? "session override" : "last-used provider"})`, async () => {
      await withActiveClaudeTurn(explicitOverride, async (fixture) => {
        const result = configureSlackThreadRuntime(
          { parentSession: fixture.parent, ref: REQUEST_ID, provider: "clear", model: "clear" },
          () => {},
        );
        expect(result).toMatchObject({
          status: "configured",
          appliesOn: "next-turn",
          after: { provider: null, model: null },
          thread: { runtime: { provider: "codex", model: "gpt-6-astra" } },
        });
        fixture.expectUninterrupted();

        await fixture.complete();
        fixture.expectCompletionAccounting();
        const { stored, effective, resolved } = fixture.resolveNextTurn();
        expect(effective.provider.value).toBe("codex");
        expect(effective.model.value).toBe("gpt-6-astra");
        expect(resolved?.runtimeProviderId).toBe("codex");
        expect(resolved?.canResumeStoredSession).toBe(false);
        expect(stored.runtimeProviderOverride).toBeUndefined();
        expect(stored.runtimeProvider).not.toBe("claude");
        expect(stored.providerSessionId).toBeUndefined();
        expect(stored.runtimeSessionParams).toBeUndefined();
      });
    });
  }

  for (const previousProvider of ["codex", "unset"] as const) {
    it(`keeps clear effective during the first Claude turn when last-used provider stays ${previousProvider}`, async () => {
      await withActiveClaudeTurn(
        true,
        async (fixture) => {
          const before = fixture.resolveNextTurn();
          expect(before.stored.runtimeProvider).toBe(previousProvider === "unset" ? undefined : "codex");
          expect(before.stored.runtimeProviderOverride).toBe("claude");
          expect(before.stored.providerSessionId).toBeUndefined();
          expect(before.resolved?.runtimeProviderId).toBe("claude");
          const result = configureSlackThreadRuntime(
            { parentSession: fixture.parent, ref: REQUEST_ID, provider: "clear", model: "clear" },
            () => {},
          );
          expect(result.thread.runtime).toMatchObject({ provider: "codex", model: "gpt-6-astra" });
          expect(fixture.resolveNextTurn().stored.runtimeProvider).toBe(before.stored.runtimeProvider);
          fixture.expectUninterrupted();

          await fixture.complete();
          fixture.expectCompletionAccounting();
          const { stored, effective, resolved } = fixture.resolveNextTurn();
          expect(effective.provider.value).toBe("codex");
          expect(resolved?.runtimeProviderId).toBe("codex");
          expect(resolved?.canResumeStoredSession).toBe(false);
          expect(stored.runtimeProvider).not.toBe("claude");
          expect(stored.providerSessionId).toBeUndefined();
          expect(stored.runtimeSessionParams).toBeUndefined();
        },
        { previousProvider, firstTurn: true },
      );
    });
  }

  for (const switchFirst of [false, true]) {
    it(`honors provider intent when an ephemeral Claude launch ends with the same persisted config (${switchFirst ? "Codex then clear" : "clear already-null override"})`, async () => {
      // This handle was selected by a one-turn launch override. Its native
      // state must not defeat a later explicit clear, even when config values
      // return to their launch snapshot or never change at all.
      await withActiveClaudeTurn(
        false,
        async (fixture) => {
          const before = fixture.resolveNextTurn().stored;
          expect(before.runtimeProvider).toBe("codex");
          expect(before.runtimeProviderOverride).toBeUndefined();
          expect(before.providerSessionId).toBeUndefined();
          if (switchFirst) {
            configureSlackThreadRuntime(
              { parentSession: fixture.parent, ref: REQUEST_ID, provider: "codex", model: "gpt-6-astra" },
              () => {},
            );
          }
          configureSlackThreadRuntime(
            { parentSession: fixture.parent, ref: REQUEST_ID, provider: "clear", model: "clear" },
            () => {},
          );
          const configured = fixture.resolveNextTurn().stored;
          expect(configured.runtimeProvider).toBe(before.runtimeProvider);
          expect(configured.runtimeProviderOverride).toBe(before.runtimeProviderOverride);
          fixture.expectUninterrupted();

          await fixture.complete();
          fixture.expectCompletionAccounting();
          const { stored, effective, resolved } = fixture.resolveNextTurn();
          expect(effective.provider.value).toBe("codex");
          expect(resolved?.runtimeProviderId).toBe("codex");
          expect(resolved?.canResumeStoredSession).toBe(false);
          expect(stored.runtimeProvider).toBe("codex");
          expect(stored.providerSessionId).toBeUndefined();
        },
        { previousProvider: "codex", firstTurn: true, launchProviderOverride: "claude" },
      );
    });
  }

  it("honors administrative rematerialization away and back during an ephemeral first Claude turn", async () => {
    await withActiveClaudeTurn(
      false,
      async (fixture) => {
        const before = fixture.resolveNextTurn().stored;
        expect(before.runtimeProvider).toBe("codex");
        expect(before.runtimeProviderOverride).toBeUndefined();
        expect(before.providerSessionId).toBeUndefined();

        const claudeDefault = dbUpdateAgent(AGENT_ID, { provider: "claude", model: "opus" });
        syncAgentSessionsToAgentRuntime({ agent: claudeDefault, rematerialize: true });
        expect(fixture.resolveNextTurn().stored.runtimeProvider).toBe("claude");
        const codexDefault = dbUpdateAgent(AGENT_ID, { provider: "codex", model: "gpt-6-astra" });
        syncAgentSessionsToAgentRuntime({ agent: codexDefault, rematerialize: true });
        const configured = fixture.resolveNextTurn().stored;
        expect(configured.runtimeProvider).toBe(before.runtimeProvider);
        expect(configured.runtimeProviderOverride).toBe(before.runtimeProviderOverride);
        fixture.expectUninterrupted();

        await fixture.complete();
        fixture.expectCompletionAccounting();
        const { stored, effective, resolved } = fixture.resolveNextTurn();
        expect(effective.provider.value).toBe("codex");
        expect(resolved?.runtimeProviderId).toBe("codex");
        expect(resolved?.canResumeStoredSession).toBe(false);
        expect(stored.runtimeProvider).toBe("codex");
        expect(stored.providerSessionId).toBeUndefined();
        expect(stored.runtimeSessionParams).toBeUndefined();
      },
      { previousProvider: "codex", firstTurn: true, launchProviderOverride: "claude" },
    );
  });

  it("preserves an explicit switch to Codex after the active Claude turn completes", async () => {
    await withActiveClaudeTurn(true, async (fixture) => {
      configureSlackThreadRuntime(
        { parentSession: fixture.parent, ref: REQUEST_ID, provider: "codex", model: "gpt-6-astra" },
        () => {},
      );
      fixture.expectUninterrupted();
      await fixture.complete();
      fixture.expectCompletionAccounting();

      const { stored, effective, resolved } = fixture.resolveNextTurn();
      expect(stored.runtimeProviderOverride).toBe("codex");
      expect(effective.provider.value).toBe("codex");
      expect(resolved?.runtimeProviderId).toBe("codex");
      expect(resolved?.canResumeStoredSession).toBe(false);
    });
  });

  for (const firstTurn of [false, true]) {
    it(`preserves the native session when clear follows a compatible agent default (${firstTurn ? "first turn" : "resumed"})`, async () => {
      await withActiveClaudeTurn(
        true,
        async (fixture) => {
          configureSlackThreadRuntime(
            { parentSession: fixture.parent, ref: REQUEST_ID, provider: "clear", model: "clear" },
            () => {},
          );
          fixture.expectUninterrupted();
          await fixture.complete();
          fixture.expectCompletionAccounting();

          const { stored, effective, resolved } = fixture.resolveNextTurn();
          expect(stored.runtimeProviderOverride).toBeUndefined();
          expect(stored.modelOverride).toBeUndefined();
          expect(stored.runtimeProvider).toBe("claude");
          expect(stored.providerSessionId).toBe(PROVIDER_SESSION_AFTER);
          expect(effective.provider.value).toBe("claude");
          expect(effective.model.value).toBe("opus");
          expect(resolved?.canResumeStoredSession).toBe(true);
          expect(resolved?.storedProviderSessionId).toBe(PROVIDER_SESSION_AFTER);
        },
        { agentDefaultProvider: "claude", previousProvider: firstTurn ? "unset" : "claude", firstTurn },
      );
    });
  }

  it("persists a newly launched provider after success when its prior last-used provider was unchanged", async () => {
    await withActiveClaudeTurn(
      true,
      async (fixture) => {
        fixture.expectUninterrupted();
        await fixture.complete();
        fixture.expectCompletionAccounting();

        const { stored, effective, resolved } = fixture.resolveNextTurn();
        expect(stored.runtimeProvider).toBe("claude");
        expect(stored.providerSessionId).toBe(PROVIDER_SESSION_AFTER);
        expect(effective.provider.value).toBe("claude");
        expect(resolved?.canResumeStoredSession).toBe(true);
        expect(resolved?.storedProviderSessionId).toBe(PROVIDER_SESSION_AFTER);
      },
      { previousProvider: "codex" },
    );
  });

  for (const explicitOverride of [true, false]) {
    it(`preserves Claude continuity for an effort-only edit (${explicitOverride ? "session override" : "last-used provider"})`, async () => {
      await withActiveClaudeTurn(explicitOverride, async (fixture) => {
        configureSlackThreadRuntime({ parentSession: fixture.parent, ref: REQUEST_ID, effort: "ultra" }, () => {});
        fixture.expectUninterrupted();
        await fixture.complete();
        fixture.expectCompletionAccounting();

        const { stored, effective, resolved } = fixture.resolveNextTurn();
        expect(stored.effortOverride).toBe("ultra");
        expect(stored.runtimeProvider).toBe("claude");
        expect(stored.providerSessionId).toBe(PROVIDER_SESSION_AFTER);
        expect(stored.runtimeSessionParams).toMatchObject({ sessionId: PROVIDER_SESSION_AFTER });
        expect(effective.provider.value).toBe("claude");
        expect(resolved?.runtimeProviderId).toBe("claude");
        expect(resolved?.canResumeStoredSession).toBe(true);
        expect(resolved?.storedProviderSessionId).toBe(PROVIDER_SESSION_AFTER);
      });
    });
  }
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

interface ThreadFixtureOptions {
  agentDefaultProvider?: "claude" | "codex";
  previousProvider?: "claude" | "codex" | "unset";
  firstTurn?: boolean;
  launchProviderOverride?: "claude";
}

async function seedThread(explicitOverride: boolean, options: ThreadFixtureOptions) {
  const defaultProvider = options.agentDefaultProvider ?? "codex";
  dbCreateAgent({
    id: AGENT_ID,
    cwd: stateDir!,
    provider: defaultProvider,
    model: defaultProvider === "claude" ? "opus" : "gpt-6-astra",
  });
  const parent = getOrCreateSession(`agent:${AGENT_ID}:slack:ravi-slack:group:C123`, AGENT_ID, stateDir!, {
    name: "runtime-config-parent",
    channel: "slack",
    chatType: "channel",
    lastChannel: "slack",
    lastTo: "C123",
    lastAccountId: "ravi-slack",
  });
  const root = dbUpsertChat({
    channel: "slack",
    instanceId: "slack-instance-1",
    platformChatId: "C123",
    chatType: "channel",
  });
  createSlackThreadLifecycle({
    requestId: REQUEST_ID,
    parentSessionKey: parent.sessionKey,
    parentSessionName: parent.name!,
    accountId: "ravi-slack",
    instanceId: "slack-instance-1",
    platformChatId: "C123",
    rootCanonicalChatId: root.id,
    initialPrompt: USER_PROMPT,
    providerOverride: "claude",
    modelOverride: "opus",
  });
  markSlackThreadRootDelivered({
    requestId: REQUEST_ID,
    providerThreadId: "1713000000.000100",
    canonicalRootMessageId: "runtime-config-root",
  });
  await finalizeSlackThreadCreation(REQUEST_ID, {
    publishPrompt: mock(async () => {}),
    publishEvent: mock(async () => {}),
    publishOutbound: mock(async () => {}),
  });
  const record = getSlackThreadLifecycle(REQUEST_ID)!;
  if (!explicitOverride) updateSessionRuntimeProviderOverride(record.childSessionKey!, null);
  updateRuntimeProviderState(
    record.childSessionKey!,
    options.previousProvider === "unset" ? undefined : (options.previousProvider ?? "claude"),
    options.firstTurn
      ? {}
      : {
          providerSessionId: PROVIDER_SESSION_BEFORE,
          runtimeSessionDisplayId: PROVIDER_SESSION_BEFORE,
          runtimeSessionParams: { sessionId: PROVIDER_SESSION_BEFORE },
        },
  );
  return { parent, child: getSession(record.childSessionKey!)!, record };
}

async function withActiveClaudeTurn(
  explicitOverride: boolean,
  run: (fixture: {
    parent: Awaited<ReturnType<typeof seedThread>>["parent"];
    expectUninterrupted(): void;
    complete(): Promise<void>;
    expectCompletionAccounting(): void;
    resolveNextTurn(): {
      stored: NonNullable<ReturnType<typeof getSession>>;
      effective: ReturnType<typeof resolveEffectiveSessionRuntime>;
      resolved: ReturnType<typeof resolveRuntimeSession>;
    };
  }) => Promise<void>,
  options: ThreadFixtureOptions = {},
) {
  const { parent, child, record } = await seedThread(explicitOverride, options);
  const sessionName = child.name!;
  if (options.launchProviderOverride) {
    const initial = resolveRuntimeSession({
      sessionName,
      prompt: { prompt: USER_PROMPT },
      defaultRuntimeProviderId: "codex",
      runtimeProviderIdOverride: options.launchProviderOverride,
      identity: {
        sessionEntry: child,
        session: { ...child },
        agentId: AGENT_ID,
        agent: dbGetAgent(AGENT_ID)!,
        agentCwd: stateDir!,
        sessionCwd: stateDir!,
        dbSessionKey: child.sessionKey,
      },
    });
    expect(initial?.runtimeProviderId).toBe("claude");
    expect(initial?.canResumeStoredSession).toBe(false);
  }
  const active = deferred();
  const allowCompletion = deferred();
  const completed = deferred();
  const allowEnd = deferred();
  const interrupt = mock(async () => {});
  const close = mock(async () => {});
  const restart = mock(async () => {});
  const runtimeSession: RuntimeSessionHandle = {
    provider: "claude",
    events: (async function* (): AsyncGenerator<RuntimeEvent> {
      yield { type: "assistant.message", text: ASSISTANT_REPLY };
      active.resolve();
      await allowCompletion.promise;
      yield {
        type: "turn.complete",
        providerSessionId: PROVIDER_SESSION_AFTER,
        session: { displayId: PROVIDER_SESSION_AFTER, params: { sessionId: PROVIDER_SESSION_AFTER } },
        usage: { inputTokens: 10, outputTokens: 4 },
      };
      // Iterator advancement proves the host finished the entire terminal branch.
      completed.resolve();
      await allowEnd.promise;
    })(),
    interrupt,
    close,
  };
  const source: RuntimeMessageTarget = {
    channel: "slack",
    accountId: "ravi-slack",
    instanceId: "slack-instance-1",
    chatId: "C123",
    canonicalChatId: record.threadCanonicalChatId!,
    threadId: record.providerThreadId!,
  };
  const streaming: RuntimeHostStreamingSession = {
    agentId: AGENT_ID,
    queryHandle: runtimeSession,
    starting: false,
    abortController: new AbortController(),
    pushMessage: null,
    pendingWake: false,
    pendingMessages: [],
    currentSource: source,
    currentModel: "opus",
    toolRunning: false,
    lastActivity: Date.now(),
    done: false,
    interrupted: false,
    turnActive: true,
    compacting: false,
    onTurnComplete: null,
    currentToolSafety: null,
    pendingAbort: false,
    agentMode: "sentinel",
    traceRunId: "provider-config-run",
    toolEffectFence: "host_write_ahead",
  };
  const trace = recordAdapterRequestTrace({
    sessionKey: child.sessionKey,
    sessionName,
    agentId: AGENT_ID,
    runId: streaming.traceRunId,
    turnId: TURN_ID,
    provider: "claude",
    model: "opus",
    prompt: USER_PROMPT,
    systemPrompt: "Investigate the current Slack thread.",
    cwd: stateDir!,
    resume: Boolean(child.providerSessionId),
    fork: false,
    source,
    hasHooks: false,
    pluginNames: [],
    mcpServerNames: [],
    hasRemoteSpawn: false,
  })!;
  streaming.currentTraceTurnId = trace.turnId;
  streaming.currentTraceTurnStartedAt = trace.startedAt;
  saveMessage(sessionName, "user", USER_PROMPT, child.providerSessionId);
  const live = new Map([[sessionName, streaming]]);
  const loop = runRuntimeEventLoop({
    runId: streaming.traceRunId!,
    sessionName,
    session: child,
    agent: dbGetAgent(AGENT_ID)!,
    streaming,
    runtimeSession,
    runtimeCapabilities: createRuntimeProvider("claude").getCapabilities(),
    model: "opus",
    instanceId: "provider-config-test",
    defaultRuntimeProviderId: "codex",
    streamingSessions: live,
    stashedMessages: new Map(),
    safeEmit: async () => {},
    drainPendingStarts: () => {},
    restartStashedSession: restart,
  });
  const waitFor = (gate: ReturnType<typeof deferred>) =>
    Promise.race([
      gate.promise,
      loop.then(() => {
        throw new Error("Runtime loop ended before reaching the requested test boundary");
      }),
    ]);
  const expectUninterrupted = () => {
    expect(live.get(sessionName)).toBe(streaming);
    expect(streaming.queryHandle).toBe(runtimeSession);
    expect(streaming.abortController.signal.aborted).toBe(false);
    expect(streaming.interrupted).toBe(false);
    expect(streaming.done).toBe(false);
    expect(interrupt).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(restart).not.toHaveBeenCalled();
  };

  try {
    await waitFor(active);
    expect(streaming.turnActive).toBe(true);
    await run({
      parent,
      expectUninterrupted,
      complete: async () => {
        allowCompletion.resolve();
        await waitFor(completed);
        expectUninterrupted();
        expect(streaming.turnActive).toBe(false);
      },
      expectCompletionAccounting: () => {
        expect(getRecentHistory(sessionName).map(({ role, content }) => ({ role, content }))).toEqual([
          { role: "user", content: USER_PROMPT },
          { role: "assistant", content: ASSISTANT_REPLY },
        ]);
        expect(getSession(child.sessionKey)).toMatchObject({ inputTokens: 10, outputTokens: 4 });
        expect(dbGetCostForSession(child.sessionKey)).toMatchObject({ total_cost: 0.03, turns: 1 });
        expect(getSessionTurn(TURN_ID)).toMatchObject({ status: "complete", provider: "claude", model: "opus" });
      },
      resolveNextTurn: () => {
        const stored = getSession(child.sessionKey)!;
        const agent = dbGetAgent(AGENT_ID)!;
        const effective = resolveEffectiveSessionRuntime({ session: stored, agent });
        const resolved = resolveRuntimeSession({
          sessionName,
          prompt: { prompt: "Continue the investigation." },
          defaultRuntimeProviderId: "codex",
          identity: {
            sessionEntry: stored,
            session: { ...stored },
            agentId: AGENT_ID,
            agent,
            agentCwd: stateDir!,
            sessionCwd: stateDir!,
            dbSessionKey: child.sessionKey,
          },
        });
        return { stored, effective, resolved };
      },
    });
  } finally {
    allowCompletion.resolve();
    allowEnd.resolve();
    await loop;
  }
  expect(interrupt).not.toHaveBeenCalled();
  expect(restart).not.toHaveBeenCalled();
}
