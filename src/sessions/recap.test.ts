import { describe, expect, it } from "bun:test";
import {
  DEFAULT_SESSION_RECAP_TAIL,
  MAX_SESSION_RECAP_TAIL,
  buildSessionRecap,
  formatSessionRecap,
  parseSessionRecapTailCount,
  truncateRecapText,
} from "./recap.js";

const session = {
  sessionKey: "agent:main:dm:5511999",
  name: "main-dm-5511999",
  displayName: "Luis DM",
  agentId: "main",
  compactionCount: 2,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_100_000,
};

describe("session recap projection", () => {
  it("builds an empty recap when history and goal are missing", () => {
    const recap = buildSessionRecap({ session });

    expect(recap.computed).toBe(true);
    expect(recap.persisted).toBe(false);
    expect(recap.session).toEqual({
      sessionKey: "agent:main:dm:5511999",
      name: "main-dm-5511999",
      displayName: "Luis DM",
      agentId: "main",
      compactionCount: 2,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_100_000,
    });
    expect(recap.goal).toBeNull();
    expect(recap.summary).toBeNull();
    expect(recap.pinned).toEqual([]);
    expect(recap.decisions).toEqual([]);
    expect(recap.openLoops).toEqual([]);
    expect(recap.recent).toMatchObject({
      available: false,
      source: null,
      reason: "No history available",
      limit: DEFAULT_SESSION_RECAP_TAIL,
      totalMessages: 0,
      truncated: false,
      omittedTools: true,
      items: [],
    });
    expect(recap.sources).toEqual({
      sessionRow: true,
      goal: false,
      history: null,
    });
  });

  it("projects a blocked goal reason into openLoops without inventing a summary", () => {
    const recap = buildSessionRecap({
      session,
      goal: {
        sessionKey: session.sessionKey,
        goalId: "goal-1",
        objective: "Prepare the pricing brief",
        status: "blocked",
        tokensUsed: 10,
        timeUsedSeconds: 30,
        blockedReason: "Waiting on Rafa's numbers",
        createdAt: 1,
        updatedAt: 2,
      },
    });

    expect(recap.summary).toBeNull();
    expect(recap.goal?.objective).toBe("Prepare the pricing brief");
    expect(recap.openLoops).toEqual(["Waiting on Rafa's numbers"]);
    expect(recap.sources.goal).toBe(true);
  });

  it("keeps a bounded truncated tail and does not invent decisions", () => {
    const recap = buildSessionRecap({
      session,
      tailLimit: 2,
      maxTextChars: 12,
      history: {
        available: true,
        source: "chat-db",
        totalMessages: 4,
        messages: [
          { role: "user", text: "first", time: "10:00:00" },
          { role: "assistant", text: "ok", time: "10:00:01" },
          { role: "user", text: "please continue this work", time: "10:01:00" },
          { role: "assistant", text: "done", time: "10:01:02" },
        ],
      },
    });

    expect(recap.decisions).toEqual([]);
    expect(recap.recent.totalMessages).toBe(4);
    expect(recap.recent.limit).toBe(2);
    expect(recap.recent.items).toHaveLength(2);
    expect(recap.recent.items[0]).toEqual({
      role: "user",
      text: "please conti…",
      textTruncated: true,
      time: "10:01:00",
    });
    expect(recap.recent.items[1].textTruncated).toBe(false);
    expect(recap.recent.truncated).toBe(true);
    expect(recap.recent.omittedTools).toBe(true);
    expect(recap.sources.history).toBe("chat-db");
  });

  it("caps the requested tail and treats invalid counts as the default", () => {
    expect(parseSessionRecapTailCount("nope")).toBe(DEFAULT_SESSION_RECAP_TAIL);
    expect(parseSessionRecapTailCount("0")).toBe(DEFAULT_SESSION_RECAP_TAIL);
    expect(parseSessionRecapTailCount("999")).toBe(MAX_SESSION_RECAP_TAIL);
    expect(truncateRecapText("short").textTruncated).toBe(false);
  });

  it("formats a compact human recap without dumping missing fields as narrative", () => {
    const text = formatSessionRecap(buildSessionRecap({ session }));
    expect(text).toContain("Session recap: main-dm-5511999");
    expect(text).toContain("sessionKey: agent:main:dm:5511999");
    expect(text).toContain("goal: (none)");
    expect(text).toContain("summary: (empty)");
    expect(text).toContain("recent:");
    expect(text).toContain("(empty)");
  });
});
