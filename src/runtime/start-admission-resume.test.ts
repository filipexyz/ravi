import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createIsolatedRaviState, cleanupIsolatedRaviState } from "../test/ravi-state.js";
import { getDb } from "../router/router-db.js";
import {
  claimLocalInboxItem,
  listLocalInboxEvents,
  listLocalInboxItems,
  markLocalInboxItem,
} from "../inbox/local-db.js";
import { preserveRejectedRuntimeStart } from "./start-admission-inbox.js";
import { RuntimeStartCapacityError, type RuntimeStartCapacitySnapshot } from "./start-admission.js";
import {
  RETAINED_START_TTL_MS,
  classifyRetainedStart,
  listRetainedStarts,
  resumeRetainedStarts,
} from "./start-admission-resume.js";
import type { RuntimeLaunchPrompt } from "./message-types.js";

const capacity: RuntimeStartCapacitySnapshot = {
  lane: "background",
  reason: "interactive_reserved_capacity",
  active: 8,
  reserved: 0,
  max: 12,
  backgroundLimit: 8,
  queuePosition: null,
  occupants: [],
  largestConsumer: null,
};

let stateDir: string;
beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-start-resume-");
});
afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
});

function save(sessionName: string, prompt: RuntimeLaunchPrompt, key = `runtime-start:${sessionName}:${prompt.prompt}`) {
  return preserveRejectedRuntimeStart({ key, sessionName, prompt, capacity }).item;
}

function backdate(itemId: string, occurredAt: number) {
  getDb().prepare("UPDATE inbox_items SET occurred_at = ? WHERE id = ?").run(occurredAt, itemId);
}

function recordTurn(sessionKey: string, startedAt: number) {
  getDb()
    .prepare(
      `INSERT INTO session_turns (turn_id, session_key, status, started_at, updated_at)
       VALUES (?, ?, 'completed', ?, ?)`,
    )
    .run(`turn-${sessionKey}-${startedAt}`, sessionKey, startedAt, startedAt);
}

function harness(run: (sessionName: string, prompt: RuntimeLaunchPrompt) => Promise<void> = async () => {}) {
  const runs: Array<{ sessionName: string; prompt: string }> = [];
  const emits: Array<{ topic: string; payload: Record<string, unknown> }> = [];
  return {
    runs,
    emits,
    deps: {
      runOnce: async (sessionName: string, prompt: RuntimeLaunchPrompt) => {
        runs.push({ sessionName, prompt: prompt.prompt });
        await run(sessionName, prompt);
      },
      emit: async (topic: string, payload: Record<string, unknown>) => {
        emits.push({ topic, payload });
      },
    },
  };
}

function statusOf(id: string) {
  return listLocalInboxItems({ includeArchived: true, sourceDomain: "system" }).find((item) => item.id === id)?.status;
}

