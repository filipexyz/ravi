import { describe, expect, it } from "bun:test";
import { evaluateFilter } from "../triggers/filter.js";
import type { Trigger, TriggerInput } from "../triggers/index.js";
import {
  BUG_FOLLOW_COOLDOWN_MS,
  BUG_FOLLOW_TRIGGER_MESSAGE,
  BUG_STATUS_WATCH_TOPIC,
  bugFollowFilter,
  bugFollowMatchesEvent,
  bugFollowTriggerName,
  bugReportSubscribeApiPath,
  buildBugFollowTriggerInput,
  ensureBugFollowTrigger,
  findExistingBugFollowTrigger,
} from "./follow.js";

const BUG_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_BUG_ID = "22222222-2222-4222-8222-222222222222";

function watchEvent(bugId: string, extras: Record<string, unknown> = {}) {
  return {
    version: 1,
    connector: "console",
    eventType: "bug.status",
    subject: BUG_STATUS_WATCH_TOPIC,
    payload: {
      bugId,
      title: "CLI crash",
      status: "triaged",
      consoleUrl: `https://console.example/bugs/${bugId}`,
    },
    ...extras,
  };
}

describe("bug follow contract", () => {
  it("maps Console subscribe onto POST /api/cli/bugs/:id/subscribe", () => {
    expect(bugReportSubscribeApiPath(BUG_ID)).toBe(`/api/cli/bugs/${BUG_ID}/subscribe`);
    expect(bugReportSubscribeApiPath("bug/with spaces")).toBe("/api/cli/bugs/bug%2Fwith%20spaces/subscribe");
  });

  it("builds a per-bugId trigger on the normalized Console bug-status subject", () => {
    const input = buildBugFollowTriggerInput(BUG_ID, {
      agentId: "main",
      sessionName: "agent:main:main",
    });

    expect(input).toMatchObject({
      name: `bug-follow:${BUG_ID}`,
      topic: "ravi.watch.console.bug.status",
      message: BUG_FOLLOW_TRIGGER_MESSAGE,
      session: "main",
      replySession: "agent:main:main",
      cooldownMs: 30_000,
      filter: bugFollowFilter(BUG_ID),
    });
    expect(input.topic).not.toBe("ravi.watch.>");
    expect(input.topic).not.toBe("ravi.watch.console.bug.*");
    expect(input.filter).toContain(BUG_ID);
    expect(input.filter).not.toContain(OTHER_BUG_ID);
    expect(BUG_FOLLOW_COOLDOWN_MS).toBe(30_000);
    expect(bugFollowTriggerName(BUG_ID)).toBe(`bug-follow:${BUG_ID}`);
  });

  it("scopes the filter to this bugId on normalized and flattened payloads", () => {
    const filter = bugFollowFilter(BUG_ID);

    expect(evaluateFilter(filter, watchEvent(BUG_ID))).toBe(true);
    expect(evaluateFilter(filter, { bugId: BUG_ID, title: "flat" })).toBe(true);
    expect(bugFollowMatchesEvent(BUG_ID, watchEvent(BUG_ID))).toBe(true);

    expect(evaluateFilter(filter, watchEvent(OTHER_BUG_ID))).toBe(false);
    expect(evaluateFilter(filter, { bugId: OTHER_BUG_ID })).toBe(false);
    expect(evaluateFilter(filter, { payload: { bugId: OTHER_BUG_ID } })).toBe(false);
    expect(bugFollowMatchesEvent(BUG_ID, watchEvent(OTHER_BUG_ID))).toBe(false);
  });

  it("reuses an existing per-bug trigger instead of creating a broad second one", async () => {
    const existing = {
      id: "trg_existing",
      name: bugFollowTriggerName(BUG_ID),
      topic: BUG_STATUS_WATCH_TOPIC,
      message: BUG_FOLLOW_TRIGGER_MESSAGE,
      session: "main" as const,
      filter: bugFollowFilter(BUG_ID),
      enabled: true,
      cooldownMs: BUG_FOLLOW_COOLDOWN_MS,
      fireCount: 0,
      createdAt: 1,
      updatedAt: 1,
    } satisfies Trigger;
    const created: TriggerInput[] = [];

    const result = await ensureBugFollowTrigger(BUG_ID, {
      listTriggers: () => [existing],
      createTrigger: (input) => {
        created.push(input);
        throw new Error("should not create");
      },
      emitTriggersRefresh: async () => {},
      getFollowContext: () => ({ sessionName: "agent:main:main" }),
    });

    expect(result).toEqual({ trigger: existing, reused: true });
    expect(created).toHaveLength(0);
  });

  it("creates a main-session trigger filtered to this bugId when none exists", async () => {
    const created: TriggerInput[] = [];
    const refreshes: number[] = [];

    const result = await ensureBugFollowTrigger(BUG_ID, {
      listTriggers: () => [],
      createTrigger: (input) => {
        created.push(input);
        return {
          id: "trg_new",
          ...input,
          session: input.session ?? "main",
          enabled: true,
          fireCount: 0,
          createdAt: 1,
          updatedAt: 1,
        } as Trigger;
      },
      emitTriggersRefresh: async () => {
        refreshes.push(1);
      },
      getFollowContext: () => ({
        agentId: "main",
        sessionName: "desk",
        sessionKey: "agent:main:main",
      }),
    });

    expect(result.reused).toBe(false);
    expect(result.trigger.id).toBe("trg_new");
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      name: `bug-follow:${BUG_ID}`,
      topic: BUG_STATUS_WATCH_TOPIC,
      session: "main",
      replySession: "desk",
      filter: bugFollowFilter(BUG_ID),
      cooldownMs: 30_000,
    });
    expect(created[0]?.filter).toBe(`data.payload.bugId == "${BUG_ID}" || data.bugId == "${BUG_ID}"`);
    expect(refreshes).toEqual([1]);
    expect(findExistingBugFollowTrigger(OTHER_BUG_ID, [result.trigger])).toBeUndefined();
  });
});
