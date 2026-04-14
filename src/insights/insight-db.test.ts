import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  closeInsightsDb,
  dbAddInsightComment,
  dbCreateInsight,
  dbGetInsight,
  dbListInsights,
  dbSearchInsights,
  dbUpsertInsightLink,
} from "./index.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-insights-");
  closeInsightsDb();
});

afterEach(async () => {
  closeInsightsDb();
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

describe("insight-db", () => {
  it("persists insights with first-class links, comments and searchable lineage", () => {
    const insight = dbCreateInsight({
      summary: "Agent prompts should record why a route override exists.",
      detail: "Without the rationale, later cleanups remove the override and break the task flow.",
      kind: "pattern",
      confidence: "high",
      importance: "high",
      author: {
        kind: "agent",
        name: "task-8a0dc2ed-work",
        agentId: "dev",
        sessionName: "task-8a0dc2ed-work",
        sessionKey: "agent:dev:main",
        contextId: "ctx_123",
      },
      origin: {
        kind: "runtime-context",
        contextId: "ctx_123",
        agentId: "dev",
        sessionName: "task-8a0dc2ed-work",
      },
      links: [
        {
          targetType: "task",
          targetId: "task-8a0dc2ed",
        },
        {
          targetType: "artifact",
          targetId: "/tmp/TASK.md",
        },
      ],
    });

    expect(insight.links).toHaveLength(2);
    expect(insight.author.agentId).toBe("dev");
    expect(insight.origin.kind).toBe("runtime-context");

    const linked = dbUpsertInsightLink({
      insightId: insight.id,
      targetType: "session",
      targetId: "task-8a0dc2ed-work",
      label: "work session",
      createdBy: insight.author,
    });

    expect(linked.targetType).toBe("session");

    const comment = dbAddInsightComment({
      insightId: insight.id,
      body: "Confirmed again while wiring the new CLI.",
      author: insight.author,
    });

    expect(comment.author.name).toBe("task-8a0dc2ed-work");

    const hydrated = dbGetInsight(insight.id);
    expect(hydrated).not.toBeNull();
    expect(hydrated?.links).toHaveLength(3);
    expect(hydrated?.comments).toHaveLength(1);

    const byTask = dbListInsights({
      linkType: "task",
      linkId: "task-8a0dc2ed",
    });
    expect(byTask.map((item) => item.id)).toContain(insight.id);

    const byAgent = dbListInsights({
      authorAgentId: "dev",
    });
    expect(byAgent).toHaveLength(1);

    const searchResults = dbSearchInsights("confirmed again", {});
    expect(searchResults).toHaveLength(1);
    expect(searchResults[0]?.id).toBe(insight.id);
  });
});
