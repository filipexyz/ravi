import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { compileFilter } from "./filter.js";
import { isTriggerOriginatedEvent, planTriggerTopicRefresh, shouldRetryTriggerTopic } from "./runner.js";
import { findTriggerTopicCatalogEntry } from "./topic-catalog.js";
import { dbCreateTrigger, dbGetTrigger, dbUpdateTrigger } from "./triggers-db.js";

let stateDir: string | null = null;

describe("triggers native automation support", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-triggers-native-automation-test-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("catalogs Slack Block Kit interactions as first-class trigger events", () => {
    const entry = findTriggerTopicCatalogEntry("ravi.inbound.interaction");
    const fields = new Set(entry?.schema?.fields.map((field) => field.path));

    expect(entry?.category).toBe("inbound");
    expect(fields).toContain("provider");
    expect(fields).toContain("interactionType");
    expect(fields).toContain("actionId");
    expect(fields).toContain("blockId");
    expect(fields).toContain("selectedOption");
    expect(fields).toContain("responseUrlId");
    expect(entry?.examples.some((example) => example.includes("--shell"))).toBe(true);
  });

  it("catalogs Slack thread creation as a first-class trigger event", () => {
    const entry = findTriggerTopicCatalogEntry("ravi.inbound.thread.created");
    const fields = new Set(entry?.schema?.fields.map((field) => field.path));

    expect(entry?.category).toBe("inbound");
    expect(entry?.payload).toContain("sessionKey");
    expect(fields).toContain("provider");
    expect(fields).toContain("threadTs");
    expect(fields).toContain("sessionKey");
    expect(fields).toContain("canonicalChatId");
    expect(entry?.examples.some((example) => example.includes("ravi.inbound.thread.created"))).toBe(true);
  });

  it("catalogs exhausted runtime recovery as an operator alert event", () => {
    const entry = findTriggerTopicCatalogEntry("ravi.inbox.system.runtime_recovery_exhausted");
    const fields = new Set(entry?.schema?.fields.map((field) => field.path));

    expect(entry?.category).toBe("inbox");
    expect(entry?.messageTemplate?.template).toContain("ravi sessions trace");
    expect(fields).toContain("sessionName");
    expect(fields).toContain("restartAttempts");
    expect(fields).toContain("stashedQueueSize");
  });

  it("persists shell trigger command fields and clears them for agent triggers", () => {
    const trigger = dbCreateTrigger({
      name: "shell-ticket-flow",
      agentId: "agent-a",
      topic: "ravi.inbound.interaction",
      message: "",
      executionType: "shell",
      shellCommand: "bun .ravi/workflows/slack-ticket-demo/handler.ts",
      shellTimeoutMs: 30_000,
      shellEnvFile: "/tmp/ravi-ticket.env",
      onError: "notify-session:ravi-channels",
    });

    const reloaded = dbGetTrigger(trigger.id);
    expect(reloaded?.executionType).toBe("shell");
    expect(reloaded?.shellCommand).toBe("bun .ravi/workflows/slack-ticket-demo/handler.ts");
    expect(reloaded?.shellTimeoutMs).toBe(30_000);
    expect(reloaded?.shellEnvFile).toBe("/tmp/ravi-ticket.env");
    expect(reloaded?.onError).toBe("notify-session:ravi-channels");

    dbUpdateTrigger(trigger.id, {
      executionType: "agent",
      message: "fallback prompt",
      shellCommand: null,
      shellTimeoutMs: null,
      shellEnvFile: null,
      onError: null,
    });

    const updated = dbGetTrigger(trigger.id);
    expect(updated?.executionType).toBe("agent");
    expect(updated?.message).toBe("fallback prompt");
    expect(updated?.shellCommand).toBeUndefined();
    expect(updated?.shellTimeoutMs).toBeUndefined();
    expect(updated?.shellEnvFile).toBeUndefined();
    expect(updated?.onError).toBeUndefined();
  });

  it("compiles and caches boolean filters while preserving invalid-filter fail-open behavior", () => {
    const expression = `data.provider == "slack" && data.actionId startsWith "ticket_"`;
    const compiled = compileFilter(expression);

    expect(compiled.valid).toBe(true);
    expect(compileFilter(expression)).toBe(compiled);
    expect(compiled.evaluate({ provider: "slack", actionId: "ticket_claim" })).toBe(true);
    expect(compiled.evaluate({ provider: "slack", actionId: "other" })).toBe(false);

    const invalid = compileFilter("this is not a predicate");
    expect(invalid.valid).toBe(false);
    expect(invalid.evaluate({ provider: "slack" })).toBe(true);
  });

  it("refreshes topic subscriptions incrementally without reviving removed or trigger-originated work", () => {
    expect(planTriggerTopicRefresh(["topic.keep", "topic.remove"], ["topic.keep", "topic.add"])).toEqual({
      keep: ["topic.keep"],
      add: ["topic.add"],
      remove: ["topic.remove"],
    });
    expect(shouldRetryTriggerTopic("topic.remove", true, new Set(), new Map())).toBe(false);
    expect(isTriggerOriginatedEvent("custom.topic", { _turnProvenance: { origin: "trigger" } })).toBe(true);
  });
});
