import { describe, expect, it } from "bun:test";
import { buildOverlayV3PlaceholderSnapshot, type OverlayV3RelayHealth } from "./placeholders.js";

const relay: OverlayV3RelayHealth = {
  status: "running",
  pid: 1234,
  scope: "overlay.whatsapp",
  topicPatterns: ["ravi.session.>"],
  lastHeartbeatAt: "2026-03-28T14:00:00.000Z",
  lastCursor: "local:4",
  lastError: null,
  hasHello: true,
  hasSnapshot: true,
};

describe("whatsapp overlay v3 placeholders", () => {
  it("builds mapped placeholders and missing component slots from published state", () => {
    const snapshot = buildOverlayV3PlaceholderSnapshot({
      relay,
      publishedState: {
        clientId: "client-1",
        app: "whatsapp-web",
        context: { title: "Ravi - Dev", chatId: "120363424772797713@g.us", session: "dev" },
        postedAt: 1_700_000_000_000,
        view: {
          screen: "conversation",
          title: "Ravi - Dev",
          selectedChat: "Ravi - Dev",
          chatIdCandidate: "120363424772797713@g.us",
          components: [
            {
              id: "chat-list",
              surface: "chat-list-pane",
              selector: "[data-testid='chat-list']",
              score: 90,
              confidence: "high",
              signals: ["scrollable", "left-pane"],
            },
            {
              id: "timeline",
              surface: "conversation-pane",
              selector: "[data-testid='conversation-panel-body']",
              score: 95,
              confidence: "high",
              count: 18,
              signals: ["scrollable", "center-pane"],
            },
          ],
          chatRows: [{ id: "row-1", title: "Ravi - Dev" }],
        },
      },
    });

    expect(snapshot.ok).toBe(true);
    expect(snapshot.enabled).toBe(true);
    expect(snapshot.page.screen).toBe("conversation");
    expect(snapshot.placeholders).toHaveLength(2);
    expect(snapshot.placeholders[0]).toMatchObject({
      componentId: "chat-list",
      label: "chat list",
      status: "mapped",
    });
    expect(snapshot.placeholders[1]).toMatchObject({
      componentId: "timeline",
      count: 18,
      status: "mapped",
    });
    expect(snapshot.missing.some((entry) => entry.componentId === "composer")).toBe(true);
    expect(snapshot.relay.scope).toBe("overlay.whatsapp");
  });

  it("stays disabled when no page components were published yet", () => {
    const snapshot = buildOverlayV3PlaceholderSnapshot({
      relay: { ...relay, status: "starting", hasSnapshot: false },
      publishedState: null,
    });

    expect(snapshot.enabled).toBe(false);
    expect(snapshot.placeholders).toHaveLength(0);
    expect(snapshot.page.screen).toBeNull();
    expect(snapshot.missing.length).toBeGreaterThan(0);
  });
});
