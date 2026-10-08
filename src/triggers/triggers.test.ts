import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { resolveTriggerActivation } from "./activation.js";
import { compileFilter } from "./filter.js";
import {
  isTriggerOriginatedEvent,
  planTriggerTopicRefresh,
  shouldRetryTriggerTopic,
  sourceFromSessionEntry,
} from "./runner.js";
import { findTriggerTopicCatalogEntry } from "./topic-catalog.js";
import { dbCreateTrigger, dbGetTrigger, dbRecordTriggerFilterRejects, dbUpdateTrigger } from "./triggers-db.js";

let stateDir: string | null = null;

describe("triggers native automation support", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-triggers-native-automation-test-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("catalogs native Slack reaction_added as a producer of ravi.inbound.reaction", () => {
    const entry = findTriggerTopicCatalogEntry("ravi.inbound.reaction");

    expect(entry?.category).toBe("inbound");
    expect(entry?.payload).toBe("{ targetMessageId, emoji, senderId }");
    expect(entry?.notes?.some((note) => note.includes("native Slack `reaction_added`"))).toBe(true);
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

  it("catalogs Console bug-status watch events with a per-bugId filter", () => {
    const entry = findTriggerTopicCatalogEntry("ravi.watch.console.bug.status");
    const fields = new Set(entry?.schema?.fields.map((field) => field.path));

    expect(entry?.category).toBe("watch");
    expect(entry?.id).toBe("watch.console.bug.status");
    expect(fields).toContain("payload.bugId");
    expect(entry?.filters?.some((filter) => filter.includes("data.payload.bugId"))).toBe(true);
    expect(entry?.filters?.some((filter) => filter.includes("data.bugId"))).toBe(true);
    expect(entry?.examples.some((example) => example.includes("ravi.watch.console.bug.status"))).toBe(true);
  });

  it("catalogs page comment watch subjects and fails closed when the bound agent is gone", () => {
    const created = findTriggerTopicCatalogEntry("ravi.watch.console.page.comment.created");
    const resolved = findTriggerTopicCatalogEntry("ravi.watch.console.page.comment.resolved");

    expect(created).toMatchObject({
      id: "page.comment.created",
      pattern: "ravi.watch.console.page.comment.created",
    });
    expect(created?.filters?.some((filter) => filter.includes("data.payload.pageId"))).toBe(true);
    expect(created?.messageTemplate?.template).toContain("{{data.payload.body}}");
    expect(resolved?.id).toBe("page.comment.resolved");

    const activation = resolveTriggerActivation(
      {
        enabled: true,
        topic: "ravi.watch.console.page.comment.created",
        filter: `data.payload.pageId == "site_1"`,
        agentId: "gone-creator",
      },
      { agentExists: () => false },
    );
    expect(activation.state).toBe("unbound_agent");
    expect(activation.reason).toContain("unbound_agent");
    expect(activation.filter.evaluate({ payload: { pageId: "site_1" } })).toBe(true);
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

  it("clears a persisted filter when updated with null", () => {
    const trigger = dbCreateTrigger({
      name: "filtered",
      agentId: "agent-a",
      topic: "ravi.watch.github.*",
      message: "check",
      filter: "data.payload.number == 7",
    });
    expect(dbGetTrigger(trigger.id)?.filter).toBe("data.payload.number == 7");

    dbUpdateTrigger(trigger.id, { filter: null });

    expect(dbGetTrigger(trigger.id)?.filter).toBeUndefined();
  });

  it("compiles and caches boolean filters and fails closed on invalid filters", () => {
    const expression = `data.provider == "slack" && data.actionId startsWith "ticket_"`;
    const compiled = compileFilter(expression);

    expect(compiled.valid).toBe(true);
    expect(compileFilter(expression)).toBe(compiled);
    expect(compiled.evaluate({ provider: "slack", actionId: "ticket_claim" })).toBe(true);
    expect(compiled.evaluate({ provider: "slack", actionId: "other" })).toBe(false);

    const invalid = compileFilter("this is not a predicate");
    expect(invalid.valid).toBe(false);
    expect(invalid.error).toBeTruthy();
    expect(invalid.evaluate({ provider: "slack" })).toBe(false);
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

  it("records filter rejects only for the current topic and filter, and resets them on edit", () => {
    const trigger = dbCreateTrigger({
      name: "reject-counter",
      topic: "message.received.whatsapp-baileys.inst-1",
      message: "go",
      session: "isolated",
      cooldownMs: 0,
      filter: `data.payload.chatUuid == "chat-1"`,
    });
    const current = { topic: trigger.topic, filter: trigger.filter };

    dbRecordTriggerFilterRejects(trigger.id, { ...current, count: 2, lastRejectAt: 100 });
    dbRecordTriggerFilterRejects(trigger.id, { ...current, count: 1, lastRejectAt: 200 });
    expect(dbGetTrigger(trigger.id)?.filterRejectCount).toBe(3);
    expect(dbGetTrigger(trigger.id)?.lastFilterRejectAt).toBe(200);

    dbRecordTriggerFilterRejects(trigger.id, { ...current, filter: 'data.other == "x"', count: 5, lastRejectAt: 300 });
    expect(dbGetTrigger(trigger.id)?.filterRejectCount).toBe(3);

    dbUpdateTrigger(trigger.id, { filter: `data.payload.chatId == "123@s.whatsapp.net"` });
    expect(dbGetTrigger(trigger.id)?.filterRejectCount).toBeUndefined();
    expect(dbGetTrigger(trigger.id)?.lastFilterRejectAt).toBeUndefined();

    dbUpdateTrigger(trigger.id, { name: "renamed" });
    dbRecordTriggerFilterRejects(trigger.id, {
      topic: trigger.topic,
      filter: `data.payload.chatId == "123@s.whatsapp.net"`,
      count: 1,
      lastRejectAt: 400,
    });
    dbUpdateTrigger(trigger.id, { name: "renamed again" });
    expect(dbGetTrigger(trigger.id)?.filterRejectCount).toBe(1);
  });
});

describe("trigger reply source", () => {
  it("replies where the session last talked", () => {
    expect(
      sourceFromSessionEntry({ lastChannel: "whatsapp", lastAccountId: "main-account", lastTo: "chat-a" }),
    ).toEqual({ channel: "whatsapp", accountId: "main-account", chatId: "chat-a" });
  });

  it("lets the trigger's explicit account win", () => {
    expect(
      sourceFromSessionEntry({ lastChannel: "whatsapp", lastAccountId: "main-account", lastTo: "chat-a" }, "other"),
    ).toEqual({ channel: "whatsapp", accountId: "other", chatId: "chat-a" });
  });

  it("has no source when the session never talked to a chat", () => {
    expect(sourceFromSessionEntry({ lastChannel: "whatsapp" })).toBeUndefined();
    expect(sourceFromSessionEntry(null)).toBeUndefined();
  });
});
