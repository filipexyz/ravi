import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { listLocalInboxEvents, listLocalInboxItems } from "../inbox/local-db.js";
import { dbCreateCronJob } from "./cron-db.js";
import {
  CRON_FAILURE_MAX_DELIVERY_ATTEMPTS,
  CRON_FAILURE_NOTICE_WINDOW_MS,
  classifyCronFailure,
  notifyCronFailure,
  recordUnreadableCronFailure,
} from "./failure-notification.js";

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
    lastRunAt: Date.now(),
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
    // Another run of the same job inside the window joins the first notice.
    await notifyCronFailure({ ...current, lastRunAt: Date.now() + 1 }, "interrupted", deps);
    expect(sent).toHaveLength(1);
    // After the window the owner hears about the job again.
    await notifyCronFailure({ ...current, lastRunAt: Date.now() + CRON_FAILURE_NOTICE_WINDOW_MS }, "interrupted", {
      ...deps,
      now: () => Date.now() + CRON_FAILURE_NOTICE_WINDOW_MS + 1,
    });
    expect(sent).toHaveLength(2);
  });

  it("sends one message for a job's backlog of failed runs, with the count, never one per run", async () => {
    const current = job();
    const sent: string[] = [];
    const deps = {
      owner: () => target,
      deliver: async (_target: typeof target, text: string) => void sent.push(text),
      pendingFailures: () => 31,
    };
    for (let run = 0; run < 31; run++) {
      expect(await notifyCronFailure({ ...current, runId: `run-${run}` }, "timeout", deps)).toBe(true);
    }
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("falhou 31 vezes");
    const items = listLocalInboxItems({ sourceDomain: "cron" });
    expect(items).toHaveLength(31);
    const aggregated = items.filter((item) =>
      listLocalInboxEvents(item.id).some((event) => event.eventType === "cron.failure.aggregated"),
    );
    expect(aggregated).toHaveLength(30);
  });

  it("settles a failure older than the window without a message, keeping it in the inbox", async () => {
    let delivered = 0;
    const old = { ...job(), lastRunAt: Date.now() - CRON_FAILURE_NOTICE_WINDOW_MS - 60_000 };
    const deps = { owner: () => target, deliver: async () => void delivered++ };
    expect(await notifyCronFailure(old, "timeout", deps)).toBe(true);
    expect(await notifyCronFailure(old, "timeout", deps)).toBe(true);
    expect(delivered).toBe(0);
    const item = listLocalInboxItems({ sourceDomain: "cron" })[0]!;
    expect(item.status).toBe("open");
    expect(listLocalInboxEvents(item.id).filter((event) => event.eventType === "cron.failure.stale")).toHaveLength(1);
  });

  it("falls through to the owner's next chat when the first one cannot be reached", async () => {
    const whatsapp = { channel: "whatsapp", accountId: "luis", to: "5511@s", chatId: "5511@s", contactId: "owner" };
    const tried: string[] = [];
    const ok = await notifyCronFailure(job(), "timeout", {
      owners: () => [whatsapp, target],
      deliver: async (to) => {
        tried.push(to.channel);
        if (to.channel === "whatsapp") throw new Error("instance not connected");
      },
    });
    expect(ok).toBe(true);
    expect(tried).toEqual(["whatsapp", "slack"]);
    const item = listLocalInboxItems({ sourceDomain: "cron" })[0]!;
    const notified = listLocalInboxEvents(item.id).find((event) => event.eventType === "cron.failure.notified");
    expect(notified?.payload).toMatchObject({ channel: "slack" });
  });

  it("settles a report no chat accepts as undeliverable after bounded attempts, instead of retrying every start", async () => {
    const current = job();
    let attempts = 0;
    const deps = {
      owner: () => target,
      deliver: async () => {
        attempts++;
        throw new Error("not connected");
      },
    };
    expect(await notifyCronFailure(current, "timeout", deps)).toBe(false);
    expect(await notifyCronFailure(current, "timeout", deps)).toBe(false);
    expect(await notifyCronFailure(current, "timeout", deps)).toBe(true);
    // Settled: a later start does not try again.
    expect(await notifyCronFailure(current, "timeout", deps)).toBe(true);
    expect(attempts).toBe(CRON_FAILURE_MAX_DELIVERY_ATTEMPTS);
    const item = listLocalInboxItems({ sourceDomain: "cron" })[0]!;
    expect(item.status).toBe("open");
    expect(
      listLocalInboxEvents(item.id).filter((event) => event.eventType === "cron.failure.undeliverable"),
    ).toHaveLength(1);
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
    await notifyCronFailure({ ...current, lastRunAt: Date.now() + 2 }, "timeout", {
      owner: () => null,
      deliver: deps.deliver,
    });
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
    // The guidance names a command that exists and takes the job id (`cron show` opens the job, not the run).
    expect(item.summary).toContain('"ravi cron show job-1"');
    expect(listLocalInboxEvents(item.id).filter((event) => event.eventType === "cron.failure.unreadable")).toHaveLength(
      1,
    );
  });
});
