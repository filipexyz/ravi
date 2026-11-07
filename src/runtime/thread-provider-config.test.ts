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
import {
  dbCreateAgent,
  dbGetAgent,
  dbGetCostForSession,
  dbUpdateAgent,
  dbUpsertChat,
  dbUpsertDaemonRestartEpoch,
} from "../router/router-db.js";
import {
  getOrCreateSession,
  getSession,
  updateRuntimeProviderState,
  updateSessionRuntimeProviderOverride,
} from "../router/sessions.js";
import { recordAdapterRequestTrace } from "../session-trace/runtime-trace.js";
import { getSessionTurn } from "../session-trace/session-trace-db.js";
import { querySessionTrace } from "../session-trace/query.js";
import { dbCompleteTask, dbCreateTask, dbDispatchTask, dbHasActiveTaskForSession } from "../tasks/task-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { logger } from "../utils/logger.js";
import { syncAgentSessionsToAgentRuntime } from "./agent-session-runtime-sync.js";
import { RuntimeCrashRecoveryCoordinator } from "./crash-recovery.js";
import { getRuntimeTurnAttempt } from "./crash-recovery-store.js";
import { buildDaemonRestartResumePrompt } from "./daemon-restart-resume.js";
import { createQueuedRuntimeUserMessage, createRuntimeMessageGenerator } from "./delivery-queue.js";
import { runRuntimeEventLoop } from "./host-event-loop.js";
import type { RuntimeHostStreamingSession, RuntimeMessageTarget, RuntimeUserMessage } from "./host-session.js";
import { getRuntimeLiveState, updateRuntimeLiveState } from "./live-state.js";
import type { RuntimeLaunchPrompt } from "./message-types.js";
import * as modelBrokerPlanning from "./model-broker-planning.js";
import { createRuntimeProvider } from "./provider-registry.js";
import { PROVIDER_ENDED_WITH_OPEN_TOOLS_USER_MESSAGE } from "./public-failure.js";
import { resolveEffectiveSessionRuntime } from "./runtime-selection.js";
import { resolveRuntimeSession } from "./session-resolver.js";
import { RuntimeSessionDispatcher } from "./session-dispatcher.js";
import * as toolLiveness from "./tool-liveness.js";
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

describe("provider changes with durable turns and real prompt generators", () => {
  for (const order of ["clear-successor-terminal", "successor-clear-terminal", "clear-terminal-successor"] as const) {
    it(`delivers the successor once without interrupting the completed input (${order})`, async () => {
      await withGeneratedClaudeTurn({}, async (fixture) => {
        if (order === "successor-clear-terminal") await fixture.dispatch(NEXT_PROMPT);
        fixture.clear();
        if (order === "clear-successor-terminal") await fixture.dispatch(NEXT_PROMPT);
        fixture.expectActiveOriginal();
        expect(fixture.snapshot().startedProviders).toEqual([]);

        await fixture.finishOriginal(order !== "clear-terminal-successor");
        if (order === "clear-terminal-successor") await fixture.dispatch(NEXT_PROMPT);
        const snapshot = fixture.snapshot();
        expect(snapshot.originalAttemptStatus).toBe("complete");
        expect(snapshot.originalTraceStatus).toBe("complete");
        expect(snapshot.oldInputs).toEqual([USER_PROMPT]);
        expect(snapshot.replacementInputs).toEqual([expect.stringContaining(NEXT_PROMPT)]);
        expect(snapshot.startedProviders).toEqual(["codex"]);
        expect(snapshot.stashedPrompts).toEqual([]);
        expect(snapshot.assistantReplies).toEqual([ASSISTANT_REPLY]);
      });
    });
  }

  it("keeps a compatible provider and hands the queued successor to its original generator", async () => {
    await withGeneratedClaudeTurn({ agentDefaultProvider: "claude" }, async (fixture) => {
      fixture.clear();
      await fixture.dispatch(NEXT_PROMPT);
      fixture.expectActiveOriginal();
      await fixture.finishOriginal(false);
      await fixture.waitForOldSuccessor();
      const snapshot = fixture.snapshot();
      expect(snapshot.originalAttemptStatus).toBe("complete");
      expect(snapshot.originalTraceStatus).toBe("complete");
      expect(snapshot.oldInputs).toEqual([USER_PROMPT, expect.stringContaining(NEXT_PROMPT)]);
      expect(snapshot.startedProviders).toEqual([]);
      expect(snapshot.replacementInputs).toEqual([]);
      expect(snapshot.stashedPrompts).toEqual([]);
    });
  });

  it("does not resurrect B after a replacement consumes it while the old completion awaits pricing", async () => {
    await withGeneratedClaudeTurn({ pausePricing: true }, async (fixture) => {
      await fixture.dispatch(NEXT_PROMPT);
      fixture.clear();
      fixture.expectActiveOriginal();
      fixture.releaseOriginalTerminal();
      await fixture.waitForPricing();

      await fixture.dispatch("A newer independent successor C.");
      const replacement = fixture.snapshot();
      expect(replacement.startedProviders).toEqual(["codex"]);
      expect(replacement.replacementInputs).toEqual([expect.stringContaining(NEXT_PROMPT)]);
      expect(replacement.stashedPrompts).toEqual([]);
      expect(replacement.replacementOwnsSlot).toBe(true);

      fixture.releasePricing();
      await fixture.waitForOldLoop();
      const settled = fixture.snapshot();
      expect(settled.originalAttemptStatus).toBe("complete");
      expect(settled.originalTraceStatus).toBe("complete");
      expect(settled.replacementOwnsSlot).toBe(true);
      expect(settled.replacementInputs).toEqual(replacement.replacementInputs);
      expect(settled.stashedPrompts).toEqual([]);
      expect(settled.restarts).toEqual([]);
      expect(settled.assistantReplies).toEqual([ASSISTANT_REPLY]);
      fixture.expectCompletionAccounting();
    });
  });

  it("preserves completed accounting when a rejected model switch replaces the handle during pricing", async () => {
    await withGeneratedClaudeTurn({ pausePricing: true, rejectModelSwitch: true }, async (fixture) => {
      await fixture.dispatch(NEXT_PROMPT);
      fixture.expectActiveOriginal();
      fixture.releaseOriginalTerminal();
      await fixture.waitForPricing();

      expect(await fixture.changeModel("sonnet")).toBe("restart-next-turn");
      const replacement = fixture.snapshot();
      expect(replacement.modelSwitchCalls).toEqual(["sonnet"]);
      expect(replacement.startedProviders).toEqual(["claude"]);
      expect(replacement.replacementInputs).toEqual([expect.stringContaining(NEXT_PROMPT)]);
      expect(replacement.stashedPrompts).toEqual([]);
      expect(replacement.replacementOwnsSlot).toBe(true);

      fixture.releasePricing();
      await fixture.waitForOldLoop();
      const settled = fixture.snapshot();
      expect(settled.originalAttemptStatus).toBe("complete");
      expect(settled.originalTraceStatus).toBe("complete");
      expect(settled.replacementOwnsSlot).toBe(true);
      expect(settled.replacementInputs).toEqual(replacement.replacementInputs);
      expect(settled.stashedPrompts).toEqual([]);
      expect(settled.restarts).toEqual([]);
      expect(settled.assistantReplies).toEqual([ASSISTANT_REPLY]);
      fixture.expectCompletionAccounting();
    });
  });
});

