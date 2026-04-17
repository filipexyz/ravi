import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { closeInsightsDb, dbAddInsightComment, dbCreateInsight } from "../insights/index.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { buildOverlayInsightsPayload } from "./insights.js";

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-wa-overlay-insights-");
  closeInsightsDb();
});

afterEach(async () => {
  closeInsightsDb();
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

function makeTask(taskId: string, title: string) {
  return {
    id: taskId,
    title,
    instructions: "ship it",
    status: "blocked",
    priority: "high",
    progress: 65,
    profileId: "default",
    taskProfile: {} as never,
    checkpointIntervalMs: null,
    reportToSessionName: null,
    reportEvents: [],
    parentTaskId: null,
    taskDir: null,
    createdBy: null,
    createdByAgentId: null,
    createdBySessionName: null,
    assigneeAgentId: "main",
    assigneeSessionName: "dev-main",
    workSessionName: "dev-main",
    worktree: null,
    summary: "blocked by missing lineage",
    blockerReason: "lineage gap",
    archivedAt: null,
    archivedBy: null,
    archiveReason: null,
    createdAt: 1,
    updatedAt: 2,
    dispatchedAt: null,
    startedAt: null,
    completedAt: null,
    artifacts: {
      primary: null,
      supporting: [],
      terminal: [],
    },
  };
}

describe("buildOverlayInsightsPayload", () => {
  it("surfaces explicit and synthetic lineage for the overlay", () => {
    const created = dbCreateInsight({
      summary: "Overlay precisa mostrar lineage clicavel no feed.",
      detail: "Sem task/session/agent surfaced, o insight fica solto para operacao.",
      kind: "improvement",
      confidence: "high",
      importance: "high",
      author: {
        kind: "agent",
        name: "dev-main",
        agentId: "main",
        sessionName: "dev-main",
        sessionKey: "agent:main:dev-main",
      },
      origin: {
        kind: "runtime-context",
        taskId: "task-123",
        sessionName: "dev-main",
        agentId: "main",
      },
      links: [
        {
          targetType: "task",
          targetId: "task-123",
        },
        {
          targetType: "artifact",
          targetId: "/tmp/task-123/TASK.md",
        },
        {
          targetType: "profile",
          targetId: "default",
        },
      ],
    });

    dbAddInsightComment({
      insightId: created.id,
      body: "Confirmed while wiring the new overlay tab.",
      author: created.author,
    });

    const sessions = [
      {
        sessionKey: "agent:main:dev-main",
        name: "dev-main",
        agentId: "main",
        agentCwd: "/tmp/dev-main",
        updatedAt: 100,
        createdAt: 50,
        lastTo: "5511999999999@s.whatsapp.net",
      },
    ];

    const payload = buildOverlayInsightsPayload({
      limit: 10,
      sessions: sessions as never,
      liveBySessionName: new Map([
        [
          "dev-main",
          {
            activity: "thinking",
            updatedAt: 100,
          },
        ],
      ]),
      resolveTask(taskId) {
        return taskId === "task-123" ? (makeTask(taskId, "Overlay insights tab") as never) : null;
      },
      resolveSession(nameOrKey) {
        return sessions.find((session) => session.name === nameOrKey || session.sessionKey === nameOrKey) as never;
      },
      resolveAgentName(agentId) {
        return agentId === "main" ? "Main Agent" : null;
      },
    });

    expect(payload.stats.total).toBe(1);
    expect(payload.stats.highImportance).toBe(1);
    expect(payload.stats.withLineage).toBe(1);
    expect(payload.stats.byKind.improvement).toBe(1);

    const item = payload.items[0];
    expect(item?.latestComment).toContain("Confirmed while wiring");

    const taskLink = item?.links.find((link) => link.targetType === "task");
    expect(taskLink?.action).toBe("focus-task");
    expect(taskLink?.task?.title).toBe("Overlay insights tab");

    const sessionLink = item?.links.find((link) => link.targetType === "session");
    expect(sessionLink?.action).toBe("open-session");
    expect(sessionLink?.session?.sessionKey).toBe("agent:main:dev-main");
    expect(sessionLink?.session?.activity).toBe("thinking");

    const agentLink = item?.links.find((link) => link.targetType === "agent");
    expect(agentLink?.action).toBe("open-agent-session");
    expect(agentLink?.agent?.name).toBe("Main Agent");
    expect(agentLink?.agent?.session?.sessionName).toBe("dev-main");

    const artifactLink = item?.links.find((link) => link.targetType === "artifact");
    expect(artifactLink?.action).toBe("copy");
    expect(artifactLink?.value).toBe("TASK.md");

    const profileLink = item?.links.find((link) => link.targetType === "profile");
    expect(profileLink?.action).toBe("copy");
    expect(profileLink?.value).toBe("default");
  });
});
