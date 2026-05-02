import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { dbCreateAgent } from "../router/router-db.js";
import { getOrCreateSession } from "../router/index.js";
import { dbCreateTagDefinition, dbUpsertTagBinding } from "../tags/index.js";
import {
  createObservationEvent,
  dbListObserverBindings,
  dbUpsertObserverRule,
  deliverObservationEvents,
  ensureObserverBindingsForSession,
  explainObserverRulesForSession,
  getObservationDebounceMs,
  setObservationPromptPublisherForTests,
} from "./observation-plane.js";

let stateDir: string | null = null;
const publishedPrompts: Array<{
  sessionName: string;
  payload: Record<string, unknown>;
}> = [];

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("observation-plane-");
  publishedPrompts.length = 0;
  setObservationPromptPublisherForTests(async (sessionName, payload) => {
    publishedPrompts.push({ sessionName, payload });
  });
  dbCreateAgent({ id: "worker", cwd: "/tmp/worker" });
  dbCreateAgent({ id: "observer", cwd: "/tmp/observer" });
});

afterEach(async () => {
  setObservationPromptPublisherForTests();
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

describe("Observation Plane", () => {
  it("creates one idempotent observer binding for a matched agent rule", () => {
    const session = getOrCreateSession("source-session", "worker", "/tmp/worker", { name: "source-session" });
    dbUpsertObserverRule({
      id: "task-progress",
      scope: "agent",
      sourceAgentId: "worker",
      observerAgentId: "observer",
      observerRole: "task-progress",
      observerMode: "summarize",
      eventTypes: ["message.user", "turn.complete"],
    });

    const first = ensureObserverBindingsForSession({
      sessionName: "source-session",
      session,
    });
    const second = ensureObserverBindingsForSession({
      sessionName: "source-session",
      session,
    });

    expect(first.created).toHaveLength(1);
    expect(first.bindings[0]).toMatchObject({
      sourceSessionKey: "source-session",
      observerAgentId: "observer",
      observerRole: "task-progress",
    });
    expect(second.created).toHaveLength(0);
    expect(dbListObserverBindings({ sourceSessionKey: "source-session" })).toHaveLength(1);
  });

  it("matches inherited tag-scoped rules against source agent tags", () => {
    const tag = dbCreateTagDefinition({
      slug: "quality-watch",
      label: "Quality Watch",
    });
    dbUpsertTagBinding({
      slug: tag.slug,
      assetType: "agent",
      assetId: "worker",
    });
    const session = getOrCreateSession("tagged-source", "worker", "/tmp/worker", { name: "tagged-source" });
    dbUpsertObserverRule({
      id: "quality",
      scope: "tag",
      tagTargetType: "agent",
      tagSlug: tag.slug,
      tagInherited: true,
      observerAgentId: "observer",
      observerRole: "quality",
      observerMode: "summarize",
    });

    const result = ensureObserverBindingsForSession({
      sessionName: "tagged-source",
      session,
    });
    const explanation = explainObserverRulesForSession("tagged-source");

    expect(result.created).toHaveLength(1);
    expect(result.bindings[0]?.eventTypes).toEqual([
      "message.assistant",
      "message.user",
      "turn.complete",
      "turn.failed",
      "turn.interrupt",
    ]);
    expect(explanation.source?.tags).toContainEqual({
      targetType: "agent",
      slug: "quality-watch",
      assetId: "worker",
      inherited: true,
    });
    expect(explanation.rules[0]).toMatchObject({
      matched: true,
      reason: "tag:agent:quality-watch:inherited",
    });
  });

  it("does not inherit tags across source boundaries unless the rule opts in", () => {
    const tag = dbCreateTagDefinition({
      slug: "policy-watch",
      label: "Policy Watch",
    });
    dbUpsertTagBinding({
      slug: tag.slug,
      assetType: "agent",
      assetId: "worker",
    });
    const session = getOrCreateSession("tag-inheritance-source", "worker", "/tmp/worker", {
      name: "tag-inheritance-source",
    });
    dbUpsertObserverRule({
      id: "policy",
      scope: "tag",
      tagTargetType: "agent",
      tagSlug: tag.slug,
      observerAgentId: "observer",
      observerRole: "policy",
      observerMode: "summarize",
    });

    const result = ensureObserverBindingsForSession({
      sessionName: "tag-inheritance-source",
      session,
    });
    const explanation = explainObserverRulesForSession("tag-inheritance-source");

    expect(result.created).toHaveLength(0);
    expect(explanation.rules[0]).toMatchObject({
      matched: false,
      reason: "tag_mismatch",
    });
  });

  it("preserves disabled observer rules across ordinary upserts", () => {
    const disabled = dbUpsertObserverRule({
      id: "disabled-quality",
      enabled: false,
      observerAgentId: "observer",
      observerRole: "disabled-quality",
      observerMode: "summarize",
    });
    expect(disabled.enabled).toBe(false);

    const updated = dbUpsertObserverRule({
      id: "disabled-quality",
      observerAgentId: "observer",
      observerModel: "gpt-5.4-mini",
    });

    expect(updated.enabled).toBe(false);
    expect(updated.observerModel).toBe("gpt-5.4-mini");
  });

  it("delivers selected end-of-turn events to observer sessions asynchronously", async () => {
    const session = getOrCreateSession("deliver-source", "worker", "/tmp/worker", { name: "deliver-source" });
    dbUpsertObserverRule({
      id: "turn-summary",
      scope: "global",
      observerAgentId: "observer",
      observerRole: "turn-summary",
      observerMode: "summarize",
      eventTypes: ["turn.complete"],
    });
    ensureObserverBindingsForSession({
      sessionName: "deliver-source",
      session,
    });

    const result = await deliverObservationEvents({
      sourceSessionName: "deliver-source",
      sourceSession: session,
      agentId: "worker",
      runId: "run-test",
      events: [
        createObservationEvent({
          runId: "run-test",
          sequence: 1,
          type: "message.user",
          preview: "ignored by filter",
        }),
        createObservationEvent({
          runId: "run-test",
          sequence: 2,
          type: "turn.complete",
          payload: { responseChars: 10 },
        }),
      ],
    });

    expect(result.delivered).toHaveLength(1);
    expect(publishedPrompts).toHaveLength(1);
    expect(publishedPrompts[0]?.sessionName).toMatch(/^obs:/);
    expect(publishedPrompts[0]?.payload._agentId).toBe("observer");
    expect(String(publishedPrompts[0]?.payload.prompt)).toContain("turn.complete");
    expect(String(publishedPrompts[0]?.payload.prompt)).not.toContain("ignored by filter");
  });

  it("delivers observation events only to the requested delivery policies", async () => {
    const session = getOrCreateSession("policy-source", "worker", "/tmp/worker", { name: "policy-source" });
    dbUpsertObserverRule({
      id: "realtime-watch",
      scope: "session",
      sourceSession: "policy-source",
      observerAgentId: "observer",
      observerRole: "realtime-watch",
      observerMode: "summarize",
      deliveryPolicy: "realtime",
      eventTypes: ["message.user"],
    });
    dbUpsertObserverRule({
      id: "debounce-watch",
      scope: "session",
      sourceSession: "policy-source",
      observerAgentId: "observer",
      observerRole: "debounce-watch",
      observerMode: "summarize",
      deliveryPolicy: "debounce",
      debounceMs: 250,
      eventTypes: ["message.user"],
    });
    dbUpsertObserverRule({
      id: "turn-watch",
      scope: "session",
      sourceSession: "policy-source",
      observerAgentId: "observer",
      observerRole: "turn-watch",
      observerMode: "summarize",
      deliveryPolicy: "end_of_turn",
      eventTypes: ["message.user"],
    });
    ensureObserverBindingsForSession({
      sessionName: "policy-source",
      session,
    });
    const event = createObservationEvent({
      runId: "run-test",
      sequence: 1,
      type: "message.user",
    });

    expect(
      getObservationDebounceMs({
        sourceSessionName: "policy-source",
        sourceSession: session,
        agentId: "worker",
        eventTypes: ["message.user"],
      }),
    ).toBe(250);

    await deliverObservationEvents({
      sourceSessionName: "policy-source",
      sourceSession: session,
      agentId: "worker",
      events: [event],
      deliveryPolicies: ["realtime"],
    });
    expect(publishedPrompts).toHaveLength(1);
    expect(String(publishedPrompts[0]?.payload.prompt)).toContain("Observer role: realtime-watch");

    publishedPrompts.length = 0;
    await deliverObservationEvents({
      sourceSessionName: "policy-source",
      sourceSession: session,
      agentId: "worker",
      events: [event],
      deliveryPolicies: ["end_of_turn"],
    });
    expect(publishedPrompts).toHaveLength(1);
    expect(String(publishedPrompts[0]?.payload.prompt)).toContain("Observer role: turn-watch");
  });

  it("carries observer runtime provider and model overrides into delivery prompts", async () => {
    const session = getOrCreateSession("runtime-source", "worker", "/tmp/worker", { name: "runtime-source" });
    const rule = dbUpsertObserverRule({
      id: "cheap-reporter",
      scope: "session",
      sourceSession: "runtime-source",
      observerAgentId: "observer",
      observerRuntimeProviderId: "codex",
      observerModel: "gpt-5.4-mini",
      observerRole: "cheap-reporter",
      observerMode: "report",
      eventTypes: ["turn.complete"],
    });
    expect(rule.observerRuntimeProviderId).toBe("codex");
    expect(rule.observerModel).toBe("gpt-5.4-mini");
    ensureObserverBindingsForSession({
      sessionName: "runtime-source",
      session,
    });

    await deliverObservationEvents({
      sourceSessionName: "runtime-source",
      sourceSession: session,
      agentId: "worker",
      events: [
        createObservationEvent({
          runId: "run-test",
          sequence: 1,
          type: "turn.complete",
        }),
      ],
    });

    const binding = dbListObserverBindings({
      sourceSessionKey: "runtime-source",
    })[0];
    expect(binding?.observerRuntimeProviderId).toBe("codex");
    expect(binding?.observerModel).toBe("gpt-5.4-mini");
    expect(publishedPrompts[0]?.payload._runtimeProviderId).toBe("codex");
    expect(publishedPrompts[0]?.payload._runtimeModel).toBe("gpt-5.4-mini");
  });

  it("includes rule instructions from metadata in observer prompts", async () => {
    const session = getOrCreateSession("instruction-source", "worker", "/tmp/worker", { name: "instruction-source" });
    dbUpsertObserverRule({
      id: "main-reporter",
      scope: "session",
      sourceSession: "instruction-source",
      observerAgentId: "observer",
      observerRole: "main-reporter",
      observerMode: "report",
      eventTypes: ["turn.complete"],
      metadata: {
        instructions: "Summarize the source work and run `ravi sessions inform main ...`.",
      },
    });
    ensureObserverBindingsForSession({
      sessionName: "instruction-source",
      session,
    });

    await deliverObservationEvents({
      sourceSessionName: "instruction-source",
      sourceSession: session,
      agentId: "worker",
      events: [
        createObservationEvent({
          runId: "run-test",
          sequence: 1,
          type: "turn.complete",
        }),
      ],
    });

    expect(String(publishedPrompts[0]?.payload.prompt)).toContain("Observer instructions:");
    expect(String(publishedPrompts[0]?.payload.prompt)).toContain("ravi sessions inform main");
  });

  it("does not create bindings for observer prompts", () => {
    const session = getOrCreateSession("obs-source", "worker", "/tmp/worker", {
      name: "obs-source",
    });
    dbUpsertObserverRule({
      id: "global-observer",
      scope: "global",
      observerAgentId: "observer",
      observerRole: "global-observer",
      observerMode: "summarize",
    });

    const result = ensureObserverBindingsForSession({
      sessionName: "obs-source",
      session,
      prompt: {
        prompt: "observe",
        _observation: {
          sourceSessionKey: "source",
          sourceSessionName: "source",
          bindingId: "binding",
          ruleId: "rule",
          role: "role",
          mode: "observe",
          eventIds: [],
        },
      },
    });

    expect(result.bindings).toHaveLength(0);
    expect(result.skipped[0]?.reason).toBe("observer_session");
  });
});