describe("provider configuration at every terminal generator boundary", () => {
  for (const terminal of ["complete", "failed", "interrupted"] as const) {
    for (const deliveryBarrier of ["after_response", "after_task"] as const) {
      for (const configuration of ["incompatible-clear", "compatible-clear", "unchanged"] as const) {
        it(`preserves ${terminal} and delivers B once (${deliveryBarrier}, ${configuration})`, async () => {
          const incompatible = configuration === "incompatible-clear";
          await withGeneratedClaudeTurn(
            {
              terminal,
              deliveryBarrier,
              activeTaskBarrier: deliveryBarrier === "after_task",
              agentDefaultProvider: configuration === "compatible-clear" ? "claude" : "codex",
            },
            async (fixture) => {
              if (configuration !== "unchanged") fixture.clear();
              await fixture.dispatch(NEXT_PROMPT);
              fixture.expectActiveOriginal();
              expect(fixture.snapshot().startedProviders).toEqual([]);

              await fixture.finishOriginal(false);
              await fixture.waitForSuccessorSettlement();
              fixture.expectTerminalAccounting(terminal);
              if (deliveryBarrier === "after_task") {
                // The task is still dispatched in SQLite after A terminalizes.
                // A replacement handle may exist, but neither generator may yield B.
                fixture.expectTaskBlocked();
                await fixture.releaseTaskBarrier();
              }
              await fixture.waitForSuccessorInput();
              fixture.expectSuccessorBinding();
              const settled = fixture.snapshot();
              expect(settled.originalAttemptStatus).toBe(terminal);
              expect(settled.originalTraceStatus).toBe(terminal);
              expect(settled.oldInputs).toEqual(
                incompatible ? [USER_PROMPT] : [USER_PROMPT, expect.stringContaining(NEXT_PROMPT)],
              );
              expect(settled.replacementInputs).toEqual(incompatible ? [expect.stringContaining(NEXT_PROMPT)] : []);
              expect(settled.startedProviders).toEqual(incompatible ? ["codex"] : []);
              expect(settled.restarts).toEqual(incompatible ? ["provider_change"] : []);
              expect(settled.stashedPrompts).toEqual([]);
              expect(settled.assistantReplies).toEqual([ASSISTANT_REPLY]);
              const successorOccurrences = [...settled.oldInputs, ...settled.replacementInputs].reduce(
                (count, input) => count + input.split(NEXT_PROMPT).length - 1,
                0,
              );
              expect(successorOccurrences).toBe(1);
            },
          );
        });
      }
    }
  }

  for (const terminal of ["complete", "failed", "interrupted"] as const) {
    it(`does not automatically resume the queued successor after explicit cancellation (${terminal})`, async () => {
      await withGeneratedClaudeTurn({ terminal }, async (fixture) => {
        fixture.clear();
        await fixture.dispatch(NEXT_PROMPT);
        fixture.expectActiveOriginal();
        fixture.abortOriginal();
        await fixture.finishOriginal(true);
        const settled = fixture.snapshot();
        expect(settled.originalAttemptStatus).toBe("aborted");
        expect(settled.originalTraceStatus).toBe("aborted");
        expect(settled.oldInputs).toEqual([USER_PROMPT]);
        expect(settled.replacementInputs).toEqual([]);
        expect(settled.startedProviders).toEqual([]);
        expect(settled.restarts).toEqual([]);
        // Abort keeps independent queued work for an explicit later resume.
        expect(settled.stashedPrompts).toEqual([expect.stringContaining(NEXT_PROMPT)]);
      });
    });

    it(`keeps a deferred explicit abort dormant after provider clear (${terminal})`, async () => {
      await withGeneratedClaudeTurn({ terminal }, async (fixture) => {
        fixture.clear();
        await fixture.dispatch(NEXT_PROMPT);
        fixture.expectActiveOriginal();
        fixture.abortOriginal(true);
        await fixture.finishOriginal(false);
        await fixture.waitForSuccessorSettlement();
        fixture.expectTerminalAccounting(terminal);
        const settled = fixture.snapshot();
        expect(settled.oldInputs).toEqual([USER_PROMPT]);
        expect(settled.replacementInputs).toEqual([]);
        expect(settled.startedProviders).toEqual([]);
        expect(settled.restarts).toEqual([]);
        expect(settled.stashedPrompts).toEqual([expect.stringContaining(NEXT_PROMPT)]);
        expect(settled.originalDone).toBe(true);
      });
    });
  }

  for (const clear of [true, false]) {
    it(`preserves replay-safe interruption recovery (${clear ? "provider clear" : "unchanged config"})`, async () => {
      await withGeneratedClaudeTurn({ terminal: "interrupted", emitAssistant: false }, async (fixture) => {
        if (clear) fixture.clear();
        await fixture.dispatch(NEXT_PROMPT);
        fixture.expectActiveOriginal();
        await fixture.finishOriginal(false);
        await fixture.waitForSuccessorInput();
        fixture.expectTerminalAccounting("interrupted");
        const settled = fixture.snapshot();
        expect(settled.originalMaterializedOutput).toBe(false);
        expect(settled.originalAttemptStatus).toBe("interrupted");
        expect(settled.originalTraceStatus).toBe("interrupted");
        const replay = clear ? settled.replacementInputs : settled.oldInputs.slice(1);
        expect(replay).toHaveLength(1);
        expect(replay[0]).toContain(USER_PROMPT);
        expect(replay[0]).toContain(NEXT_PROMPT);
        expect(settled.startedProviders).toEqual(clear ? ["codex"] : []);
        expect(settled.restarts).toEqual(clear ? ["provider_change"] : []);
        expect(settled.assistantReplies).toEqual([]);
      });
    });

    it(`retains legitimate transport recovery before provider handoff (${clear ? "provider clear" : "unchanged config"})`, async () => {
      await withGeneratedClaudeTurn({ terminal: "recoverable", emitAssistant: false }, async (fixture) => {
        if (clear) fixture.clear();
        await fixture.dispatch(NEXT_PROMPT);
        fixture.expectActiveOriginal();
        await fixture.finishOriginal(true);
        fixture.expectTerminalAccounting("interrupted");
        const settled = fixture.snapshot();
        expect(settled.originalMaterializedOutput).toBe(false);
        expect(settled.originalAttemptStatus).toBe("interrupted");
        expect(settled.originalTraceStatus).toBe("interrupted");
        expect(settled.oldInputs).toEqual([USER_PROMPT]);
        expect(settled.replacementInputs).toHaveLength(1);
        expect(settled.replacementInputs[0]).toContain(USER_PROMPT);
        expect(settled.replacementInputs[0]).toContain(NEXT_PROMPT);
        expect(settled.startedProviders).toEqual([clear ? "codex" : "claude"]);
        expect(settled.restarts).toEqual(["provider_transport_failure"]);
        expect(settled.stashedPrompts).toEqual([]);
        expect(settled.assistantReplies).toEqual([]);
      });
    });
  }
});

describe("capacity retry across thread provider configuration", () => {
  for (const configureDuringWait of [false, true]) {
    it(`retains A's retry cohort and sends B to the configured provider (clear ${configureDuringWait ? "during backoff" : "before failure"})`, async () => {
      let activeFixture: GeneratedTurnFixture;
      await withGeneratedClaudeTurn(
        {
          terminal: "capacity",
          emitAssistant: false,
          onCapacityWait: async () => {
            if (configureDuringWait) activeFixture.clear();
          },
        },
        async (fixture) => {
          activeFixture = fixture;
          if (!configureDuringWait) fixture.clear();
          await fixture.dispatch(NEXT_PROMPT);
          await fixture.finishOriginal(false);
          await fixture.waitForOldSuccessor();
          const retrying = fixture.snapshot();
          expect(retrying.oldInputs).toEqual([USER_PROMPT, USER_PROMPT]);
          expect(retrying.replacementInputs).toEqual([]);
          expect(retrying.startedProviders).toEqual([]);
          expect(retrying.originalAttemptStatus).toBe("failed");
          expect(retrying.originalAuthorityReleases).toBe(1);
          expect(retrying.retryBudgets).toEqual([[undefined], [{ startedAt: expect.any(Number), retries: 1 }]]);
          expect(retrying.configuredProvider).toBe("codex");
          expect(retrying.configuredSessionId).toBeNull();
          // The failed old provider must not backfill messages written after
          // configuration cleared its native session state.
          if (!configureDuringWait) expect(retrying.historyProviderSessionIds).not.toContain(PROVIDER_SESSION_AFTER);

          fixture.releaseCapacityRetry();
          await fixture.waitForOldLoop();
          const settled = fixture.snapshot();
          expect(settled.oldInputs).toEqual([USER_PROMPT, USER_PROMPT]);
          expect(settled.replacementInputs).toEqual([expect.stringContaining(NEXT_PROMPT)]);
          expect(settled.replacementInputs[0]).not.toContain(USER_PROMPT);
          expect(settled.startedProviders).toEqual(["codex"]);
          expect(settled.restarts).toEqual(["provider_change"]);
          expect(settled.assistantReplies).toEqual([ASSISTANT_REPLY]);
          expect(settled.originalAuthorityReleases).toBe(2);
          expect(settled.configuredProvider).toBe("codex");
          expect(settled.configuredSessionId).toBeNull();
          expect(settled.stashedPrompts).toEqual([]);
          fixture.expectSuccessorBinding();
        },
      );
    });
  }
});

