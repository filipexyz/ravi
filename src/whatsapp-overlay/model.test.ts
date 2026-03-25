import { describe, expect, it } from "bun:test";
import type { SessionEntry } from "../router/types.js";
import {
  buildOverlayChatList,
  buildChatIdVariants,
  buildOverlaySnapshot,
  resolveByChatId,
  resolveByTitle,
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
        { activity: "awaiting_approval", approvalPending: true, summary: "approval pending", updatedAt: 42 },
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
  });

  it("builds chat list entries in batch", () => {
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

    const entries = buildOverlayChatList({
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
});
