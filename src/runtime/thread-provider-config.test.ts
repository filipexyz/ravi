import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { finalizeSlackThreadCreation } from "../channels/slack/thread-lifecycle.js";
import {
  createSlackThreadLifecycle,
  getSlackThreadLifecycle,
  markSlackThreadRootDelivered,
} from "../channels/slack/thread-lifecycle-store.js";
import { configureSlackThreadRuntime } from "../channels/slack/thread-runtime.js";
import { configStore } from "../config-store.js";
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
import { querySessionTrace } from "../session-trace/query.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { logger } from "../utils/logger.js";
import { syncAgentSessionsToAgentRuntime } from "./agent-session-runtime-sync.js";
import { RuntimeCrashRecoveryCoordinator } from "./crash-recovery.js";
import { createQueuedRuntimeUserMessage } from "./delivery-queue.js";
import { runRuntimeEventLoop } from "./host-event-loop.js";
import type { RuntimeHostStreamingSession, RuntimeMessageTarget, RuntimeUserMessage } from "./host-session.js";
import type { RuntimeLaunchPrompt } from "./message-types.js";
import * as modelBrokerPlanning from "./model-broker-planning.js";
import { createRuntimeProvider } from "./provider-registry.js";
import { resolveEffectiveSessionRuntime } from "./runtime-selection.js";
import { resolveRuntimeSession } from "./session-resolver.js";
import { RuntimeSessionDispatcher } from "./session-dispatcher.js";
import { buildSessionRelayTurnOrigin } from "./turn-origin.js";
import type { RuntimeEvent, RuntimeSessionHandle } from "./types.js";

const AGENT_ID = "thread-runtime-config";
const REQUEST_ID = "slack-thread:runtime-config";
const PROVIDER_SESSION_BEFORE = "claude-before-configuration";
const PROVIDER_SESSION_AFTER = "claude-after-configuration";
const USER_PROMPT = "Finish the active investigation.";
const ASSISTANT_REPLY = "The active Claude turn finished its investigation.";
const TURN_ID = "active-claude-turn";
const NEXT_PROMPT = "Continue after the provider configuration.";

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

