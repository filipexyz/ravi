import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { listLocalInboxItems } from "../inbox/local-db.js";
import { dbCreateCronJob } from "./cron-db.js";
import { classifyCronFailure, notifyCronFailure } from "./failure-notification.js";

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
});