describe("capacity ownership and persisted provider configuration", () => {
  for (const replaceDuringWait of [false, true]) {
    it(`leaves the replacement intact after ownership changes ${replaceDuringWait ? "during backoff" : "before failure"}`, async () => {
      let activeFixture: GeneratedTurnFixture;
      await withGeneratedClaudeTurn(
        {
          terminal: "capacity",
          emitAssistant: false,
          onCapacityWait: async () => {
            if (replaceDuringWait) {
              activeFixture.clear();
              await activeFixture.replaceOwner();
            }
          },
        },
        async (fixture) => {
          activeFixture = fixture;
          if (!replaceDuringWait) {
            fixture.clear();
            await fixture.replaceOwner();
          }
          await fixture.finishOriginal(true);
          const settled = fixture.snapshot();
          expect(settled.oldInputs).toEqual([USER_PROMPT]);
          expect(settled.replacementInputs).toEqual([expect.stringContaining(NEXT_PROMPT)]);
          expect(settled.replacementOwnsSlot).toBe(true);
          expect(settled.owner).toMatchObject({ provider: "codex", done: false, aborted: false });
          expect(settled.liveSummary).toBe("replacement is active");
          expect(settled.originalAuthorityReleases).toBe(1);
          expect(settled.configuredProvider).toBe("codex");
          expect(settled.configuredSessionId).toBeNull();
          expect(settled.restarts).toEqual([]);
          if (!replaceDuringWait) expect(settled.historyProviderSessionIds).not.toContain(PROVIDER_SESSION_AFTER);
        },
      );
    });
  }

  for (const clearAfterSnapshot of [false, true]) {
    it(`resumes a scheduled retry with saved provider intent after clear ${clearAfterSnapshot ? "after" : "before"} snapshot`, async () => {
      let activeFixture: GeneratedTurnFixture;
      await withGeneratedClaudeTurn(
        {
          terminal: "capacity",
          emitAssistant: false,
          onCapacityWait: async () => {
            await activeFixture.restartFromCapacitySnapshot(clearAfterSnapshot);
          },
        },
        async (fixture) => {
          activeFixture = fixture;
          if (!clearAfterSnapshot) fixture.clear();
          await fixture.dispatch(NEXT_PROMPT);
          await fixture.finishOriginal(true);
          const resumed = fixture.snapshot();
          expect(resumed.originalAttemptStatus).toBe("failed");
          expect(resumed.oldInputs).toEqual([USER_PROMPT]);
          expect(resumed.replacementInputs).toEqual([USER_PROMPT]);
          expect(resumed.startedProviders).toEqual(["codex"]);
          expect(resumed.replacementOwnsSlot).toBe(true);
          expect(resumed.configuredProvider).toBe("codex");
          expect(resumed.configuredSessionId).toBeNull();
          expect(resumed.originalAuthorityReleases).toBe(1);
          expect(resumed.owner?.pendingPrompts).toEqual([USER_PROMPT, expect.stringContaining(NEXT_PROMPT)]);
          expect(resumed.owner?.pendingRetryBudgets).toEqual([
            { startedAt: expect.any(Number), retries: 1 },
            undefined,
          ]);
        },
      );
    });
  }
});

describe("Codex tool delivery cancellation at terminal boundaries", () => {
  for (const terminal of ["complete", "failed", "interrupted", "recoverable"] as const) {
    it(`keeps B dormant after actual Codex tool completion and explicit abort (${terminal})`, async () => {
      await withGeneratedClaudeTurn(
        {
          terminal,
          emitAssistant: false,
          agentDefaultProvider: "claude",
          originalProvider: "codex",
          completeDynamicTool: true,
        },
        async (fixture) => {
          fixture.clear();
          await fixture.dispatch(NEXT_PROMPT);
          fixture.expectActiveOriginal();
          expect(fixture.snapshot()).toMatchObject({
            originalStartedTool: true,
            originalToolResultDeliveryPending: true,
            originalPendingAbort: false,
          });
          // The real host derived this barrier from tool.completed. The default
          // abort call does not inject flags and invokes the actual dispatcher.
          fixture.abortOriginal();
          expect(fixture.snapshot().originalPendingAbort).toBe(true);
          await fixture.finishOriginal(true);
          await fixture.waitForSuccessorSettlement();
          const stopped = fixture.snapshot();
          const acceptedTerminal = terminal === "recoverable" ? "interrupted" : terminal;
          expect(stopped.originalAttemptStatus).toBe(acceptedTerminal);
          expect(stopped.originalTraceStatus).toBe(acceptedTerminal);
          expect(stopped.originalStartedTool).toBe(true);
          expect(stopped.originalDone).toBe(true);
          expect(stopped.oldInputs).toEqual([USER_PROMPT]);
          expect(stopped.startedProviders).toEqual([]);
          expect(stopped.restarts).toEqual([]);
          expect(stopped.replacementInputs).toEqual([]);
          expect(stopped.stashedPrompts).toEqual([expect.stringContaining(NEXT_PROMPT)]);
          expect(stopped.stashedPrompts[0]).not.toContain(USER_PROMPT);

          const later = "Independent later admission C.";
          await fixture.dispatch(later);
          await fixture.waitForSuccessorInput();
          const resumed = fixture.snapshot();
          expect(resumed.startedProviders).toEqual(["claude"]);
          expect(resumed.replacementInputs).toHaveLength(1);
          const combined = resumed.replacementInputs[0]!;
          expect(combined.split(NEXT_PROMPT).length - 1).toBe(1);
          expect(combined.split(later).length - 1).toBe(1);
          expect(combined).not.toContain(USER_PROMPT);
          expect(resumed.oldInputs).toEqual([USER_PROMPT]);
          expect(resumed.stashedPrompts).toEqual([]);
          expect(resumed.restarts).toEqual([]);
        },
      );
    });
  }

  for (const clear of [true, false]) {
    it(`retains actual Codex open-tool recovery without cancellation (${clear ? "provider clear" : "unchanged config"})`, async () => {
      await withGeneratedClaudeTurn(
        {
          terminal: "recoverable",
          recoverableError: PROVIDER_ENDED_WITH_OPEN_TOOLS_USER_MESSAGE,
          emitAssistant: false,
          agentDefaultProvider: "claude",
          originalProvider: "codex",
          completeDynamicTool: true,
        },
        async (fixture) => {
          if (clear) fixture.clear();
          await fixture.dispatch(NEXT_PROMPT);
          fixture.expectActiveOriginal();
          expect(fixture.snapshot()).toMatchObject({
            originalStartedTool: true,
            originalToolResultDeliveryPending: true,
            originalPendingAbort: false,
          });
          await fixture.finishOriginal(true);
          fixture.expectTerminalAccounting("interrupted");
          const settled = fixture.snapshot();
          expect(settled.originalStartedTool).toBe(true);
          expect(settled.originalMaterializedOutput).toBe(false);
          expect(settled.oldInputs).toEqual([USER_PROMPT]);
          expect(settled.replacementInputs).toHaveLength(1);
          const successor = settled.replacementInputs[0]!;
          expect(successor.split(NEXT_PROMPT).length - 1).toBe(1);
          expect(successor).not.toContain(USER_PROMPT);
          expect(settled.startedProviders).toEqual([clear ? "claude" : "codex"]);
          expect(settled.restarts).toEqual(["open_tools_recoverable_failure"]);
          expect(settled.stashedPrompts).toEqual([]);
          expect(settled.assistantReplies).toEqual([]);
        },
      );
    });
  }

  it("preserves B and the accepted failure when emission rejects during a Codex deferred abort", async () => {
    await withGeneratedClaudeTurn(
      {
        terminal: "failed",
        emitAssistant: false,
        agentDefaultProvider: "claude",
        originalProvider: "codex",
        completeDynamicTool: true,
        rejectFailedEmission: true,
      },
      async (fixture) => {
        fixture.clear();
        await fixture.dispatch(NEXT_PROMPT);
        fixture.expectActiveOriginal();
        expect(fixture.snapshot()).toMatchObject({
          originalStartedTool: true,
          originalToolResultDeliveryPending: true,
          originalPendingAbort: false,
        });
        fixture.abortOriginal();
        expect(fixture.snapshot().originalPendingAbort).toBe(true);
        fixture.releaseOriginalTerminal();
        await expect(fixture.waitForOldLoop()).rejects.toThrow("Fixture terminal emission rejected");

        const stopped = fixture.snapshot();
        expect(stopped.originalAttemptStatus).toBe("failed");
        expect(stopped.originalTraceStatus).toBe("failed");
        expect(stopped.originalStartedTool).toBe(true);
        expect(stopped.originalDone).toBe(true);
        expect(stopped.oldInputs).toEqual([USER_PROMPT]);
        expect(stopped.startedProviders).toEqual([]);
        expect(stopped.restarts).toEqual([]);
        expect(stopped.replacementInputs).toEqual([]);
        expect(stopped.stashedPrompts).toEqual([expect.stringContaining(NEXT_PROMPT)]);
        expect(stopped.stashedPrompts[0]).not.toContain(USER_PROMPT);

        const later = "Independent later admission after terminal emission failure.";
        await fixture.dispatch(later);
        await fixture.waitForSuccessorInput();
        const resumed = fixture.snapshot();
        expect(resumed.startedProviders).toEqual(["claude"]);
        expect(resumed.replacementInputs).toHaveLength(1);
        const combined = resumed.replacementInputs[0]!;
        expect(combined.split(NEXT_PROMPT).length - 1).toBe(1);
        expect(combined.split(later).length - 1).toBe(1);
        expect(combined).not.toContain(USER_PROMPT);
        expect(resumed.stashedPrompts).toEqual([]);
        expect(resumed.restarts).toEqual([]);
      },
    );
  });
});

