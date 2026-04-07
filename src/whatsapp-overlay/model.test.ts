import { describe, expect, it } from "bun:test";
import type { SessionEntry } from "../router/types.js";
import {
  buildOverlaySessionList,
  buildChatIdVariants,
  buildOverlaySnapshot,
  resolveByChatId,
  resolveByTitle,
  upsertOverlayChatArtifact,
  type OverlayLiveState,
} from "./model.js";

function makeSession(overrides: Partial<SessionEntry>): SessionEntry {
  return {
    sessionKey: "agent:main:dm:5511999999999",
    name: "main-luis",
    agentId: "main",
    agentCwd: "/tmp/main",
    updatedAt: 1_700_000_000_000,
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe("whatsapp overlay model", () => {
  it("builds group and dm chatId variants", () => {
    expect(buildChatIdVariants("group:120363")).toEqual(["group:120363", "120363@g.us"]);
    expect(buildChatIdVariants("5511999999999")).toEqual([
      "5511999999999",
      "group:5511999999999",
      "5511999999999@g.us",
      "5511999999999@s.whatsapp.net",
    ]);
  });

  it("resolves by exact chatId across variants", () => {
    const sessions = [
      makeSession({
        sessionKey: "agent:main:whatsapp:group:120363",
        name: "audit",
        chatType: "group",
        lastTo: "120363@g.us",
      }),
    ];

    const matches = resolveByChatId("group:120363", sessions);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.name).toBe("audit");
  });

  it("falls back to title matching when chatId is missing", () => {
    const sessions = [
      makeSession({
        name: "audit-session",
        displayName: "Ravi - Audit",
        lastTo: "120363@g.us",
      }),
    ];

    const matches = resolveByTitle("Ravi - Audit", sessions);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.name).toBe("audit-session");
  });

  it("does not let a short generic session name steal a longer chat title", () => {
    const sessions = [
      makeSession({
        sessionKey: "dev",
        name: "dev",
        lastTo: "120363424772797713@g.us",
        updatedAt: 10,
      }),
      makeSession({
        sessionKey: "agent:achados-ia:whatsapp:main:group:120363424569025729",
        name: "achados-ia-2",
        displayName: "achados-ia",
        lastTo: "120363424569025729@g.us",
        updatedAt: 5,
      }),
    ];

    const matches = resolveByTitle("achados ia - dev", sessions);
    expect(matches[0]?.name).toBe("achados-ia-2");
    expect(matches.some((session) => session.name === "dev")).toBe(false);
  });

  it("fails closed for short generic titles without an exact match", () => {
    const sessions = [
      makeSession({
        sessionKey: "agent:ravi-namastex:whatsapp:main:group:120363404747946247",
        name: "ravi-namastex-ravi-demo",
        displayName: "Ravi Demo",
        lastTo: "group:120363404747946247",
        updatedAt: 10,
      }),
      makeSession({
        sessionKey: "agent:audit:whatsapp:main:group:120363424239734858",
        name: "audit-ravi-audit",
        displayName: "Ravi - Audit",
        lastTo: "120363424239734858@g.us",
        updatedAt: 20,
      }),
    ];

    const matches = resolveByTitle("ravi", sessions);
    expect(matches).toHaveLength(0);
  });

  it("fails closed for single-token dm-style titles without an exact match", () => {
    const sessions = [
      makeSession({
        sessionKey: "agent:marina:whatsapp:main:group:120363409474752492",
        name: "marina-ravi-marina",
        displayName: "Ravi - Marina",
        lastTo: "group:120363409474752492",
        updatedAt: 20,
      }),
    ];

    const matches = resolveByTitle("Marina", sessions);
    expect(matches).toHaveLength(0);
  });

  it("merges live runtime state into the snapshot", () => {
    const session = makeSession({
      name: "dev-main",
      displayName: "Luís Filipe",
      lastTo: "5511999999999@s.whatsapp.net",
      thinkingLevel: "verbose",
    });
    const live = new Map<string, OverlayLiveState>([
      [
        "dev-main",
        {
          activity: "awaiting_approval",
          approvalPending: true,
          summary: "approval pending",
          updatedAt: 42,
          events: [{ kind: "tool", label: "bash", detail: "running", timestamp: 42 }],
          artifacts: [
            {
              id: "artifact-1",
              kind: "interruption",
              label: "interrupção",
              detail: "execução interrompida",
              createdAt: 41,
              anchor: { placement: "after-message-id", messageId: "3EB123" },
            },
          ],
        },
      ],
    ]);

    const snapshot = buildOverlaySnapshot({
      query: { title: "Luís Filipe" },
      sessions: [session],
      liveBySessionName: live,
    });

    expect(snapshot.resolved).toBe(true);
    expect(snapshot.session?.sessionName).toBe("dev-main");
    expect(snapshot.session?.live.activity).toBe("awaiting_approval");
    expect(snapshot.session?.live.approvalPending).toBe(true);
    expect(snapshot.session?.live.events?.[0]).toMatchObject({
      kind: "tool",
      label: "bash",
    });
    expect(snapshot.session?.live.artifacts?.[0]).toMatchObject({
      id: "artifact-1",
      kind: "interruption",
      anchor: { placement: "after-message-id", messageId: "3EB123" },
    });
  });

  it("reconciles artifacts by dedupe key", () => {
    const original = [
      {
        id: "artifact-1",
        kind: "interruption",
        label: "interrupção",
        detail: "primeira versão",
        createdAt: 10,
        dedupeKey: "turn.interrupted",
        anchor: { placement: "after-last-message" as const },
      },
    ];

    const merged = upsertOverlayChatArtifact(original, {
      id: "artifact-2",
      kind: "interruption",
      label: "interrupção",
      detail: "versão reconciliada",
      createdAt: 20,
      dedupeKey: "turn.interrupted",
      anchor: { placement: "after-last-message" },
    });

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      id: "artifact-2",
      detail: "versão reconciliada",
      dedupeKey: "turn.interrupted",
    });
  });

  it("keeps independent artifacts when no dedupe key is provided", () => {
    const original = [
      {
        id: "artifact-1",
        kind: "interruption",
        label: "interrupção",
        detail: "primeira interrupção",
        createdAt: 10,
        anchor: { placement: "after-last-message" as const },
      },
    ];

    const merged = upsertOverlayChatArtifact(original, {
      id: "artifact-2",
      kind: "interruption",
      label: "interrupção",
      detail: "segunda interrupção",
      createdAt: 20,
      anchor: { placement: "after-last-message" },
    });

    expect(merged).toHaveLength(2);
    expect(merged[0]?.id).toBe("artifact-1");
    expect(merged[1]?.id).toBe("artifact-2");
  });

  it("builds session list entries in batch", () => {
    const sessions = [
      makeSession({
        name: "dev",
        displayName: "Ravi - Dev",
        lastTo: "120363424772797713@g.us",
        thinkingLevel: "verbose",
      }),
      makeSession({
        name: "marina",
        displayName: "Marina",
        lastTo: "5511987654321@s.whatsapp.net",
      }),
    ];

    const entries = buildOverlaySessionList({
      entries: [
        { id: "row-1", query: { title: "Ravi - Dev" } },
        { id: "row-2", query: { title: "Marina" } },
        { id: "row-3", query: { title: "Unknown Chat" } },
      ],
      sessions,
    });

    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({
      id: "row-1",
      resolved: true,
      session: {
        sessionName: "dev",
      },
    });
    expect(entries[1]).toMatchObject({
      id: "row-2",
      resolved: true,
      session: {
        sessionName: "marina",
      },
    });
    expect(entries[2]?.resolved).toBe(false);
  });

  it("builds recent sessions as one row per session in the last 24h", () => {
    const now = Date.now();
    const sessions = [
      makeSession({
        name: "dev-main",
        agentId: "main",
        displayName: "Ravi - Dev",
        lastChannel: "whatsapp",
        lastTo: "120363424772797713@g.us",
        updatedAt: now,
      }),
      makeSession({
        name: "sales-a",
        agentId: "sales",
        displayName: "Ops sem chat",
        updatedAt: now - 1_000,
      }),
      makeSession({
        name: "sales-b",
        agentId: "ops",
        displayName: "Leads duplicado",
        lastChannel: "whatsapp",
        lastTo: "5511999999999@s.whatsapp.net",
        updatedAt: now - 10_000,
      }),
      makeSession({
        name: "ops-stale",
        agentId: "ops",
        displayName: "Ops",
        lastChannel: "whatsapp",
        lastTo: "5511777777777@s.whatsapp.net",
        updatedAt: now - 2 * 24 * 60 * 60 * 1000,
      }),
      makeSession({
        name: "telegram-recent",
        agentId: "tg",
        displayName: "Telegram",
        lastChannel: "telegram",
        lastTo: "chat-1",
        updatedAt: now - 2_000,
      }),
    ];

    const snapshot = buildOverlaySnapshot({
      query: { title: "Ravi - Dev" },
      sessions,
    });

    expect(snapshot.session?.agentId).toBe("main");
    expect(snapshot.recentSessions).toHaveLength(3);
    expect(snapshot.recentChats).toEqual(snapshot.recentSessions);
    expect(snapshot.recentSessions[0]).toMatchObject({
      sessionName: "dev-main",
      agentId: "main",
      chatId: "120363424772797713@g.us",
    });
    expect(snapshot.recentSessions[1]).toMatchObject({
      sessionName: "sales-a",
      agentId: "sales",
      chatId: null,
      channel: null,
    });
    expect(snapshot.recentSessions[2]).toMatchObject({
      sessionName: "sales-b",
      agentId: "ops",
      chatId: "5511999999999@s.whatsapp.net",
    });
  });

  it("builds hot sessions from live session activity independently of chat linkage", () => {
    const now = Date.now();
    const sessions = [
      makeSession({
        name: "thinking-session",
        displayName: "Thinking",
        updatedAt: now - 1_000,
      }),
      makeSession({
        name: "idle-chat",
        displayName: "Idle",
        lastChannel: "whatsapp",
        lastTo: "5511222222222@s.whatsapp.net",
        updatedAt: now - 2_000,
      }),
    ];
    const live = new Map<string, OverlayLiveState>([
      ["thinking-session", { activity: "thinking", updatedAt: now }],
      ["idle-chat", { activity: "idle", updatedAt: now - 500 }],
    ]);

    const snapshot = buildOverlaySnapshot({
      query: { title: "Thinking" },
      sessions,
      liveBySessionName: live,
    });

    expect(snapshot.hotSessions).toHaveLength(1);
    expect(snapshot.hotSessions[0]).toMatchObject({
      sessionName: "thinking-session",
      displayName: "Thinking",
      chatId: null,
    });
  });
});