describe("resumeRetainedStarts", () => {
  it("runs a saved request once when capacity frees up and closes its alert", async () => {
    const item = save("child", { prompt: "pedido" });
    const h = harness();
    const decisions = await resumeRetainedStarts(h.deps);
    expect(decisions.map((d) => d.outcome)).toEqual(["resumed"]);
    expect(h.runs).toEqual([{ sessionName: "child", prompt: "pedido" }]);
    expect(statusOf(item.id)).toBe("done");
    expect(listLocalInboxEvents(item.id).map((e) => e.eventType)).toContain("resume_resumed");
    // A second pass finds nothing to run: the same request never runs twice.
    await resumeRetainedStarts(h.deps);
    expect(h.runs).toHaveLength(1);
  });

  it("keeps the request open on a capacity refusal and stops the pass there", async () => {
    const first = save("a", { prompt: "um" });
    backdate(first.id, Date.now() - 2_000);
    const second = save("b", { prompt: "dois" });
    const h = harness(async () => {
      throw new RuntimeStartCapacityError(capacity);
    });
    const decisions = await resumeRetainedStarts(h.deps);
    expect(decisions.map((d) => d.outcome)).toEqual(["deferred"]);
    expect(h.runs.map((r) => r.sessionName)).toEqual(["a"]);
    expect(statusOf(first.id)).toBe("open");
    expect(statusOf(second.id)).toBe("open");
    expect(listRetainedStarts({ resumableOnly: true }).map((i) => i.id)).toEqual([first.id, second.id]);
  });

  it("never runs a request twice after a failure that may have reached the provider", async () => {
    const item = save("child", { prompt: "pedido" });
    const h = harness(async () => {
      throw new Error("provider crashed mid-turn");
    });
    const decisions = await resumeRetainedStarts(h.deps);
    expect(decisions.map((d) => d.outcome)).toEqual(["failed"]);
    expect(statusOf(item.id)).toBe("done");
    await resumeRetainedStarts(h.deps);
    expect(h.runs).toHaveLength(1);
  });

  it("skips a request whose session already started another turn after the refusal", async () => {
    const item = save("child", { prompt: "velho" });
    const refusedAt = Date.now() - 60_000;
    backdate(item.id, refusedAt);
    const sessionKey = (item.metadata as { sessionKey: string }).sessionKey;
    recordTurn(sessionKey, refusedAt - 5_000); // earlier turn: does not count
    const h = harness();
    expect(classifyRetainedStart(statusItem(item.id), Date.now()).outcome).toBe("resumed");
    recordTurn(sessionKey, refusedAt + 5_000);
    const decisions = await resumeRetainedStarts(h.deps);
    expect(decisions.map((d) => d.outcome)).toEqual(["superseded"]);
    expect(h.runs).toHaveLength(0);
    expect(statusOf(item.id)).toBe("done");
  });

  it("expires an old request without running it and tells the person who asked", async () => {
    const person = save("dm", {
      prompt: "pedido de gente",
      source: { channel: "whatsapp", accountId: "main", chatId: "5511@s.whatsapp.net" },
    } as RuntimeLaunchPrompt);
    const cron = save("cron", {
      prompt: "[Cron: x] rotina",
      _cron: true,
      _jobId: "c1",
      source: { channel: "whatsapp", accountId: "main", chatId: "120@g.us" },
    } as unknown as RuntimeLaunchPrompt);
    for (const id of [person.id, cron.id]) backdate(id, Date.now() - RETAINED_START_TTL_MS - 60_000);
    const h = harness();
    const decisions = await resumeRetainedStarts(h.deps);
    expect(decisions.map((d) => d.outcome).sort()).toEqual(["expired", "expired"]);
    expect(h.runs).toHaveLength(0);
    expect(statusOf(person.id)).toBe("archived");
    expect(statusOf(cron.id)).toBe("archived");
    const replies = h.emits.filter((e) => e.topic.endsWith(".response"));
    expect(replies.map((e) => e.topic)).toEqual(["ravi.session.dm.response"]);
    expect(String(replies[0]!.payload.response)).toContain(person.id);
  });

  it("does not run a request another runner already claimed", async () => {
    const item = save("child", { prompt: "pedido" });
    markLocalInboxItem(item.id, "assigned", { eventType: "resume_claimed" });
    const h = harness();
    await resumeRetainedStarts(h.deps);
    expect(h.runs).toHaveLength(0);
    expect(statusOf(item.id)).toBe("assigned");
    expect(listRetainedStarts().map((i) => i.id)).toEqual([item.id]);
  });

  it("claims an item only while it is still in an expected status", () => {
    const item = save("child", { prompt: "pedido" });
    expect(claimLocalInboxItem(item.id, ["open", "seen"], "assigned")).toBe(true);
    expect(claimLocalInboxItem(item.id, ["open", "seen"], "assigned")).toBe(false);
    expect(statusOf(item.id)).toBe("assigned");
  });

  it("archives a saved item with no usable envelope instead of looping on it", async () => {
    const item = save("child", { prompt: "pedido" });
    getDb().prepare("UPDATE inbox_items SET metadata_json = '{}' WHERE id = ?").run(item.id);
    const h = harness();
    const decisions = await resumeRetainedStarts(h.deps);
    expect(decisions.map((d) => d.outcome)).toEqual(["invalid"]);
    expect(statusOf(item.id)).toBe("archived");
  });
});

function statusItem(id: string) {
  return listLocalInboxItems({ includeArchived: true, sourceDomain: "system" }).find((item) => item.id === id)!;
}