describe("deferred abort versus real tool lease during terminal emission", () => {
  // Ordinary turn.failed clears the lease before emitting its terminal event;
  // these terminals can still have a live lease while the sink awaits.
  for (const terminal of ["complete", "interrupted", "recoverable"] as const) {
    for (const expire of [false, true]) {
      it(`keeps B dormant until C after accepted ${terminal} (lease expiry=${expire})`, async () => {
        await withPausedTerminalLease({ terminal }, async ({ fixture, pause, release, expireLease }) => {
          fixture.clear();
          await fixture.dispatch(NEXT_PROMPT);
          fixture.expectActiveOriginal();
          expect(fixture.snapshot()).toMatchObject({
            originalStartedTool: true,
            originalToolResultDeliveryPending: true,
            originalPendingAbort: false,
          });
          fixture.abortOriginal();
          expect(fixture.snapshot().originalPendingAbort).toBe(true);
          await pause();
          const accepted = fixture.snapshot();
          const acceptedStatus = terminal === "recoverable" ? "interrupted" : terminal;
          expect(accepted.originalAttemptStatus).toBe(acceptedStatus);
          expect(accepted.originalAttemptCompletedAt).not.toBeNull();

          if (expire) expireLease();
          release();
          await fixture.waitForOldLoop();
          if (acceptedStatus !== "complete") fixture.expectTerminalAccounting(acceptedStatus);
          const stopped = fixture.snapshot();
          expect(stopped.originalAttemptStatus).toBe(acceptedStatus);
          expect(stopped.originalTraceStatus).toBe(acceptedStatus);
          expect(stopped.originalAttemptCompletedAt).toBe(accepted.originalAttemptCompletedAt);
          expect(stopped.originalTraceCompletedAt).toBe(accepted.originalAttemptCompletedAt);
          expect(stopped.originalDone).toBe(true);
          expect(stopped.originalPendingAbort).toBe(false);
          expect(stopped.oldInputs).toEqual([USER_PROMPT]);
          expect(stopped.startedProviders).toEqual([]);
          expect(stopped.restarts).toEqual([]);
          expect(stopped.replacementInputs).toEqual([]);
          expect(stopped.stashedPrompts).toEqual([expect.stringContaining(NEXT_PROMPT)]);
          expect(stopped.stashedPrompts[0]).not.toContain(USER_PROMPT);
          expect(stopped.stashedPrompts[0]).not.toContain("Inatividade");

          const later = "Independent admission C after the terminal lease race.";
          await fixture.dispatch(later);
          await fixture.waitForSuccessorInput();
          const resumed = fixture.snapshot();
          expect(resumed.startedProviders).toEqual(["claude"]);
          expect(resumed.replacementInputs).toHaveLength(1);
          const combined = resumed.replacementInputs[0]!;
          expect(combined.split(NEXT_PROMPT).length - 1).toBe(1);
          expect(combined.split(later).length - 1).toBe(1);
          expect(combined).not.toContain(USER_PROMPT);
          expect(combined).not.toContain("Inatividade");
          expect(resumed.oldInputs).toEqual([USER_PROMPT]);
          expect(resumed.stashedPrompts).toEqual([]);
          expect(resumed.restarts).toEqual([]);
          expect(resumed.originalAttemptStatus).toBe(acceptedStatus);
          expect(resumed.originalTraceStatus).toBe(acceptedStatus);
          expect(resumed.originalAttemptCompletedAt).toBe(accepted.originalAttemptCompletedAt);
        });
      });
    }
  }

  for (const expire of [false, true]) {
    it(`retains recovery without explicit abort while the terminal sink awaits (lease expiry=${expire})`, async () => {
      await withPausedTerminalLease({ terminal: "recoverable" }, async ({ fixture, pause, release, expireLease }) => {
        fixture.clear();
        await fixture.dispatch(NEXT_PROMPT);
        fixture.expectActiveOriginal();
        expect(fixture.snapshot().originalPendingAbort).toBe(false);
        await pause();
        const accepted = fixture.snapshot();
        expect(accepted.originalAttemptStatus).toBe("interrupted");
        if (expire) {
          expireLease();
          const recovered = fixture.snapshot();
          expect(recovered.originalDone).toBe(true);
          expect(recovered.stashedPrompts.some((prompt) => prompt.includes("Inatividade"))).toBe(true);
          expect(recovered.stashedPrompts.some((prompt) => prompt.includes(NEXT_PROMPT))).toBe(true);
        }
        release();
        await fixture.waitForOldLoop();
        await fixture.waitForSuccessorInput();
        fixture.expectTerminalAccounting("interrupted");

        const settled = fixture.snapshot();
        expect(settled.originalAttemptStatus).toBe("interrupted");
        expect(settled.originalTraceStatus).toBe("interrupted");
        expect(settled.originalAttemptCompletedAt).toBe(accepted.originalAttemptCompletedAt);
        expect(settled.originalTraceCompletedAt).toBe(accepted.originalAttemptCompletedAt);
        expect(settled.oldInputs).toEqual([USER_PROMPT]);
        expect(settled.startedProviders).toEqual(["claude"]);
        expect(settled.restarts).toHaveLength(1);
        expect(settled.replacementInputs).toHaveLength(1);
        const combined = settled.replacementInputs[0]!;
        expect(combined.split(NEXT_PROMPT).length - 1).toBe(1);
        expect(combined).not.toContain(USER_PROMPT);
        if (!expire) expect(settled.restarts).toEqual(["open_tools_recoverable_failure"]);
        expect(settled.stashedPrompts).toEqual([]);
      });
    });
  }

  it("has already disarmed the real lease when an ordinary failure reaches the terminal sink", async () => {
    await withPausedTerminalLease({ terminal: "failed" }, async ({ fixture, pause, release }) => {
      fixture.clear();
      await fixture.dispatch(NEXT_PROMPT);
      fixture.abortOriginal();
      await pause();
      const accepted = fixture.snapshot();
      expect(accepted.originalAttemptStatus).toBe("failed");
      release();
      await fixture.waitForOldLoop();
      fixture.expectTerminalAccounting("failed");
      const stopped = fixture.snapshot();
      expect(stopped.originalAttemptCompletedAt).toBe(accepted.originalAttemptCompletedAt);
      expect(stopped.originalTraceCompletedAt).toBe(accepted.originalAttemptCompletedAt);
      expect(stopped.oldInputs).toEqual([USER_PROMPT]);
      expect(stopped.startedProviders).toEqual([]);
      expect(stopped.restarts).toEqual([]);
      expect(stopped.replacementInputs).toEqual([]);
      expect(stopped.stashedPrompts).toEqual([expect.stringContaining(NEXT_PROMPT)]);
      expect(stopped.stashedPrompts[0]).not.toContain(USER_PROMPT);
    });
  });

  for (const rejectTerminalEmission of [false, true]) {
    it(`settles an abort admitted after the terminal sink paused (sink rejects=${rejectTerminalEmission})`, async () => {
      await withPausedTerminalLease(
        { terminal: "recoverable", rejectTerminalEmission },
        async ({ fixture, pause, release, expireLease }) => {
          fixture.clear();
          await fixture.dispatch(NEXT_PROMPT);
          await pause();
          const accepted = fixture.snapshot();
          expect(accepted.originalAttemptStatus).toBe("interrupted");
          expect(accepted.originalPendingAbort).toBe(false);
          fixture.abortOriginal();
          expect(fixture.snapshot().originalPendingAbort).toBe(true);
          expireLease();
          release();
          if (rejectTerminalEmission) {
            await expect(fixture.waitForOldLoop()).rejects.toThrow("Fixture paused terminal emission rejected");
          } else await fixture.waitForOldLoop();
          const stopped = fixture.snapshot();
          expect(stopped.originalAttemptStatus).toBe("interrupted");
          expect(stopped.originalTraceStatus).toBe("interrupted");
          expect(stopped.originalAttemptCompletedAt).toBe(accepted.originalAttemptCompletedAt);
          expect(stopped.originalTraceCompletedAt).toBe(accepted.originalAttemptCompletedAt);
          expect(stopped.oldInputs).toEqual([USER_PROMPT]);
          expect(stopped.startedProviders).toEqual([]);
          expect(stopped.restarts).toEqual([]);
          expect(stopped.replacementInputs).toEqual([]);
          expect(stopped.stashedPrompts).toEqual([expect.stringContaining(NEXT_PROMPT)]);
          expect(stopped.stashedPrompts[0]).not.toContain(USER_PROMPT);
          expect(stopped.stashedPrompts[0]).not.toContain("Inatividade");

          const later = "Independent C after an abort admitted during terminal emission.";
          await fixture.dispatch(later);
          await fixture.waitForSuccessorInput();
          const resumed = fixture.snapshot();
          expect(resumed.startedProviders).toEqual(["claude"]);
          expect(resumed.replacementInputs).toHaveLength(1);
          const combined = resumed.replacementInputs[0]!;
          expect(combined.split(NEXT_PROMPT).length - 1).toBe(1);
          expect(combined.split(later).length - 1).toBe(1);
          expect(combined).not.toContain(USER_PROMPT);
          expect(combined).not.toContain("Inatividade");
          expect(resumed.stashedPrompts).toEqual([]);
          expect(resumed.restarts).toEqual([]);
        },
      );
    });
  }

  it("leaves the replacement and stash untouched when the old lease expires during terminal emission", async () => {
    await withPausedTerminalLease(
      { terminal: "recoverable", rejectModelSwitch: true },
      async ({ fixture, pause, release, expireLease }) => {
        await fixture.dispatch(NEXT_PROMPT);
        fixture.abortOriginal();
        await pause();
        const accepted = fixture.snapshot();
        // Exercise the real dispatcher takeover after the physical delivery
        // has terminalized, while its host still awaits the runtime sink.
        expect(await fixture.changeModel("gpt-6.1")).toBe("restart-next-turn");
        await fixture.waitForSuccessorInput();
        const replacement = fixture.snapshot();
        expect(replacement.replacementOwnsSlot).toBe(true);
        expect(replacement.startedProviders).toEqual(["codex"]);
        expect(replacement.replacementInputs).toEqual([expect.stringContaining(NEXT_PROMPT)]);
        expect(replacement.stashedPrompts).toEqual([]);
        expect(replacement.owner).toMatchObject({ done: false, aborted: false, pendingAbort: false });

        expireLease();
        expect(fixture.snapshot().owner).toEqual(replacement.owner);
        expect(fixture.snapshot().stashedPrompts).toEqual(replacement.stashedPrompts);
        release();
        await fixture.waitForOldLoop();
        const settled = fixture.snapshot();
        expect(settled.owner).toEqual(replacement.owner);
        expect(settled.replacementOwnsSlot).toBe(true);
        expect(settled.replacementInputs).toEqual(replacement.replacementInputs);
        expect(settled.startedProviders).toEqual(replacement.startedProviders);
        expect(settled.stashedPrompts).toEqual(replacement.stashedPrompts);
        expect(settled.restarts).toEqual([]);
        expect(settled.originalAttemptStatus).toBe("interrupted");
        expect(settled.originalTraceStatus).toBe("interrupted");
        expect(settled.originalAttemptCompletedAt).toBe(accepted.originalAttemptCompletedAt);
        expect(settled.originalTraceCompletedAt).toBe(accepted.originalAttemptCompletedAt);
        expect(settled.replacementInputs[0]!.split(NEXT_PROMPT).length - 1).toBe(1);
        expect(settled.replacementInputs[0]).not.toContain(USER_PROMPT);
      },
    );
  });
});

