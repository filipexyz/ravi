import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { closeSessionStore, getOrCreateSession } from "../router/sessions.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { handoffEventPayload } from "./events.js";
import { handleHandoffPullRequestEvent } from "./pr-events.js";
import {
  HANDOFF_EXPIRY_MS,
  HANDOFF_OWNER_ESCALATION_MS,
  HANDOFF_PARENT_NUDGE_MS,
  HANDOFF_REMINDER_WINDOW_MS,
  handoffsForReminder,
  planHandoffActions,
  reconcileHandoffs,
  type HandoffDeliveryPorts,
} from "./reconcile.js";
import {
  acknowledgeChildHandoffs,
  acknowledgeHandoffById,
  declareHandoff,
  HANDOFF_KINDS_ANSWERED_BY_MESSAGE,
  listOpenHandoffs,
  ownerHandoffNoticeText,
} from "./service.js";
import { getHandoff, listHandoffs, type Handoff } from "./store.js";

const T0 = 1_800_000_000_000;
const PARENT = "agent:main:main";
const CHILD_A = "agent:main:thread-a";
const CHILD_B = "agent:main:thread-b";

function handoff(overrides: Partial<Handoff> = {}): Handoff {
  return {
    id: "hof_1",
    childSessionKey: CHILD_A,
    parentSessionKey: PARENT,
    kind: "review",
    ref: null,
    note: null,
    callerContextId: null,
    status: "open",
    createdAt: T0,
    parentNudgedAt: null,
    ownerEscalatedAt: null,
    acknowledgedAt: null,
    ackReason: null,
    ...overrides,
  };
}

describe("planHandoffActions", () => {
  it("owes nothing before 15 min", () => {
    const plan = planHandoffActions([handoff()], T0 + HANDOFF_PARENT_NUDGE_MS - 1);
    expect(plan.nudge).toHaveLength(0);
    expect(plan.escalate.size).toBe(0);
  });

  it("reminds the parent once at 15 min", () => {
    expect(planHandoffActions([handoff()], T0 + HANDOFF_PARENT_NUDGE_MS).nudge).toHaveLength(1);
    const nudged = handoff({ parentNudgedAt: T0 + HANDOFF_PARENT_NUDGE_MS });
    expect(planHandoffActions([nudged], T0 + 30 * 60_000).nudge).toHaveLength(0);
  });

  it("escalates to the owner once at 45 min, grouped by parent", () => {
    const now = T0 + HANDOFF_OWNER_ESCALATION_MS;
    const plan = planHandoffActions(
      [handoff(), handoff({ id: "hof_2", childSessionKey: CHILD_B }), handoff({ id: "hof_3", parentSessionKey: "p2" })],
      now,
    );
    expect([...plan.escalate.keys()].sort()).toEqual([PARENT, "p2"].sort());
    expect(plan.escalate.get(PARENT)?.map((h) => h.id)).toEqual(["hof_1", "hof_2"]);
    const done = handoff({ ownerEscalatedAt: now });
    expect(planHandoffActions([done], now + 60 * 60_000).escalate.size).toBe(0);
  });

  it("ignores closed handoffs", () => {
    const plan = planHandoffActions([handoff({ status: "acknowledged" })], T0 + 2 * HANDOFF_OWNER_ESCALATION_MS);
    expect(plan.nudge).toHaveLength(0);
    expect(plan.escalate.size).toBe(0);
  });
});