describe("Slack thread provider configuration through the live dispatcher", () => {
  for (const provider of ["clear", "codex"] as const) {
    it(`starts the next turn on Codex after ${provider} while Claude was active`, async () => {
      await withActiveClaudeTurn(
        true,
        async (fixture) => {
          configureSlackThreadRuntime(
            {
              parentSession: fixture.parent,
              ref: REQUEST_ID,
              provider,
              model: provider === "clear" ? "clear" : "gpt-6-astra",
            },
            () => {},
          );
          fixture.expectUninterrupted();
          await fixture.complete();
          fixture.expectCompletionAccounting();
          expect(fixture.resolveNextTurn().effective.provider.value).toBe("codex");

          const dispatch = await fixture.dispatchNext();
          expect(dispatch.pendingPrompts).toEqual([]);
          expect(dispatch.startedProviders).toEqual(["codex"]);
          expect(dispatch.oldHandleDone).toBe(true);
          expect(dispatch.routing).toContainEqual({
            eventType: "dispatch.restart_requested",
            provider: "claude",
            requestedProvider: "codex",
          });
          expect(dispatch.routing.some(({ eventType }) => eventType === "dispatch.push_existing")).toBe(false);
        },
        { allowDispatch: true },
      );
    });
  }

  it("keeps the fast live queue after clear to a compatible Claude default", async () => {
    await withActiveClaudeTurn(
      true,
      async (fixture) => {
        configureSlackThreadRuntime(
          { parentSession: fixture.parent, ref: REQUEST_ID, provider: "clear", model: "clear" },
          () => {},
        );
        await fixture.complete();
        fixture.expectCompletionAccounting();
        const dispatch = await fixture.dispatchNext();
        expect(dispatch.pendingPrompts).toEqual([expect.stringContaining(NEXT_PROMPT)]);
        expect(dispatch.startedProviders).toEqual([]);
        expect(dispatch.oldHandleDone).toBe(false);
        expect(dispatch.planningCalls).toBe(0);
        expect(dispatch.wakeCalls).toBe(1);
        fixture.expectUninterrupted();
      },
      { allowDispatch: true, agentDefaultProvider: "claude" },
    );
  });

  it("keeps an unchanged ephemeral Claude launch in the fast queue despite a stored Codex provider", async () => {
    await withActiveClaudeTurn(
      false,
      async (fixture) => {
        expect(fixture.resolveNextTurn().stored.runtimeProvider).toBe("codex");
        const dispatch = await fixture.dispatchNext();
        expect(dispatch.pendingPrompts).toEqual([expect.stringContaining(NEXT_PROMPT)]);
        expect(dispatch.startedProviders).toEqual([]);
        expect(dispatch.oldHandleDone).toBe(false);
        expect(dispatch.planningCalls).toBe(0);
        // after_response stays queued until this active turn finishes.
        expect(dispatch.wakeCalls).toBe(0);
        fixture.expectUninterrupted();
        await fixture.complete();
      },
      { allowDispatch: true, firstTurn: true, previousProvider: "codex", launchProviderOverride: "claude" },
    );
  });

  it("moves only the queued successor to Codex when clear happens after it was queued on active Claude", async () => {
    await withActiveClaudeTurn(
      true,
      async (fixture) => {
        const queued = await fixture.dispatchNext();
        expect(queued.pendingPrompts).toEqual([USER_PROMPT, expect.stringContaining(NEXT_PROMPT)]);
        expect(queued.startedProviders).toEqual([]);
        expect(queued.wakeCalls).toBe(0);
        configureSlackThreadRuntime(
          { parentSession: fixture.parent, ref: REQUEST_ID, provider: "clear", model: "clear" },
          () => {},
        );
        fixture.expectUninterrupted();
        await fixture.complete({ expectRetired: true });
        expect(fixture.restartState()).toMatchObject({
          reasons: ["provider_change"],
          stashedPrompts: queued.pendingPrompts.slice(1),
          interrupted: false,
          terminalStatus: "complete",
        });
        expect(fixture.resolveNextTurn().resolved?.runtimeProviderId).toBe("codex");
      },
      { allowDispatch: true, includeCurrentPendingMessage: true },
    );
  });

  it("rechecks a provider clear committed while asynchronous dispatch preflight is pending", async () => {
    await withActiveClaudeTurn(
      true,
      async (fixture) => {
        await fixture.complete();
        const dispatch = await fixture.dispatchNext({
          prompt: {
            _observation: {
              sourceSessionKey: fixture.parent.sessionKey,
              sourceSessionName: fixture.parent.name!,
              bindingId: "provider-config-observer",
              ruleId: "provider-config-rule",
              role: "review",
              mode: "reactive",
              eventIds: ["provider-config-event"],
            },
          },
          duringPreflight: () => {
            configureSlackThreadRuntime(
              { parentSession: fixture.parent, ref: REQUEST_ID, provider: "clear", model: "clear" },
              () => {},
            );
          },
        });
        expect(dispatch.pendingPrompts).toEqual([]);
        expect(dispatch.startedProviders).toEqual(["codex"]);
        expect(dispatch.oldHandleDone).toBe(true);
      },
      { allowDispatch: true },
    );
  });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

interface ThreadFixtureOptions {
  allowDispatch?: boolean;
  includeCurrentPendingMessage?: boolean;
  agentDefaultProvider?: "claude" | "codex";
  previousProvider?: "claude" | "codex" | "unset";
  firstTurn?: boolean;
  launchProviderOverride?: "claude";
}

interface DispatchFixtureOptions {
  prompt?: Partial<RuntimeLaunchPrompt>;
  duringPreflight?: () => void;
}

interface DispatchFixtureResult {
  pendingPrompts: string[];
  startedProviders: string[];
  oldHandleDone: boolean;
  wakeCalls: number;
  planningCalls: number;
  routing: Array<{ eventType: string; provider: string | null; requestedProvider: unknown }>;
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
    dispatchNext(options?: DispatchFixtureOptions): Promise<DispatchFixtureResult>;
    restartState(): {
      reasons: string[];
      stashedPrompts: string[];
      pendingOnOldHandle: number;
      interrupted: boolean;
      terminalStatus: string | undefined;
    };
    expectUninterrupted(): void;
    complete(options?: { expectRetired?: boolean }): Promise<void>;
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
  const restart = mock(async (_input: { sessionName: string; reason: string }) => {});
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
  const currentPending = options.includeCurrentPendingMessage
    ? createQueuedRuntimeUserMessage({ prompt: USER_PROMPT, deliveryBarrier: "after_response" })
    : undefined;
  if (currentPending) currentPending.clientMessageId = "active-claude-input";
  const streaming: RuntimeHostStreamingSession = {
    agentId: AGENT_ID,
    queryHandle: runtimeSession,
    runtimeProviderConfigRevision: child.runtimeProviderConfigRevision ?? 0,
    starting: false,
    abortController: new AbortController(),
    pushMessage: null,
    pendingWake: false,
    pendingMessages: currentPending ? [currentPending] : [],
    ...(currentPending ? { currentTurnPendingIds: [currentPending.pendingId!] } : {}),
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
  const dispatchRecovery = options.allowDispatch
    ? new RuntimeCrashRecoveryCoordinator({ instanceId: "provider-config-dispatch-test" })
    : undefined;
  dispatchRecovery?.start();
  const dispatcher = dispatchRecovery
    ? new RuntimeSessionDispatcher({
        instanceId: "provider-config-dispatch-test",
        maxConcurrentSessions: 2,
        interactiveReservedSessions: 0,
        safeEmit: async () => {},
        notifyRuntimeRecoveryExhausted: async () => {},
        getConfigModel: () => "gpt-6-astra",
        crashRecovery: dispatchRecovery,
      })
    : undefined;
  const live = dispatcher?.streamingSessions ?? new Map<string, RuntimeHostStreamingSession>();
  live.set(sessionName, streaming);
  const stashedMessages = dispatcher?.stashedMessages ?? new Map<string, RuntimeUserMessage[]>();
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
    stashedMessages,
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
      restartState: () => ({
        reasons: restart.mock.calls.map(([input]) => input.reason),
        stashedPrompts: (stashedMessages.get(sessionName) ?? []).map((message) => String(message.message.content)),
        pendingOnOldHandle: streaming.pendingMessages.length,
        interrupted: streaming.interrupted,
        terminalStatus: getSessionTurn(TURN_ID)?.status,
      }),
      dispatchNext: async (dispatchOptions = {}) => {
        if (!dispatcher) throw new Error("This fixture did not enable the live dispatcher");
        configStore.refresh();
        const startedProviders: string[] = [];
        const start = spyOn(dispatcher, "startStreamingSession").mockImplementation(async (name, prompt) => {
          // Stop at the real launch resolver; no adapter process or service is started.
          const resolution = resolveRuntimeSession({
            sessionName: name,
            prompt,
            defaultRuntimeProviderId: "codex",
          });
          if (!resolution) throw new Error("The dispatched session could not be resolved");
          startedProviders.push(resolution.runtimeProviderId);
        });
        const planning = spyOn(modelBrokerPlanning, "planRuntimeModelBrokerRoute");
        const wake = mock(() => {});
        streaming.pushMessage = wake;
        try {
          const pending = dispatcher.handlePromptImmediate(sessionName, {
            prompt: NEXT_PROMPT,
            _agentId: AGENT_ID,
            deliveryBarrier: "after_response",
            deliveryBarrierSource: "default",
            _turnOrigin: buildSessionRelayTurnOrigin("send"),
            ...dispatchOptions.prompt,
          });
          if (dispatchOptions.duringPreflight) {
            // The actual planner is async, including its no-broker path. The
            // caller mutates config after its invocation and before it settles.
            expect(planning).toHaveBeenCalledTimes(1);
            dispatchOptions.duringPreflight();
          }
          await pending;
          return {
            pendingPrompts: streaming.pendingMessages.map((message) => String(message.message.content)),
            startedProviders,
            oldHandleDone: streaming.done,
            wakeCalls: wake.mock.calls.length,
            planningCalls: planning.mock.calls.length,
            routing: querySessionTrace({ sessionKey: child.sessionKey, sessionName })
              .events.filter(
                ({ eventType }) => eventType === "dispatch.push_existing" || eventType === "dispatch.restart_requested",
              )
              .map(({ eventType, provider, payloadJson }) => ({
                eventType,
                provider,
                requestedProvider:
                  payloadJson && typeof payloadJson === "object" && !Array.isArray(payloadJson)
                    ? payloadJson.requestedProvider
                    : undefined,
              })),
          };
        } finally {
          planning.mockRestore();
          start.mockRestore();
        }
      },
      complete: async ({ expectRetired = false } = {}) => {
        allowCompletion.resolve();
        if (expectRetired) {
          await Promise.race([
            loop,
            completed.promise.then(() => {
              throw new Error(
                "The configured provider's old handle accepted another iterator read instead of retiring",
              );
            }),
          ]);
          expect(streaming.done).toBe(true);
          expect(live.has(sessionName)).toBe(false);
          expect(streaming.turnActive).toBe(false);
          return;
        }
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
    // The fake provider never consumes a second prompt. Its queued content is
    // asserted above, then discarded only for fixture teardown.
    if (dispatcher) streaming.pendingMessages.length = 0;
    allowCompletion.resolve();
    allowEnd.resolve();
    await loop;
    dispatcher?.shutdownAll();
    if (dispatchRecovery?.acceptingDeliveries) dispatchRecovery.stopGracefully("test_cleanup");
  }
  if (!dispatcher) expect(interrupt).not.toHaveBeenCalled();
  if (!dispatcher) expect(restart).not.toHaveBeenCalled();
}
