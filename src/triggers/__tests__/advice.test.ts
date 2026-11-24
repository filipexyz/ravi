import { describe, expect, it } from "bun:test";
import { isTriggerDormant, TRIGGER_DORMANT_AFTER_MS, triggerDefaultsToConversationalSession } from "../advice.js";
import { defaultTriggerDelivery, DEFAULT_TRIGGER_DEBOUNCE_MS, WATCH_TOPIC_DEFAULT_DEBOUNCE_MS } from "../debounce.js";

describe("defaultTriggerDelivery", () => {
  it("turns cooldown off: it drops events, debounce keeps them", () => {
    expect(defaultTriggerDelivery("ravi.audit.denied").cooldownMs).toBe(0);
    expect(defaultTriggerDelivery("ravi.watch.github.>").cooldownMs).toBe(0);
  });

  it("debounces watch topics for 30 s and other topics for 5 s", () => {
    expect(defaultTriggerDelivery("ravi.watch.github.>").debounceMs).toBe(WATCH_TOPIC_DEFAULT_DEBOUNCE_MS);
    expect(defaultTriggerDelivery(" ravi.watch.console.page.comment.created").debounceMs).toBe(30_000);
    expect(defaultTriggerDelivery("ravi.audit.denied").debounceMs).toBe(DEFAULT_TRIGGER_DEBOUNCE_MS);
    expect(defaultTriggerDelivery("ravi.watchlist.x").debounceMs).toBe(5_000);
  });
});

describe("triggerDefaultsToConversationalSession", () => {
  const base = { isShellTrigger: false, currentSession: "main", callerChatId: "D0C8BEV8QUR" };

  it("warns when the trigger takes the current session and that session has a chat", () => {
    expect(triggerDefaultsToConversationalSession(base)).toBe(true);
  });

  it("does not warn when the session was chosen, the trigger runs in a thread, or runs a shell command", () => {
    expect(triggerDefaultsToConversationalSession({ ...base, session: "main" })).toBe(false);
    expect(triggerDefaultsToConversationalSession({ ...base, thread: true })).toBe(false);
    expect(triggerDefaultsToConversationalSession({ ...base, isShellTrigger: true })).toBe(false);
  });

  it("does not warn outside a conversation", () => {
    expect(triggerDefaultsToConversationalSession({ ...base, callerChatId: undefined })).toBe(false);
    expect(triggerDefaultsToConversationalSession({ ...base, currentSession: undefined })).toBe(false);
  });
});

describe("isTriggerDormant", () => {
  const now = 1_800_000_000_000;
  const day = 24 * 60 * 60 * 1000;

  it("marks an enabled trigger that last fired more than 30 days ago", () => {
    expect(isTriggerDormant({ enabled: true, lastFiredAt: now - 31 * day, createdAt: now - 400 * day }, now)).toBe(
      true,
    );
    expect(isTriggerDormant({ enabled: true, lastFiredAt: now - 29 * day, createdAt: now - 400 * day }, now)).toBe(
      false,
    );
  });

  it("counts from creation when the trigger never fired", () => {
    expect(isTriggerDormant({ enabled: true, createdAt: now - 31 * day }, now)).toBe(true);
    expect(isTriggerDormant({ enabled: true, createdAt: now - 2 * day }, now)).toBe(false);
  });

  it("never marks a disabled trigger: it already wakes no one", () => {
    expect(isTriggerDormant({ enabled: false, createdAt: now - 400 * day }, now)).toBe(false);
  });

  it("uses a 30-day window, edge exclusive", () => {
    expect(isTriggerDormant({ enabled: true, createdAt: now - TRIGGER_DORMANT_AFTER_MS }, now)).toBe(false);
    expect(isTriggerDormant({ enabled: true, createdAt: now - TRIGGER_DORMANT_AFTER_MS - 1 }, now)).toBe(true);
  });
});
