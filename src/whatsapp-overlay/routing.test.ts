import { describe, expect, it } from "bun:test";
import { deriveOmniRouteTarget, isOmniGroupChat } from "./routing.js";

describe("whatsapp overlay routing helpers", () => {
  it("derives a group route target from a WhatsApp group JID", () => {
    const target = deriveOmniRouteTarget({
      chatId: "120363424772797713@g.us",
      instanceName: "luis",
      chatType: "group",
      title: "Ravi - Dev",
    });

    expect(target).toEqual({
      instanceName: "luis",
      sourceChatId: "120363424772797713@g.us",
      routePattern: "group:120363424772797713",
      peerKind: "group",
      peerId: "group:120363424772797713",
      chatType: "group",
      groupId: "group:120363424772797713",
      title: "Ravi - Dev",
    });
  });

  it("derives a DM route target from a WhatsApp DM JID", () => {
    const target = deriveOmniRouteTarget({
      chatId: "5511999999999@s.whatsapp.net",
      instanceName: "main",
      chatType: "dm",
      title: "Luís",
    });

    expect(target).toEqual({
      instanceName: "main",
      sourceChatId: "5511999999999@s.whatsapp.net",
      routePattern: "5511999999999",
      peerKind: "dm",
      peerId: "5511999999999",
      chatType: "dm",
      groupId: null,
      title: "Luís",
    });
  });

  it("detects group chats even when chatType is missing", () => {
    expect(isOmniGroupChat("120363424772797713@g.us", null)).toBe(true);
    expect(isOmniGroupChat("group:120363424772797713", null)).toBe(true);
    expect(isOmniGroupChat("5511999999999@s.whatsapp.net", null)).toBe(false);
  });
});
