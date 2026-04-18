import { describe, expect, it } from "bun:test";
import type { SessionEntry } from "../router/types.js";
import {
  buildOverlaySessionWorkspaceTimeline,
  buildOverlaySessionList,
  buildChatIdVariants,
  buildOverlaySnapshot,
  mergeOverlaySessionWorkspaceMessages,
  parseOverlayTimestamp,
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

  it("parses sqlite timestamps into epoch milliseconds", () => {
    expect(parseOverlayTimestamp("2026-04-12 03:04:05")).toBe(Date.parse("2026-04-12T03:04:05Z"));
  });

  it("merges recent history with provider-session history without dropping assistant replies", () => {
    const merged = mergeOverlaySessionWorkspaceMessages(
      [
        {
          id: "100",
          role: "user",
          content: "primeira pergunta",
          createdAt: Date.parse("2026-04-12T03:00:00Z"),
        },
        {
          id: "101",
          role: "assistant",
          content: "primeira resposta",
          createdAt: Date.parse("2026-04-12T03:00:10Z"),
        },
        {
          id: "102",
          role: "user",
          content: "segunda pergunta",
          createdAt: Date.parse("2026-04-12T03:01:00Z"),
        },
      ],
      [
        {
          id: "102",
          role: "user",
          content: "segunda pergunta",
          createdAt: Date.parse("2026-04-12T03:01:00Z"),
        },
        {
          id: "103",
          role: "assistant",
          content: "segunda resposta",
          createdAt: Date.parse("2026-04-12T03:01:12Z"),
        },
      ],
    );

    expect(merged.map((message) => message.id)).toEqual(["100", "101", "102", "103"]);
    expect(merged[1]).toMatchObject({
      role: "assistant",
      content: "primeira resposta",
    });
    expect(merged[3]).toMatchObject({
      role: "assistant",
      content: "segunda resposta",
    });
  });

  it("builds one chronological session workspace timeline", () => {
    const timeline = buildOverlaySessionWorkspaceTimeline({
      messages: [
        {
          id: "101",
          role: "user",
          content: "mensagem histórica",
          createdAt: Date.parse("2026-04-12T03:00:00Z"),
        },
      ],
      live: {
        activity: "streaming",
        events: [
          {
            kind: "prompt",
            label: "prompt",
            detail: "mensagem histórica",
            timestamp: Date.parse("2026-04-12T03:00:05Z"),
          },
          {
            kind: "approval",
            label: "approval",
            detail: "pending",
            timestamp: Date.parse("2026-04-12T03:01:00Z"),
          },
          {
            kind: "stream",
            label: "stream",
            detail: "resposta parcial",
            timestamp: Date.parse("2026-04-12T03:02:00Z"),
          },
          {
            kind: "response",
            label: "response",
            detail: "resposta parcial mais completa",
            timestamp: Date.parse("2026-04-12T03:02:30Z"),
          },
        ],
        artifacts: [
          {
            id: "tool-1",
            kind: "tool",
            label: "bash",
            detail: "bun test src/whatsapp-overlay/model.test.ts",
            createdAt: Date.parse("2026-04-12T03:01:30Z"),
            updatedAt: Date.parse("2026-04-12T03:01:45Z"),
          },
        ],
      },
    });

    expect(timeline).toHaveLength(4);
    expect(timeline.map((item) => item.type)).toEqual(["message", "event", "artifact", "message"]);
    expect(timeline[0]).toMatchObject({
      type: "message",
      role: "user",
      content: "mensagem histórica",
      source: "history",
    });
    expect(timeline[1]).toMatchObject({
      type: "event",
      kind: "approval",
      detail: "pending",
    });
    expect(timeline[2]).toMatchObject({
      type: "artifact",
      kind: "tool",
      label: "bash",
    });
    expect(timeline[3]).toMatchObject({
      type: "message",
      role: "assistant",
      content: "resposta parcial mais completa",
      pending: true,
      source: "live",
      eventKind: "response",
    });
  });

  it("keeps the live assistant message visible when activity leaves streaming", () => {
    const timeline = buildOverlaySessionWorkspaceTimeline({
      messages: [],
      live: {
        activity: "thinking",
        events: [
          {
            kind: "stream",
            label: "stream",
            detail: "resposta parcial ainda viva",
            timestamp: Date.parse("2026-04-12T03:02:00Z"),
          },
          {
            kind: "tool",
            label: "bash",
            detail: "executando",
            timestamp: Date.parse("2026-04-12T03:02:05Z"),
          },
        ],
      },
    });

    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({
      type: "message",
      role: "assistant",
      content: "resposta parcial ainda viva",
      pending: true,
      source: "live",
      eventKind: "stream",
    });
  });

  it("does not collapse repeated live replies that happen in different turns", () => {
    const timeline = buildOverlaySessionWorkspaceTimeline({
      messages: [],
      live: {
        activity: "thinking",
        events: [
          {
            kind: "response",
            label: "response",
            detail: "ok",
            timestamp: Date.parse("2026-04-12T03:02:00Z"),
          },
          {
            kind: "response",
            label: "response",
            detail: "ok",
            timestamp: Date.parse("2026-04-12T03:12:00Z"),
          },
        ],
      },
    });

    expect(timeline.filter((item) => item.type === "message")).toHaveLength(2);
    expect(timeline.map((item) => item.timestamp)).toEqual([
      Date.parse("2026-04-12T03:02:00Z"),
      Date.parse("2026-04-12T03:12:00Z"),
    ]);
  });

  it("does not hide a new live reply just because an older history message has the same text", () => {
    const timeline = buildOverlaySessionWorkspaceTimeline({
      messages: [
        {
          id: "history-1",
          role: "assistant",
          content: "ok",
          createdAt: Date.parse("2026-04-12T03:00:00Z"),
        },
      ],
      live: {
        activity: "thinking",
        events: [
          {
            kind: "response",
            label: "response",
            detail: "ok",
            timestamp: Date.parse("2026-04-12T03:10:00Z"),
          },
        ],
      },
    });

    expect(timeline.filter((item) => item.type === "message")).toHaveLength(2);
    expect(timeline[0]).toMatchObject({
      type: "message",
      source: "history",
      content: "ok",
    });
    expect(timeline[1]).toMatchObject({
      type: "message",
      source: "live",
      content: "ok",
      pending: true,
    });
  });

  it("preserves compact tool metadata in the timeline artifact", () => {
    const timeline = buildOverlaySessionWorkspaceTimeline({
      messages: [],
      live: {
        activity: "thinking",
        artifacts: [
          {
            id: "tool-compact",
            kind: "tool",
            label: "bash",
            description: "cmd=git status",
            preview: "ok · clean",
            fullDetail: "status: ok\n\nresult:\nclean",
            status: "ok",
            detail: "ok · clean",
            createdAt: Date.parse("2026-04-12T03:10:00Z"),
            updatedAt: Date.parse("2026-04-12T03:10:04Z"),
          },
        ],
      },
    });

    expect(timeline[0]).toMatchObject({
      type: "artifact",
      kind: "tool",
      label: "bash",
      description: "cmd=git status",
      preview: "ok · clean",
      fullDetail: "status: ok\n\nresult:\nclean",
      status: "ok",
      timestamp: Date.parse("2026-04-12T03:10:00Z"),
    });
  });

  it("preserves runtime graph metadata on operational timeline items", () => {
    const runtimeMetadata = {
      provider: "codex",
      thread: { id: "thread_1" },
      turn: { id: "turn_1" },
    };
    const approvalMetadata = {
      provider: "codex",
      thread: { id: "thread_1" },
      turn: { id: "turn_1" },
      item: { id: "approval_1", type: "approval_request" },
    };
    const streamMetadata = {
      provider: "codex",
      thread: { id: "thread_1" },
      turn: { id: "turn_1" },
      item: { id: "message_1", type: "assistant_message_delta" },
    };
    const toolMetadata = {
      provider: "codex",
      thread: { id: "thread_1" },
      turn: { id: "turn_1" },
      item: { id: "tool_1", type: "tool_call", status: "completed" },
    };

    const timeline = buildOverlaySessionWorkspaceTimeline({
      messages: [],
      live: {
        activity: "thinking",
        events: [
          {
            kind: "runtime",
            label: "runtime graph",
            detail: "thread.started thread=thread_1",
            timestamp: Date.parse("2026-04-12T03:00:00Z"),
            metadata: runtimeMetadata,
          },
          {
            kind: "approval",
            label: "runtime approval",
            detail: "command_execution · pending",
            timestamp: Date.parse("2026-04-12T03:00:01Z"),
            metadata: approvalMetadata,
          },
          {
            kind: "stream",
            label: "stream",
            detail: "resposta parcial",
            timestamp: Date.parse("2026-04-12T03:00:03Z"),
            metadata: streamMetadata,
          },
        ],
        artifacts: [
          {
            id: "tool-1",
            kind: "tool",
            label: "bash",
            detail: "ok",
            createdAt: Date.parse("2026-04-12T03:00:02Z"),
            metadata: toolMetadata,
          },
        ],
      },
    });

    const runtimeEvent = timeline.find((item) => item.type === "event" && item.label === "runtime graph");
    expect(runtimeEvent).toMatchObject({
      type: "event",
      kind: "runtime",
      detail: "thread.started thread=thread_1",
      metadata: runtimeMetadata,
    });

    const approvalEvent = timeline.find((item) => item.type === "event" && item.kind === "approval");
    expect(approvalEvent).toMatchObject({
      type: "event",
      label: "runtime approval",
      metadata: approvalMetadata,
    });

    const streamMessage = timeline.find((item) => item.type === "message" && item.eventKind === "stream");
    expect(streamMessage).toMatchObject({
      type: "message",
      role: "assistant",
      content: "resposta parcial",
      metadata: streamMetadata,
    });

    const toolArtifact = timeline.find((item) => item.type === "artifact" && item.kind === "tool");
    expect(toolArtifact).toMatchObject({
      type: "artifact",
      label: "bash",
      metadata: toolMetadata,
    });
  });

  it("suppresses kind:tool events when tool artifacts exist", () => {
    const timeline = buildOverlaySessionWorkspaceTimeline({
      messages: [],
      live: {
        activity: "thinking",
        events: [
          {
            kind: "tool",
            label: "bash",
            detail: "bun test",
            timestamp: Date.parse("2026-04-12T03:01:00Z"),
          },
          {
            kind: "tool",
            label: "bash",
            detail: "running",
            timestamp: Date.parse("2026-04-12T03:01:01Z"),
          },
          {
            kind: "tool",
            label: "bash",
            detail: "finished",
            timestamp: Date.parse("2026-04-12T03:01:05Z"),
          },
        ],
        artifacts: [
          {
            id: "tool-1",
            kind: "tool",
            label: "bash",
            description: "cmd=bun test",
            preview: "ok · 4s",
            fullDetail: "stdout: all tests passed",
            status: "ok",
            detail: "ok · 4s",
            createdAt: Date.parse("2026-04-12T03:01:00Z"),
            updatedAt: Date.parse("2026-04-12T03:01:05Z"),
          },
        ],
      },
    });

    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({
      type: "artifact",
      kind: "tool",
      label: "bash",
      description: "cmd=bun test",
      preview: "ok · 4s",
      status: "ok",
    });
  });

  it("suppresses runtime tool-lifecycle events near tool artifacts", () => {
    const timeline = buildOverlaySessionWorkspaceTimeline({
      messages: [],
      live: {
        activity: "thinking",
        events: [
          {
            kind: "runtime",
            label: "runtime",
            detail: "running",
            timestamp: Date.parse("2026-04-12T03:01:01Z"),
          },
          {
            kind: "runtime",
            label: "runtime",
            detail: "finished",
            timestamp: Date.parse("2026-04-12T03:01:06Z"),
          },
          {
            kind: "approval",
            label: "approval",
            detail: "pending",
            timestamp: Date.parse("2026-04-12T03:00:59Z"),
          },
        ],
        artifacts: [
          {
            id: "tool-1",
            kind: "tool",
            label: "bash",
            detail: "bun test",
            createdAt: Date.parse("2026-04-12T03:01:00Z"),
            updatedAt: Date.parse("2026-04-12T03:01:05Z"),
          },
        ],
      },
    });

    const types = timeline.map((item) => item.type);
    expect(types).toContain("artifact");
    expect(types).toContain("event");
    expect(timeline.filter((item) => item.type === "event")).toHaveLength(1);
    expect(timeline.find((item) => item.type === "event")).toMatchObject({
      kind: "approval",
      detail: "pending",
    });
  });

  it("keeps non-tool events even when tool artifacts exist", () => {
    const timeline = buildOverlaySessionWorkspaceTimeline({
      messages: [],
      live: {
        activity: "thinking",
        events: [
          {
            kind: "approval",
            label: "approval",
            detail: "pending",
            timestamp: Date.parse("2026-04-12T03:00:30Z"),
          },
          {
            kind: "runtime",
            label: "runtime",
            detail: "compacting",
            timestamp: Date.parse("2026-04-12T03:03:00Z"),
          },
        ],
        artifacts: [
          {
            id: "tool-1",
            kind: "tool",
            label: "bash",
            detail: "git status",
            createdAt: Date.parse("2026-04-12T03:01:00Z"),
            updatedAt: Date.parse("2026-04-12T03:01:03Z"),
          },
        ],
      },
    });

    const events = timeline.filter((item) => item.type === "event");
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ kind: "approval", detail: "pending" });
    expect(events[1]).toMatchObject({ kind: "runtime", detail: "compacting" });
  });

  it("shows tool events as event items when no tool artifacts exist", () => {
    const timeline = buildOverlaySessionWorkspaceTimeline({
      messages: [],
      live: {
        activity: "thinking",
        events: [
          {
            kind: "runtime",
            label: "runtime",
            detail: "running",
            timestamp: Date.parse("2026-04-12T03:01:00Z"),
          },
        ],
      },
    });

    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({
      type: "event",
      kind: "runtime",
      detail: "running",
    });
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

  it("builds recent sessions by last activity with the newest recent entry first", () => {
    const now = Date.now();
    const sessions = [
      makeSession({
        name: "dev-main",
        agentId: "main",
        displayName: "Ravi - Dev",
        lastChannel: "whatsapp",
        lastTo: "120363424772797713@g.us",
        updatedAt: now,
        createdAt: now - 10_000,
      }),
      makeSession({
        name: "sales-a",
        agentId: "sales",
        displayName: "Ops sem chat",
        updatedAt: now - 1_000,
        createdAt: now - 5_000,
      }),
      makeSession({
        name: "sales-b",
        agentId: "ops",
        displayName: "Leads duplicado",
        lastChannel: "whatsapp",
        lastTo: "5511999999999@s.whatsapp.net",
        updatedAt: now - 10_000,
        createdAt: now - 1_000,
      }),
      makeSession({
        name: "ops-stale",
        agentId: "ops",
        displayName: "Ops",
        lastChannel: "whatsapp",
        lastTo: "5511777777777@s.whatsapp.net",
        updatedAt: now - 2 * 24 * 60 * 60 * 1000,
        createdAt: now - 2 * 24 * 60 * 60 * 1000,
      }),
      makeSession({
        name: "telegram-recent",
        agentId: "tg",
        displayName: "Telegram",
        lastChannel: "telegram",
        lastTo: "chat-1",
        updatedAt: now - 2_000,
        createdAt: now - 2_000,
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

  it("keeps old persistent sessions recent when they were active recently", () => {
    const now = Date.now();
    const sessions = [
      makeSession({
        name: "dev",
        agentId: "main",
        displayName: "Ravi - Dev",
        lastChannel: "whatsapp",
        lastTo: "120363424772797713@g.us",
        updatedAt: now - 500,
        createdAt: now - 14 * 24 * 60 * 60 * 1000,
      }),
      makeSession({
        name: "task-brand-new",
        agentId: "worker",
        displayName: "Task worker",
        updatedAt: now - 5_000,
        createdAt: now - 100,
      }),
      makeSession({
        name: "stale-but-newer-than-dev",
        agentId: "ops",
        displayName: "Stale session",
        lastChannel: "whatsapp",
        lastTo: "5511999999999@s.whatsapp.net",
        updatedAt: now - 2 * 24 * 60 * 60 * 1000,
        createdAt: now - 50,
      }),
    ];

    const snapshot = buildOverlaySnapshot({
      query: { title: "Ravi - Dev" },
      sessions,
    });

    expect(snapshot.recentSessions.map((session) => session.sessionName)).toEqual(["dev", "task-brand-new"]);
    expect(snapshot.recentSessions.some((session) => session.sessionName === "stale-but-newer-than-dev")).toBe(false);
  });

  it("uses live activity timestamps when ranking recent idle sessions", () => {
    const now = Date.now();
    const sessions = [
      makeSession({
        name: "persisted-old",
        agentId: "main",
        displayName: "Persisted old",
        updatedAt: now - 3 * 24 * 60 * 60 * 1000,
        createdAt: now - 30 * 24 * 60 * 60 * 1000,
      }),
      makeSession({
        name: "normal-recent",
        agentId: "ops",
        displayName: "Normal recent",
        updatedAt: now - 1_000,
        createdAt: now - 1_000,
      }),
    ];
    const live = new Map<string, OverlayLiveState>([["persisted-old", { activity: "idle", updatedAt: now }]]);

    const snapshot = buildOverlaySnapshot({
      query: { session: "persisted-old" },
      sessions,
      liveBySessionName: live,
    });

    expect(snapshot.recentSessions.map((session) => session.sessionName)).toEqual(["persisted-old", "normal-recent"]);
    expect(snapshot.recentSessions[0]?.live.updatedAt).toBe(now);
  });

  it("builds active sessions only from explicit live activity", () => {
    const now = Date.now();
    const sessions = [
      makeSession({
        name: "thinking-session",
        displayName: "Thinking",
        updatedAt: now - 1_000,
        createdAt: now - 20_000,
      }),
      makeSession({
        name: "idle-chat",
        displayName: "Idle",
        lastChannel: "whatsapp",
        lastTo: "5511222222222@s.whatsapp.net",
        updatedAt: now - 2_000,
        createdAt: now - 10_000,
      }),
      makeSession({
        name: "aborted-stale",
        displayName: "Aborted stale",
        updatedAt: now - 500,
        createdAt: now - 30_000,
        abortedLastRun: true,
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

    expect(snapshot.activeSessions).toHaveLength(1);
    expect(snapshot.hotSessions).toEqual(snapshot.activeSessions);
    expect(snapshot.activeSessions[0]).toMatchObject({
      sessionName: "thinking-session",
      displayName: "Thinking",
      chatId: null,
    });
  });

  it("keeps active sessions oldest-first and excludes them from recent sessions", () => {
    const now = Date.now();
    const sessions = [
      makeSession({
        sessionKey: "agent:ops:dm:1",
        name: "old-active",
        agentId: "ops",
        displayName: "Old active",
        updatedAt: now - 2_000,
        createdAt: now - 20_000,
      }),
      makeSession({
        sessionKey: "agent:ops:dm:2",
        name: "new-active",
        agentId: "ops",
        displayName: "New active",
        updatedAt: now - 1_000,
        createdAt: now - 5_000,
      }),
      makeSession({
        sessionKey: "agent:ops:dm:3",
        name: "recent-idle",
        agentId: "ops",
        displayName: "Recent idle",
        updatedAt: now - 500,
        createdAt: now - 1_000,
      }),
      makeSession({
        sessionKey: "agent:ops:dm:4",
        name: "older-idle",
        agentId: "ops",
        displayName: "Older idle",
        updatedAt: now - 3_000,
        createdAt: now - 10_000,
      }),
    ];
    const live = new Map<string, OverlayLiveState>([
      ["old-active", { activity: "thinking", updatedAt: now - 100 }],
      ["new-active", { activity: "streaming", updatedAt: now }],
    ]);

    const snapshot = buildOverlaySnapshot({
      query: { session: "new-active" },
      sessions,
      liveBySessionName: live,
    });

    expect(snapshot.activeSessions.map((session) => session.sessionName)).toEqual(["old-active", "new-active"]);
    expect(snapshot.recentSessions.map((session) => session.sessionName)).toEqual(["recent-idle", "older-idle"]);
  });

  it("does not cap active sessions when more than eight are live", () => {
    const now = Date.now();
    const sessions = Array.from({ length: 10 }, (_, index) =>
      makeSession({
        sessionKey: `agent:ops:dm:${index}`,
        name: `active-${index}`,
        agentId: "ops",
        displayName: `Active ${index}`,
        updatedAt: now - (10 - index) * 100,
        createdAt: now - (10 - index) * 1_000,
      }),
    );
    const live = new Map<string, OverlayLiveState>(
      sessions.map((session, index) => [
        session.name ?? session.sessionKey,
        { activity: index % 2 === 0 ? "thinking" : "streaming", updatedAt: now - index },
      ]),
    );

    const snapshot = buildOverlaySnapshot({
      query: { session: "active-9" },
      sessions,
      liveBySessionName: live,
    });

    expect(snapshot.activeSessions.map((session) => session.sessionName)).toEqual([
      "active-0",
      "active-1",
      "active-2",
      "active-3",
      "active-4",
      "active-5",
      "active-6",
      "active-7",
      "active-8",
      "active-9",
    ]);
    expect(snapshot.recentSessions).toEqual([]);
  });

  it("removes active sessions linked to terminal tasks by canonical session join", () => {
    const now = Date.now();
    const sessions = [
      makeSession({
        name: "task-done-work",
        displayName: "Done task",
        updatedAt: now - 2_000,
        createdAt: now - 20_000,
      }),
      makeSession({
        name: "task-active-work",
        displayName: "Active task",
        updatedAt: now - 1_000,
        createdAt: now - 10_000,
      }),
    ];
    const live = new Map<string, OverlayLiveState>([
      ["task-done-work", { activity: "thinking", updatedAt: now }],
      ["task-active-work", { activity: "thinking", updatedAt: now - 250 }],
    ]);

    const snapshot = buildOverlaySnapshot({
      query: { title: "Active task" },
      sessions,
      liveBySessionName: live,
      taskSessions: [
        {
          id: "task-done",
          status: "done",
          updatedAt: now,
          workSessionName: "task-done-work",
          assigneeSessionName: null,
          taskProfile: { sessionNameTemplate: "<task-id>-work" },
        },
        {
          id: "task-active",
          status: "in_progress",
          updatedAt: now - 100,
          workSessionName: null,
          assigneeSessionName: "task-active-work",
          taskProfile: { sessionNameTemplate: "<task-id>-work" },
        },
      ],
    });

    expect(snapshot.activeSessions).toHaveLength(1);
    expect(snapshot.activeSessions[0]?.sessionName).toBe("task-active-work");
  });

  it("keeps normal sessions active after a task assigned to them reaches terminal state", () => {
    const now = Date.now();
    const sessions = [
      makeSession({
        name: "dev",
        displayName: "Ravi - Dev",
        updatedAt: now - 500,
        createdAt: now - 30 * 24 * 60 * 60 * 1000,
      }),
    ];
    const live = new Map<string, OverlayLiveState>([["dev", { activity: "thinking", updatedAt: now }]]);

    const snapshot = buildOverlaySnapshot({
      query: { session: "dev" },
      sessions,
      liveBySessionName: live,
      taskSessions: [
        {
          id: "task-normal-session",
          status: "done",
          archivedAt: null,
          updatedAt: now - 100,
          workSessionName: null,
          assigneeSessionName: "dev",
          taskProfile: { sessionNameTemplate: "<task-id>-work" },
        },
      ],
    });

    expect(snapshot.activeSessions).toHaveLength(1);
    expect(snapshot.activeSessions[0]?.sessionName).toBe("dev");
  });

  it("treats close-created custom sessions as genuine task sessions without relying on names", () => {
    const now = Date.now();
    const sessions = [
      makeSession({
        name: "custom-worker-room",
        displayName: "Custom worker room",
        updatedAt: now - 500,
        createdAt: now - 20_000,
      }),
    ];
    const live = new Map<string, OverlayLiveState>([["custom-worker-room", { activity: "thinking", updatedAt: now }]]);

    const snapshot = buildOverlaySnapshot({
      query: { session: "custom-worker-room" },
      sessions,
      liveBySessionName: live,
      taskSessions: [
        {
          id: "task-custom",
          status: "done",
          archivedAt: null,
          createdAt: now - 22_000,
          updatedAt: now - 100,
          workSessionName: "custom-worker-room",
          assigneeSessionName: null,
          taskProfile: { sessionNameTemplate: "<task-id>-work" },
        },
      ],
    });

    expect(snapshot.activeSessions).toEqual([]);
    expect(snapshot.hotSessions).toEqual([]);
  });

  it("keeps an active session visible when a newer live task supersedes an older terminal task on the same session", () => {
    const now = Date.now();
    const sessions = [
      makeSession({
        name: "shared-task-session",
        displayName: "Shared task session",
        updatedAt: now - 1_000,
        createdAt: now - 10_000,
      }),
    ];
    const live = new Map<string, OverlayLiveState>([
      ["shared-task-session", { activity: "streaming", updatedAt: now }],
    ]);

    const snapshot = buildOverlaySnapshot({
      query: { session: "shared-task-session" },
      sessions,
      liveBySessionName: live,
      taskSessions: [
        {
          status: "done",
          archivedAt: null,
          updatedAt: now - 10_000,
          workSessionName: "shared-task-session",
          assigneeSessionName: null,
        },
        {
          status: "blocked",
          archivedAt: null,
          updatedAt: now - 100,
          workSessionName: null,
          assigneeSessionName: "shared-task-session",
        },
      ],
    });

    expect(snapshot.activeSessions).toHaveLength(1);
    expect(snapshot.activeSessions[0]?.sessionName).toBe("shared-task-session");
  });

  it("removes active sessions linked to archived tasks", () => {
    const now = Date.now();
    const sessions = [
      makeSession({
        name: "task-archived-work",
        displayName: "Archived task",
        updatedAt: now - 500,
        createdAt: now - 10_000,
      }),
    ];
    const live = new Map<string, OverlayLiveState>([["task-archived-work", { activity: "thinking", updatedAt: now }]]);

    const snapshot = buildOverlaySnapshot({
      query: { session: "task-archived-work" },
      sessions,
      liveBySessionName: live,
      taskSessions: [
        {
          id: "task-archived",
          status: "done",
          archivedAt: now - 50,
          updatedAt: now - 50,
          workSessionName: "task-archived-work",
          assigneeSessionName: null,
          taskProfile: { sessionNameTemplate: "<task-id>-work" },
        },
      ],
    });

    expect(snapshot.activeSessions).toEqual([]);
    expect(snapshot.hotSessions).toEqual([]);
  });
});