async function withPausedTerminalLease(
  options: Pick<GeneratedTurnOptions, "terminal" | "rejectModelSwitch" | "rejectTerminalEmission">,
  run: (controls: {
    fixture: GeneratedTurnFixture;
    pause(): Promise<void>;
    release(): void;
    expireLease(): void;
  }) => Promise<void>,
) {
  const entered = deferred();
  const released = deferred();
  let emissionSeen = false;
  let expiry: (() => void) | undefined;
  const scheduled: Array<{ callback: () => void; delay: number }> = [];
  const createRealLease = toolLiveness.createToolLivenessLease;
  // Replace only the clock. Generation fencing, progress rearming, the host's
  // onInactive callback and dispatcher abort all execute their real code.
  const leaseFactory = spyOn(toolLiveness, "createToolLivenessLease").mockImplementation((leaseOptions) =>
    createRealLease({
      ...leaseOptions,
      schedule: (callback, delay) => {
        scheduled.push({ callback, delay });
        expiry = callback;
        return () => {
          if (expiry === callback) expiry = undefined;
        };
      },
    }),
  );
  try {
    await withGeneratedClaudeTurn(
      {
        ...options,
        emitAssistant: false,
        agentDefaultProvider: "claude",
        originalProvider: "codex",
        completeDynamicTool: true,
        toolProgressBeforeCompletion: true,
        recoverableError: PROVIDER_ENDED_WITH_OPEN_TOOLS_USER_MESSAGE,
        onTerminalEmission: async () => {
          if (emissionSeen) return;
          emissionSeen = true;
          entered.resolve();
          await released.promise;
          if (options.rejectTerminalEmission) throw new Error("Fixture paused terminal emission rejected");
        },
      },
      async (fixture) => {
        try {
          await run({
            fixture,
            pause: async () => {
              fixture.releaseOriginalTerminal();
              await entered.promise;
              expect(scheduled).toHaveLength(2);
              expect(scheduled.every(({ delay }) => delay > 0)).toBe(true);
              if (options.terminal === "failed") expect(expiry).toBeUndefined();
              else expect(expiry).toBeDefined();
              const beforeStaleExpiry = fixture.snapshot();
              scheduled[0]!.callback();
              if (options.terminal === "failed") scheduled[1]!.callback();
              expect(fixture.snapshot()).toEqual(beforeStaleExpiry);
            },
            release: released.resolve,
            expireLease: () => {
              expect(expiry).toBeDefined();
              const fire = expiry!;
              expiry = undefined;
              fire();
            },
          });
        } finally {
          released.resolve();
        }
      },
    );
  } finally {
    released.resolve();
    leaseFactory.mockRestore();
  }
}

interface GeneratedTurnOptions {
  terminal?: "complete" | "failed" | "interrupted" | "recoverable" | "capacity";
  deliveryBarrier?: "after_response" | "after_task";
  activeTaskBarrier?: boolean;
  emitAssistant?: boolean;
  agentDefaultProvider?: "claude" | "codex";
  pausePricing?: boolean;
  onCapacityWait?: () => Promise<void>;
  rejectModelSwitch?: boolean;
  originalProvider?: "claude" | "codex";
  completeDynamicTool?: boolean;
  recoverableError?: string;
  rejectFailedEmission?: boolean;
  toolProgressBeforeCompletion?: boolean;
  onTerminalEmission?: () => Promise<void>;
  rejectTerminalEmission?: boolean;
}

interface GeneratedTurnFixture {
  clear(): void;
  abortOriginal(deferred?: boolean): void;
  changeModel(model: string): ReturnType<RuntimeSessionDispatcher["applySessionModelChange"]>;
  dispatch(prompt: string): Promise<void>;
  expectActiveOriginal(): void;
  expectCompletionAccounting(): void;
  expectTerminalAccounting(status: "complete" | "failed" | "interrupted"): void;
  expectTaskBlocked(): void;
  expectSuccessorBinding(): void;
  releaseTaskBarrier(): Promise<void>;
  finishOriginal(expectRetired: boolean): Promise<void>;
  waitForOldSuccessor(): Promise<void>;
  waitForSuccessorSettlement(): Promise<void>;
  waitForSuccessorInput(): Promise<void>;
  releaseOriginalTerminal(): void;
  releaseCapacityRetry(): void;
  replaceOwner(): Promise<void>;
  restartFromCapacitySnapshot(clearAfterSnapshot: boolean): Promise<void>;
  waitForPricing(): Promise<void>;
  releasePricing(): void;
  waitForOldLoop(): Promise<void>;
  snapshot(): {
    originalAttemptStatus: string | undefined;
    originalTraceStatus: string | undefined;
    originalAttemptCompletedAt: number | null | undefined;
    originalTraceCompletedAt: number | null | undefined;
    originalMaterializedOutput: boolean | undefined;
    originalStartedTool: boolean | undefined;
    originalToolResultDeliveryPending: boolean;
    originalPendingAbort: boolean;
    originalAuthorityReleases: number;
    retryBudgets: Array<Array<{ startedAt: number; retries: number } | undefined>>;
    configuredProvider: string | null;
    configuredSessionId: string | null;
    historyProviderSessionIds: Array<string | null>;
    liveSummary: string | undefined;
    originalDone: boolean;
    oldInputs: string[];
    replacementInputs: string[];
    startedProviders: string[];
    stashedPrompts: string[];
    restarts: string[];
    assistantReplies: string[];
    replacementOwnsSlot: boolean;
    modelSwitchCalls: string[];
    owner: {
      provider: string;
      done: boolean;
      aborted: boolean;
      pendingAbort: boolean;
      attemptId: string | undefined;
      pendingPrompts: string[];
      pendingRetryBudgets: Array<{ startedAt: number; retries: number } | undefined>;
    } | null;
  };
}