describe("handoffs store and reconciler", () => {
  let stateDir: string | null = null;

  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-handoffs-");
    getOrCreateSession(PARENT, "main", "/tmp/ravi", { name: "main" });
    getOrCreateSession(CHILD_A, "main", "/tmp/ravi", { name: "thread-a" });
    getOrCreateSession(CHILD_B, "main", "/tmp/ravi", { name: "thread-b" });
  });

  afterEach(async () => {
    closeSessionStore();
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("a new handoff from the same child supersedes the open one", async () => {
    const first = await declareHandoff({
      childSessionKey: CHILD_A,
      parentSessionKey: PARENT,
      kind: "review",
      ref: "abc",
      now: T0,
    });
    const second = await declareHandoff({
      childSessionKey: CHILD_A,
      parentSessionKey: PARENT,
      kind: "merge",
      now: T0 + 1,
    });
    expect(getHandoff(first.id)?.status).toBe("superseded");
    expect(listOpenHandoffs(PARENT).map((h) => h.id)).toEqual([second.id]);
  });

  it("only an explicit reference to the child or the handoff acknowledges it", async () => {
    const a = await declareHandoff({ childSessionKey: CHILD_A, parentSessionKey: PARENT, kind: "review", now: T0 });
    const b = await declareHandoff({ childSessionKey: CHILD_B, parentSessionKey: PARENT, kind: "decision", now: T0 });
    await acknowledgeChildHandoffs(CHILD_A, "parent sent instructions", T0 + 1);
    expect(getHandoff(a.id)?.status).toBe("acknowledged");
    expect(getHandoff(b.id)?.status).toBe("open");
    expect(await acknowledgeHandoffById(b.id, "review dispatched", T0 + 2)).not.toBeNull();
    expect(await acknowledgeHandoffById(b.id, "again", T0 + 3)).toBeNull();
    expect(listOpenHandoffs()).toHaveLength(0);
  });

  it("reminds the parent once, then tells the owner once, aggregated", async () => {
    await declareHandoff({ childSessionKey: CHILD_A, parentSessionKey: PARENT, kind: "review", ref: "sha1", now: T0 });
    await declareHandoff({ childSessionKey: CHILD_B, parentSessionKey: PARENT, kind: "decision", now: T0 });
    const parentCalls: string[] = [];
    const ownerCalls: string[][] = [];
    const ports: HandoffDeliveryPorts = {
      notifyParent: async ({ parentSessionKey, due, open }) => {
        parentCalls.push(`${parentSessionKey}:${due.length}:${open.length}`);
        return true;
      },
      notifyOwner: async ({ handoffs }) => {
        ownerCalls.push(handoffs.map((h) => h.childSessionKey));
        return true;
      },
    };
    expect(await reconcileHandoffs({ now: T0 + 5 * 60_000, ports })).toEqual({
      nudged: 0,
      escalated: 0,
      expired: 0,
      failures: 0,
    });
    expect(await reconcileHandoffs({ now: T0 + HANDOFF_PARENT_NUDGE_MS, ports })).toEqual({
      nudged: 2,
      escalated: 0,
      expired: 0,
      failures: 0,
    });
    // One reminder turn for the parent, naming both waits.
    expect(parentCalls).toEqual([`${PARENT}:2:2`]);
    // Second tick: the reminder is never repeated.
    await reconcileHandoffs({ now: T0 + 30 * 60_000, ports });
    expect(parentCalls).toHaveLength(1);
    expect(await reconcileHandoffs({ now: T0 + HANDOFF_OWNER_ESCALATION_MS, ports })).toEqual({
      nudged: 0,
      escalated: 2,
      expired: 0,
      failures: 0,
    });
    expect(ownerCalls).toEqual([[CHILD_A, CHILD_B]]);
    await reconcileHandoffs({ now: T0 + 2 * HANDOFF_OWNER_ESCALATION_MS, ports });
    expect(ownerCalls).toHaveLength(1);
  });

  it("does not claim a delivery it could not make", async () => {
    const h = await declareHandoff({ childSessionKey: CHILD_A, parentSessionKey: PARENT, kind: "review", now: T0 });
    const ports: HandoffDeliveryPorts = {
      notifyParent: async () => false,
      notifyOwner: async () => {
        throw new Error("no route");
      },
    };
    const result = await reconcileHandoffs({ now: T0 + HANDOFF_OWNER_ESCALATION_MS, ports });
    expect(result).toEqual({ nudged: 0, escalated: 0, expired: 0, failures: 1 });
    expect(getHandoff(h.id)?.parentNudgedAt).toBeNull();
    expect(getHandoff(h.id)?.ownerEscalatedAt).toBeNull();
  });

  it("an acknowledged handoff is never reminded nor escalated", async () => {
    await declareHandoff({ childSessionKey: CHILD_A, parentSessionKey: PARENT, kind: "review", now: T0 });
    await acknowledgeChildHandoffs(CHILD_A, "thread closed", T0 + 60_000);
    let calls = 0;
    const ports: HandoffDeliveryPorts = {
      notifyParent: async () => {
        calls++;
        return true;
      },
      notifyOwner: async () => {
        calls++;
        return true;
      },
    };
    await reconcileHandoffs({ now: T0 + 2 * HANDOFF_OWNER_ESCALATION_MS, ports });
    expect(calls).toBe(0);
    expect(listHandoffs({ includeClosed: true })[0]?.ackReason).toBe("thread closed");
  });

  it("owner notice is one message naming each waiting thread", () => {
    const text = ownerHandoffNoticeText(
      PARENT,
      [handoff({ ref: "sha1" }), handoff({ id: "hof_2", childSessionKey: CHILD_B, kind: "decision" })],
      T0 + HANDOFF_OWNER_ESCALATION_MS,
    );
    expect(text).toContain("2 threads esperam a sessão main há mais de 45 min");
    expect(text).toContain("thread-a espera revisão (sha1) há 45 min");
    expect(text).toContain("thread-b espera decisão há 45 min");
    // The parent was never reminded in these rows: the notice must not claim it was.
    expect(text).toContain("O lembrete à sessão main não saiu");
    const reminded = ownerHandoffNoticeText(
      PARENT,
      [handoff({ parentNudgedAt: T0 + 1 })],
      T0 + HANDOFF_OWNER_ESCALATION_MS,
    );
    expect(reminded).toContain("A sessão main já foi lembrada");
  });

  it("a message to the thread closes only instruction and decision waits", async () => {
    const review = await declareHandoff({
      childSessionKey: CHILD_A,
      parentSessionKey: PARENT,
      kind: "review",
      now: T0,
    });
    await acknowledgeChildHandoffs(CHILD_A, "parent sent instructions", T0 + 1, HANDOFF_KINDS_ANSWERED_BY_MESSAGE);
    expect(getHandoff(review.id)?.status).toBe("open");
    const decision = await declareHandoff({
      childSessionKey: CHILD_B,
      parentSessionKey: PARENT,
      kind: "decision",
      now: T0,
    });
    await acknowledgeChildHandoffs(CHILD_B, "parent sent instructions", T0 + 1, HANDOFF_KINDS_ANSWERED_BY_MESSAGE);
    expect(getHandoff(decision.id)?.status).toBe("acknowledged");
  });

  it("claims the owner notice before delivering and releases it when delivery fails", async () => {
    const h = await declareHandoff({ childSessionKey: CHILD_A, parentSessionKey: PARENT, kind: "merge", now: T0 });
    let seenClaimed: number | null | undefined;
    const failing: HandoffDeliveryPorts = {
      notifyOwner: async () => {
        seenClaimed = getHandoff(h.id)?.ownerEscalatedAt;
        return false;
      },
    };
    const now = T0 + HANDOFF_OWNER_ESCALATION_MS;
    expect(await reconcileHandoffs({ now, ports: failing })).toMatchObject({ escalated: 0 });
    expect(seenClaimed).toBe(now);
    expect(getHandoff(h.id)?.ownerEscalatedAt).toBeNull();
    let calls = 0;
    const ok: HandoffDeliveryPorts = {
      notifyOwner: async () => {
        calls++;
        return true;
      },
    };
    expect(await reconcileHandoffs({ now: now + 30_000, ports: ok })).toMatchObject({ escalated: 1 });
    await reconcileHandoffs({ now: now + 60_000, ports: ok });
    expect(calls).toBe(1);
  });

  it("an overlapping tick does nothing while one is delivering", async () => {
    await declareHandoff({ childSessionKey: CHILD_A, parentSessionKey: PARENT, kind: "merge", now: T0 });
    let release: () => void = () => {};
    let calls = 0;
    const slow: HandoffDeliveryPorts = {
      notifyOwner: () => {
        calls++;
        return new Promise<boolean>((resolve) => {
          release = () => resolve(true);
        });
      },
    };
    const now = T0 + HANDOFF_OWNER_ESCALATION_MS;
    const first = reconcileHandoffs({ now, ports: slow });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await reconcileHandoffs({ now: now + 30_000, ports: slow })).toMatchObject({ skipped: true });
    release();
    expect(await first).toMatchObject({ escalated: 1 });
    expect(calls).toBe(1);
  });

  it("closes a review or merge wait on a PR when the watch reports the PR merged or closed", async () => {
    const sha = "a".repeat(40);
    const merge = await declareHandoff({
      childSessionKey: CHILD_A,
      parentSessionKey: PARENT,
      kind: "merge",
      ref: `filipexyz/ravi#942@${sha}`,
      now: T0,
    });
    const plain = await declareHandoff({
      childSessionKey: CHILD_B,
      parentSessionKey: PARENT,
      kind: "merge",
      ref: sha,
      now: T0,
    });
    // Another PR of the same repo, and a malformed event, close nothing.
    expect(
      await handleHandoffPullRequestEvent("ravi.watch.github.pull_request.merged", {
        payload: { repository: "filipexyz/ravi", number: 94 },
      }),
    ).toBe(0);
    expect(await handleHandoffPullRequestEvent("ravi.watch.github.pull_request.merged", { payload: {} })).toBe(0);
    expect(
      await handleHandoffPullRequestEvent(
        "ravi.watch.github.pull_request.merged",
        { payload: { repository: "FilipeXYZ/Ravi", number: 942 } },
        T0 + 1,
      ),
    ).toBe(1);
    expect(getHandoff(merge.id)).toMatchObject({ status: "acknowledged", ackReason: "PR merged" });
    // A ref that names no PR is left to the parent.
    expect(getHandoff(plain.id)?.status).toBe("open");
    expect(handoffEventPayload("acknowledged", getHandoff(merge.id)!, T0)).toMatchObject({ sha, pr: 942 });
  });

  it("expires a wait nobody acted on for 7 days and lists only recent or due waits in a reminder", async () => {
    const old = await declareHandoff({ childSessionKey: CHILD_A, parentSessionKey: PARENT, kind: "review", now: T0 });
    const now = T0 + HANDOFF_EXPIRY_MS;
    expect(await reconcileHandoffs({ now, ports: {} })).toMatchObject({ expired: 1 });
    expect(getHandoff(old.id)?.ackReason).toBe("expired: no action for 7 days");

    const stale = handoff({ id: "old", createdAt: T0 - 2 * HANDOFF_REMINDER_WINDOW_MS, parentNudgedAt: T0 });
    const fresh = handoff({ id: "fresh", createdAt: T0 - 60_000 });
    const due = handoff({ id: "due", createdAt: T0 - HANDOFF_PARENT_NUDGE_MS });
    expect(handoffsForReminder([stale, fresh, due], PARENT, [due], T0).map((h) => h.id)).toEqual(["fresh", "due"]);
  });
});

describe("handoff contract", () => {
  it("events carry the observer contract fields", () => {
    const payload = handoffEventPayload("stale", handoff({ ref: "sha1" }), T0 + 16 * 60_000);
    expect(payload).toEqual({
      type: "handoff.stale",
      handoffId: "hof_1",
      threadSession: CHILD_A,
      parentSession: PARENT,
      kind: "review",
      sha: "sha1",
      since: T0,
      ageMin: 16,
    });
  });

  it("the handoff core never names a channel", () => {
    const dir = join(import.meta.dir);
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))) {
      const source = readFileSync(join(dir, file), "utf8");
      expect({ file, hit: /channels\/|slack|whatsapp|telegram|discord/i.test(source) }).toEqual({ file, hit: false });
    }
  });
});
