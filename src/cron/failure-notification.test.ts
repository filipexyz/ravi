import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { listLocalInboxEvents, listLocalInboxItems } from "../inbox/local-db.js";
import { dbCreateCronJob } from "./cron-db.js";
import { classifyCronFailure, notifyCronFailure, recordUnreadableCronFailure } from "./failure-notification.js";

let stateDir: string | null = null;
beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-cron-notification-");
});
afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

const target = { channel: "slack", accountId: "test-slack", to: "U123", chatId: "U123", contactId: "owner" };
function job() {
  return {
    ...dbCreateCronJob({
      name: "Daily check",
      message: "work",
      schedule: { type: "every", every: 60000 },
      ownerPrincipal: "operator",
    }),
    lastRunAt: 1000,
  };
}

describe("cron failure notification", () => {
  it("classifies failures without forwarding provider error text", () => {
    expect(classifyCronFailure("No managed runtime credential could be resolved")).toBe("credential");
    expect(classifyCronFailure("Agent turn interrupted")).toBe("interruption");
    expect(classifyCronFailure("Agent turn interrupted (inactivity_timeout)")).toBe("timeout");
    expect(classifyCronFailure('Model "deepseek/x" does not belong to the claude runtime')).toBe("configuration");
  });

  it("notifies directly once per run, retaining the failed work in the inbox", async () => {
    const current = job();
    const sent: string[] = [];
    const deps = {
      owner: () => target,
      deliver: async (_target: typeof target, text: string) => {
        sent.push(text);
      },
    };
    await notifyCronFailure(current, "credential rejected PRIVATE_TOKEN_123", deps);
    await notifyCronFailure(current, "credential rejected PRIVATE_TOKEN_123", deps);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("credencial indisponível");
    expect(sent[0]).not.toContain("PRIVATE_TOKEN_123");
    const items = listLocalInboxItems({ sourceDomain: "cron" });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      status: "open",
      assignedToContactId: "owner",
      metadata: { category: "credential" },
    });
    expect(JSON.stringify(items)).not.toContain("PRIVATE_TOKEN_123");
    await notifyCronFailure({ ...current, lastRunAt: 2000 }, "interrupted", deps);
    expect(sent).toHaveLength(2);
  });

  it("keeps failed delivery retryable and never falls back to an unrelated chat", async () => {
    const current = job();
    let attempts = 0;
    const deps = {
      owner: () => target,
      deliver: async () => {
        attempts++;
        if (attempts === 1) throw new Error("offline");
      },
    };
    await notifyCronFailure(current, "timeout", deps);
    expect(listLocalInboxItems({ sourceDomain: "cron" })[0]?.status).toBe("open");
    await notifyCronFailure(current, "timeout", deps);
    expect(attempts).toBe(2);
    await notifyCronFailure({ ...current, lastRunAt: 3000 }, "timeout", { owner: () => null, deliver: deps.deliver });
    expect(attempts).toBe(2);
  });

  it("settles the report of a run no person owns instead of replaying it at every start", async () => {
    let delivered = 0;
    for (const ownerPrincipal of ["unknown", "agent:helper"]) {
      const unowned = { ...job(), ownerPrincipal };
      const deps = { owner: () => null, deliver: async () => void delivered++ };
      expect(await notifyCronFailure(unowned, "timeout", deps)).toBe(true);
      // A later start finds it already settled.
      expect(await notifyCronFailure(unowned, "timeout", deps)).toBe(true);
    }
    expect(delivered).toBe(0);
    expect(listLocalInboxItems({ sourceDomain: "cron" }).length).toBeGreaterThan(0);
  });

  it("keeps a report pending while an owned run has no delivery target yet", async () => {
    expect(await notifyCronFailure(job(), "timeout", { owner: () => null, deliver: async () => {} })).toBe(false);
  });

  it("records a run whose notice cannot be read once, as a high-priority inbox item with its own event", () => {
    const run = { id: "run-1", job_id: "job-1", admitted_at: 1234 };
    recordUnreadableCronFailure(run);
    // A start that retries after a crash between the record and the mark.
    recordUnreadableCronFailure(run);

    const items = listLocalInboxItems({ sourceDomain: "cron" });
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item).toMatchObject({
      sourceType: "run_unreadable",
      sourceId: "job-1",
      priority: "high",
      occurredAt: 1234,
      assignedToAgentId: null,
      assignedToContactId: null,
    });
    expect(listLocalInboxEvents(item.id).filter((event) => event.eventType === "cron.failure.unreadable")).toHaveLength(
      1,
    );
  });
});