async function withGeneratedClaudeTurn(
  options: GeneratedTurnOptions,
  run: (fixture: GeneratedTurnFixture) => Promise<void>,
) {
  let { parent, child } = await seedThread(true, options);
  const originalProvider = options.originalProvider ?? "claude";
  const originalModel = originalProvider === "codex" ? "gpt-6-astra" : "opus";
  if (originalProvider === "codex") {
    configureSlackThreadRuntime(
      { parentSession: parent, ref: REQUEST_ID, provider: originalProvider, model: originalModel },
      () => {},
    );
    updateRuntimeProviderState(child.sessionKey, originalProvider, {
      providerSessionId: "codex-before-configuration",
      runtimeSessionDisplayId: "codex-before-configuration",
      runtimeSessionParams: { sessionId: "codex-before-configuration" },
    });
    child = getSession(child.sessionKey)!;
  }
  const sessionName = child.name!;
  configStore.refresh();
  const recovery = new RuntimeCrashRecoveryCoordinator({ instanceId: "generated-provider-config" });
  recovery.start();
  const dispatcher = new RuntimeSessionDispatcher({
    instanceId: "generated-provider-config",
    maxConcurrentSessions: 2,
    interactiveReservedSessions: 0,
    safeEmit: async () => {},
    notifyRuntimeRecoveryExhausted: async () => {},
    getConfigModel: () => "gpt-6-astra",
    crashRecovery: recovery,
  });
  const active = deferred();
  const terminalAllowed = deferred();
  const terminalProcessed = deferred();
  const capacityRetryAllowed = deferred();
  const oldSuccessor = deferred();
  const replacementConsumed = deferred();
  const generatorWaiting = deferred();
  const finishConsumer = deferred();
  const costEntered = deferred();
  const costReleased = deferred();
  const oldInputs: string[] = [];
  const replacementInputs: string[] = [];
  const startedProviders: string[] = [];
  const restarts: string[] = [];
  const modelSwitchCalls: string[] = [];
  const replacementConsumers: Promise<void>[] = [];
  const blockerTask = options.activeTaskBarrier
    ? dbCreateTask({ title: "Hold the successor until task completion", instructions: "Keep the task barrier active" })
        .task
    : undefined;
  const successorTask = options.activeTaskBarrier
    ? dbCreateTask({ title: "Successor task context", instructions: "Preserve this independent task envelope" }).task
    : undefined;
  if (blockerTask) {
    dbDispatchTask(blockerTask.id, { agentId: AGENT_ID, sessionName, assignedBy: "test" });
  }
  const replacements: Array<{
    streaming: RuntimeHostStreamingSession;
    prompts: ReturnType<typeof createRuntimeMessageGenerator>;
  }> = [];
  let turnCounter = 0;
  let originalTurnId: string | undefined;
  let originalAttemptId: string | undefined;
  let originalAuthorityReleases = 0;
  let capacityNow = Date.now();
  const retryBudgets: Array<Array<{ startedAt: number; retries: number } | undefined>> = [];

  const newStreaming = (
    provider: string,
    model: string,
    messages: RuntimeUserMessage[],
    revision: number,
  ): RuntimeHostStreamingSession => {
    let pushMessage: RuntimeHostStreamingSession["pushMessage"] = null;
    return {
      sessionKey: child.sessionKey,
      agentId: AGENT_ID,
      queryHandle: { provider, events: (async function* () {})(), interrupt: mock(async () => {}) },
      runtimeProviderConfigRevision: revision,
      starting: false,
      abortController: new AbortController(),
      get pushMessage() {
        return pushMessage;
      },
      set pushMessage(value) {
        pushMessage = value;
        // Observe the real generator's empty/non-deliverable queue boundary.
        if (value) generatorWaiting.resolve();
      },
      pendingWake: false,
      pendingMessages: messages,
      currentModel: model,
      toolRunning: false,
      lastActivity: Date.now(),
      done: false,
      interrupted: false,
      turnActive: false,
      compacting: false,
      onTurnComplete: null,
      currentToolSafety: null,
      pendingAbort: false,
      agentMode: "sentinel",
      traceRunId: "generated-provider-config-run",
      toolEffectFence: "host_write_ahead",
    };
  };
  const original = newStreaming(
    originalProvider,
    originalModel,
    [createQueuedRuntimeUserMessage({ prompt: USER_PROMPT, deliveryBarrier: "after_response" })],
    child.runtimeProviderConfigRevision ?? 0,
  );
  const makePrompts = (streaming: RuntimeHostStreamingSession) =>
    createRuntimeMessageGenerator({
      sessionName,
      session: streaming,
      stashedMessages: dispatcher.stashedMessages,
      afterTurnEnd: () => {
        if (streaming === original) originalAuthorityReleases++;
      },
      traceTurnStart: ({ combinedPrompt, deliverableMessages }) => {
        const turnId = `generated-provider-turn-${++turnCounter}`;
        const trace = recordAdapterRequestTrace({
          sessionKey: child.sessionKey,
          sessionName,
          agentId: AGENT_ID,
          runId: streaming.traceRunId,
          turnId,
          provider: streaming.queryHandle.provider,
          model: streaming.currentModel,
          prompt: combinedPrompt,
          systemPrompt: "Investigate the current thread.",
          cwd: stateDir!,
          resume: streaming === original,
          fork: false,
          hasHooks: false,
          pluginNames: [],
          mcpServerNames: [],
          hasRemoteSpawn: false,
        })!;
        const attempt = recovery.startTurnAttempt({
          turnId,
          runId: streaming.traceRunId!,
          sessionKey: child.sessionKey,
          sessionName,
          agentId: AGENT_ID,
          provider: streaming.queryHandle.provider,
          model: streaming.currentModel,
          requestBlobSha256: trace.requestBlobSha256,
          startedAt: trace.startedAt,
          originKind: "human",
          deliveryBarrier: deliverableMessages[0]?.deliveryBarrier ?? "after_response",
          taskBarrierTaskId: deliverableMessages[0]?.taskBarrierTaskId,
          pendingIds: deliverableMessages.map(({ pendingId }) => pendingId!),
        });
        if (!originalAttemptId && streaming === original) {
          originalTurnId = turnId;
          originalAttemptId = attempt.attemptId;
        }
        return { ...trace, crashRecoveryAttemptId: attempt.attemptId };
      },
    });
  const originalPrompts = makePrompts(original);
  const interrupt = mock(async () => {});
  const originalHandle: RuntimeSessionHandle = {
    provider: originalProvider,
    events: (async function* (): AsyncGenerator<RuntimeEvent> {
      for await (const prompt of originalPrompts) {
        oldInputs.push(String(prompt.message.content));
        retryBudgets.push(
          original.pendingMessages
            .filter((message) => original.currentTurnPendingIds?.includes(message.pendingId!))
            .map((message) => message.providerCapacityRetry && { ...message.providerCapacityRetry }),
        );
        if (oldInputs.length === 2 && options.terminal === "capacity") {
          oldSuccessor.resolve();
          await capacityRetryAllowed.promise;
          yield { type: "assistant.message", text: ASSISTANT_REPLY };
          yield {
            type: "turn.complete",
            providerSessionId: PROVIDER_SESSION_AFTER,
            session: { displayId: PROVIDER_SESSION_AFTER, params: { sessionId: PROVIDER_SESSION_AFTER } },
            usage: { inputTokens: 10, outputTokens: 4 },
          };
          continue;
        }
        if (oldInputs.length > 1) {
          oldSuccessor.resolve();
          await finishConsumer.promise;
          return;
        }
        // Wrap the real generator's completion callback: the host must release
        // that exact handoff before it can drain A or yield the successor.
        const generatorCompleted = original.onTurnComplete!;
        original.onTurnComplete = () => {
          generatorCompleted();
          terminalProcessed.resolve();
        };
        if (options.emitAssistant !== false) yield { type: "assistant.message", text: ASSISTANT_REPLY };
        if (options.completeDynamicTool) {
          // Canonical adapter events exercise durable tool authorization and
          // Codex's result-delivery barrier without executing a tool/provider.
          yield {
            type: "tool.started",
            toolUse: { id: "generated-dynamic-tool", name: "Bash", input: { cmd: "fixture-no-execution" } },
          };
          if (options.toolProgressBeforeCompletion) {
            yield { type: "tool.progress", toolUseId: "generated-dynamic-tool" };
          }
          yield {
            type: "tool.completed",
            toolUseId: "generated-dynamic-tool",
            toolName: "Bash",
            content: "fixture result",
            metadata: { item: { type: "dynamic_tool_call" } },
          };
        }
        active.resolve();
        await terminalAllowed.promise;
        if (options.terminal === "capacity") {
          yield {
            type: "turn.failed",
            error: "Selected model is at capacity. Please try a different model.",
            rawEvent: { status: 503 },
            preExecutionRejected: true,
            providerSessionId: PROVIDER_SESSION_AFTER,
            session: { displayId: PROVIDER_SESSION_AFTER, params: { sessionId: PROVIDER_SESSION_AFTER } },
            usage: { inputTokens: 10, outputTokens: 4 },
          };
          if (!original.interrupted) return;
        } else if (options.terminal === "failed") {
          yield {
            type: "turn.failed",
            error: "Generic nonrecoverable provider failure",
            recoverable: false,
            usage: { inputTokens: 10, outputTokens: 4 },
          };
        } else if (options.terminal === "interrupted") {
          yield { type: "turn.interrupted", usage: { inputTokens: 10, outputTokens: 4 } };
        } else if (options.terminal === "recoverable") {
          yield {
            type: "turn.failed",
            error: options.recoverableError ?? "Provider transport disconnected before any output",
            recoverable: true,
            failureKind: "transport",
            usage: { inputTokens: 10, outputTokens: 4 },
          };
        } else {
          yield {
            type: "turn.complete",
            providerSessionId: PROVIDER_SESSION_AFTER,
            session: { displayId: PROVIDER_SESSION_AFTER, params: { sessionId: PROVIDER_SESSION_AFTER } },
            usage: { inputTokens: 10, outputTokens: 4 },
          };
        }
      }
    })(),
    interrupt,
    close: mock(async () => {}),
    ...(options.rejectModelSwitch
      ? {
          setModel: async (model: string) => {
            modelSwitchCalls.push(model);
            throw new Error("Provider rejected the live model switch");
          },
        }
      : {}),
  };
  original.queryHandle = originalHandle;
  dispatcher.streamingSessions.set(sessionName, original);
  saveMessage(sessionName, "user", USER_PROMPT, child.providerSessionId);
  const costGate = options.pausePricing
    ? spyOn(pricing, "calculateCost").mockImplementation(async () => {
        costEntered.resolve();
        await costReleased.promise;
        return { inputCost: 0.01, outputCost: 0.02, cacheCost: 0, totalCost: 0.03, pricingStatus: "priced" };
      })
    : undefined;
  const start = spyOn(dispatcher, "startStreamingSession").mockImplementation(async (name, prompt) => {
    const resolved = resolveRuntimeSession({ sessionName: name, prompt, defaultRuntimeProviderId: "codex" });
    if (!resolved) throw new Error("Replacement session was not resolved");
    startedProviders.push(resolved.runtimeProviderId);
    if (!prompt._resumeStashedMessages) saveMessage(name, "user", prompt.prompt);
    const replacement = newStreaming(
      resolved.runtimeProviderId,
      resolved.session.modelOverride ?? (resolved.runtimeProviderId === "claude" ? "opus" : "gpt-6-astra"),
      prompt._resumeStashedMessages ? [] : [createQueuedRuntimeUserMessage(prompt)],
      resolved.session.runtimeProviderConfigRevision ?? 0,
    );
    dispatcher.streamingSessions.set(name, replacement);
    const prompts = makePrompts(replacement);
    replacements.push({ streaming: replacement, prompts });
    const consume = prompts.next().then((next) => {
      if (next.done) return;
      replacementInputs.push(String(next.value.message.content));
      replacementConsumed.resolve();
    });
    replacementConsumers.push(consume);
    // An active task can legitimately keep the new provider waiting. Starting
    // that handle must not wait for input and deadlock the old host's cleanup.
    if (!options.activeTaskBarrier) await consume;
  });
  const loop = runRuntimeEventLoop({
    runId: original.traceRunId!,
    sessionName,
    session: child,
    agent: dbGetAgent(AGENT_ID)!,
    streaming: original,
    runtimeSession: originalHandle,
    runtimeCapabilities: createRuntimeProvider(originalProvider).getCapabilities(),
    model: originalModel,
    instanceId: "generated-provider-config",
    defaultRuntimeProviderId: "codex",
    streamingSessions: dispatcher.streamingSessions,
    stashedMessages: dispatcher.stashedMessages,
    safeEmit: async (topic, event) => {
      if (
        options.onTerminalEmission &&
        topic.endsWith(".runtime") &&
        typeof event.type === "string" &&
        ["turn.complete", "turn.failed", "turn.interrupted"].includes(event.type)
      ) {
        await options.onTerminalEmission();
      }
      if (options.rejectFailedEmission && topic.endsWith(".runtime") && event.type === "turn.failed") {
        throw new Error("Fixture terminal emission rejected");
      }
    },
    drainPendingStarts: () => {},
    crashRecovery: recovery,
    capacityRetryRuntime: {
      now: () => capacityNow,
      random: () => 0,
      wait: async (delayMs) => {
        capacityNow += delayMs;
        await options.onCapacityWait?.();
      },
    },
    restartStashedSession: async ({ reason }) => {
      restarts.push(reason);
      await dispatcher.handlePromptImmediate(sessionName, {
        prompt: "",
        _agentId: AGENT_ID,
        _resumeStashedMessages: true,
        deliveryBarrier: "after_response",
      });
    },
  });
  const waitFor = (gate: ReturnType<typeof deferred>) =>
    Promise.race([
      gate.promise,
      loop.then(() => {
        throw new Error("Original loop ended before the expected generator boundary");
      }),
    ]);
  try {
    await waitFor(active);
    await run({
      clear: () => {
        configureSlackThreadRuntime(
          { parentSession: parent, ref: REQUEST_ID, provider: "clear", model: "clear" },
          () => {},
        );
      },
      abortOriginal: (deferredAbort = false) => {
        if (deferredAbort) original.toolResultDeliveryPending = true;
        expect(dispatcher.abortSession(sessionName, { reason: "explicit_abort" })).toBe(true);
        if (deferredAbort) expect(original.pendingAbort).toBe(true);
      },
      changeModel: (model) => {
        configureSlackThreadRuntime({ parentSession: parent, ref: REQUEST_ID, model }, () => {});
        return dispatcher.applySessionModelChange(sessionName, model, { restartStashedMessages: true });
      },
      dispatch: (prompt) =>
        dispatcher.handlePromptImmediate(sessionName, {
          prompt,
          _agentId: AGENT_ID,
          deliveryBarrier: options.deliveryBarrier ?? "after_response",
          deliveryBarrierSource: "default",
          taskBarrierTaskId: successorTask?.id,
        }),
      expectActiveOriginal: () => {
        expect(original.turnActive).toBe(true);
        expect(original.done).toBe(false);
        expect(original.abortController.signal.aborted).toBe(false);
        expect(interrupt).not.toHaveBeenCalled();
        expect(getRuntimeTurnAttempt(originalAttemptId!)?.status).toBe("running");
        expect(dispatcher.streamingSessions.get(sessionName)).toBe(original);
      },
      expectCompletionAccounting: () => {
        expect(getSession(child.sessionKey)).toMatchObject({ inputTokens: 10, outputTokens: 4, totalTokens: 14 });
        expect(dbGetCostForSession(child.sessionKey)).toMatchObject({
          total_input: 10,
          total_output: 4,
          total_cost: 0.03,
          turns: 1,
        });
        expect(getSessionTurn(originalTurnId!)).toMatchObject({
          status: "complete",
          provider: originalProvider,
          model: originalModel,
          inputTokens: 10,
          outputTokens: 4,
          costUsd: 0.03,
        });
      },
      expectTerminalAccounting: (status) => {
        const attempt = getRuntimeTurnAttempt(originalAttemptId!)!;
        const trace = getSessionTurn(originalTurnId!)!;
        expect(attempt.status).toBe(status);
        expect(trace).toMatchObject({
          status,
          provider: originalProvider,
          model: originalModel,
          inputTokens: 10,
          outputTokens: 4,
          completedAt: attempt.completedAt,
          costUsd: status === "complete" ? 0.03 : null,
        });
        expect(attempt.completedAt).not.toBeNull();
        if (status === "complete") {
          expect(getSession(child.sessionKey)).toMatchObject({ inputTokens: 10, outputTokens: 4, totalTokens: 14 });
          expect(dbGetCostForSession(child.sessionKey)).toMatchObject({
            total_input: 10,
            total_output: 4,
            total_cost: 0.03,
            turns: 1,
          });
        } else {
          // Failed/interrupted usage remains trace evidence; this change must
          // not fabricate the successful turn's session/cost accounting.
          expect(getSession(child.sessionKey)).toMatchObject({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
          expect(dbGetCostForSession(child.sessionKey)).toMatchObject({ total_cost: 0, turns: 0 });
        }
      },
      expectTaskBlocked: () => {
        expect(blockerTask).toBeDefined();
        expect(dbHasActiveTaskForSession(sessionName, successorTask!.id)).toBe(true);
        expect(oldInputs).toEqual([USER_PROMPT]);
        expect(replacementInputs).toEqual([]);
        const owner = dispatcher.streamingSessions.get(sessionName)!;
        expect(owner.turnActive).toBe(false);
        expect(owner.pushMessage).not.toBeNull();
        expect(owner.pendingMessages).toEqual([
          expect.objectContaining({
            message: { role: "user", content: expect.stringContaining(NEXT_PROMPT) },
            deliveryBarrier: "after_task",
            taskBarrierTaskId: successorTask!.id,
          }),
        ]);
      },
      expectSuccessorBinding: () => {
        const owner = dispatcher.streamingSessions.get(sessionName)!;
        const pending = owner.pendingMessages.find((message) => String(message.message.content).includes(NEXT_PROMPT))!;
        expect(pending).toBeDefined();
        const attempt = getRuntimeTurnAttempt(owner.currentCrashRecoveryAttemptId!)!;
        expect(attempt).toMatchObject({
          status: "running",
          provider: owner.queryHandle.provider,
          deliveryBarrier: options.deliveryBarrier ?? "after_response",
          taskBarrierTaskId: successorTask?.id ?? null,
          pendingIds: [pending.pendingId],
        });
        expect(attempt.attemptId).not.toBe(originalAttemptId);
      },
      releaseTaskBarrier: async () => {
        if (!blockerTask) throw new Error("No active task barrier in this fixture");
        dbCompleteTask(blockerTask.id, { actor: "test", agentId: AGENT_ID, sessionName, message: "done" });
        expect(dbHasActiveTaskForSession(sessionName, successorTask!.id)).toBe(false);
        dispatcher.wakeStreamingSessionIfDeliverable(sessionName);
        await dispatcher.startDeferredAfterTaskSessionIfDeliverable(sessionName);
      },
      finishOriginal: async (expectRetired) => {
        terminalAllowed.resolve();
        await terminalProcessed.promise;
        if (expectRetired) await loop;
      },
      waitForOldSuccessor: () => waitFor(oldSuccessor),
      waitForSuccessorSettlement: () => Promise.race([oldSuccessor.promise, generatorWaiting.promise, loop]),
      waitForSuccessorInput: () => Promise.race([oldSuccessor.promise, replacementConsumed.promise]),
      releaseOriginalTerminal: terminalAllowed.resolve,
      releaseCapacityRetry: capacityRetryAllowed.resolve,
      replaceOwner: async () => {
        // Simulate another launcher taking the slot while this old event loop
        // is still settling feedback; deliberately leave the old flags alone.
        await dispatcher.startStreamingSession(sessionName, { prompt: NEXT_PROMPT, _agentId: AGENT_ID });
        updateRuntimeLiveState(sessionName, {
          activity: "thinking",
          summary: "replacement is active",
          provider: "codex",
        });
      },
      restartFromCapacitySnapshot: async (clearAfterSnapshot) => {
        const restartEpoch = "capacity-provider-configuration";
        dbUpsertDaemonRestartEpoch({ restartEpoch, reason: "test", createdAt: Date.now() });
        expect(dispatcher.recordDaemonRestartSnapshot({ restartEpoch, reason: "test" })).toBe(1);
        expect(original.capacityRetrySnapshotSaved).toBe(true);
        if (clearAfterSnapshot) {
          configureSlackThreadRuntime(
            { parentSession: parent, ref: REQUEST_ID, provider: "clear", model: "clear" },
            () => {},
          );
        }
        dispatcher.shutdownAll();
        await dispatcher.handlePromptImmediate(sessionName, {
          ...buildDaemonRestartResumePrompt({
            restartEpoch,
            reason: "test",
            sessionKey: child.sessionKey,
            runtimeProvider: originalProvider,
            mode: "pending_only",
          }),
          _agentId: AGENT_ID,
        });
      },
      waitForPricing: () => waitFor(costEntered),
      releasePricing: costReleased.resolve,
      waitForOldLoop: () => loop,
      snapshot: () => ({
        originalAttemptStatus: getRuntimeTurnAttempt(originalAttemptId!)?.status,
        originalTraceStatus: getSessionTurn(originalTurnId!)?.status,
        originalAttemptCompletedAt: getRuntimeTurnAttempt(originalAttemptId!)?.completedAt,
        originalTraceCompletedAt: getSessionTurn(originalTurnId!)?.completedAt,
        originalMaterializedOutput: getRuntimeTurnAttempt(originalAttemptId!)?.materializedOutput,
        originalStartedTool: getRuntimeTurnAttempt(originalAttemptId!)?.startedTool,
        originalToolResultDeliveryPending: original.toolResultDeliveryPending === true,
        originalPendingAbort: original.pendingAbort,
        originalAuthorityReleases,
        retryBudgets,
        configuredProvider: getSession(child.sessionKey)?.runtimeProvider ?? null,
        configuredSessionId: getSession(child.sessionKey)?.providerSessionId ?? null,
        historyProviderSessionIds: getRecentHistory(sessionName).map((message) => message.provider_session_id ?? null),
        liveSummary: getRuntimeLiveState(sessionName)?.summary,
        originalDone: original.done,
        oldInputs: [...oldInputs],
        replacementInputs: [...replacementInputs],
        startedProviders: [...startedProviders],
        stashedPrompts: (dispatcher.stashedMessages.get(sessionName) ?? []).map((message) =>
          String(message.message.content),
        ),
        restarts: [...restarts],
        assistantReplies: getRecentHistory(sessionName)
          .filter(({ role }) => role === "assistant")
          .map(({ content }) => content),
        replacementOwnsSlot: replacements.some(
          ({ streaming }) => dispatcher.streamingSessions.get(sessionName) === streaming,
        ),
        modelSwitchCalls: [...modelSwitchCalls],
        owner: (() => {
          const owner = dispatcher.streamingSessions.get(sessionName);
          return owner
            ? {
                provider: owner.queryHandle.provider,
                done: owner.done,
                aborted: owner.abortController.signal.aborted,
                pendingAbort: owner.pendingAbort,
                attemptId: owner.currentCrashRecoveryAttemptId,
                pendingPrompts: owner.pendingMessages.map((message) => String(message.message.content)),
                pendingRetryBudgets: owner.pendingMessages.map((message) => message.providerCapacityRetry),
              }
            : null;
        })(),
      }),
    });
  } finally {
    terminalAllowed.resolve();
    capacityRetryAllowed.resolve();
    costReleased.resolve();
    finishConsumer.resolve();
    original.done = true;
    original.abortController.abort();
    original.onTurnComplete?.();
    original.pushMessage?.(null);
    if (options.rejectFailedEmission || options.rejectTerminalEmission) await loop.catch(() => {});
    else await loop;
    start.mockRestore();
    costGate?.mockRestore();
    dispatcher.shutdownAll();
    await Promise.all(replacementConsumers);
    for (const { prompts } of replacements) await prompts.return(undefined);
    await originalPrompts.return(undefined);
    if (recovery.acceptingDeliveries) recovery.stopGracefully("test_cleanup");
  }
}

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
    sessionKey: child.sessionKey,
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
