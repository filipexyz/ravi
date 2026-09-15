import { describe, expect, it } from "bun:test";
import { canonicalizeRouteIdentity, isBroadcastJid } from "./phone.js";

describe("isBroadcastJid", () => {
  it("recognizes WhatsApp status and broadcast-list feeds", () => {
    expect(isBroadcastJid("status@broadcast")).toBe(true);
    expect(isBroadcastJid("  STATUS@BROADCAST  ")).toBe(true);
    expect(isBroadcastJid("123456@broadcast")).toBe(true);
  });

  it("does not classify users, LIDs, or groups as broadcasts", () => {
    expect(isBroadcastJid("5511999999999@s.whatsapp.net")).toBe(false);
    expect(isBroadcastJid("123456@lid")).toBe(false);
    expect(isBroadcastJid("120363424772797713@g.us")).toBe(false);
  });
});

describe("canonicalizeRouteIdentity", () => {
  it("leaves glob patterns untouched", () => {
    expect(canonicalizeRouteIdentity("5511*")).toBe("5511*");
    expect(canonicalizeRouteIdentity("*")).toBe("*");
    expect(canonicalizeRouteIdentity("  lid:*  ")).toBe("lid:*");
  });

  it("maps WhatsApp LID JID and lid: prefix to lid:<digits>", () => {
    expect(canonicalizeRouteIdentity("224420715061374@lid")).toBe("lid:224420715061374");
    expect(canonicalizeRouteIdentity("lid:224420715061374")).toBe("lid:224420715061374");
    expect(canonicalizeRouteIdentity("lid:224420715061374@lid")).toBe("lid:224420715061374");
  });

  it("maps WhatsApp user JID and E.164 to digits", () => {
    expect(canonicalizeRouteIdentity("5511999999999@s.whatsapp.net")).toBe("5511999999999");
    expect(canonicalizeRouteIdentity("+55 11 99999-9999")).toBe("5511999999999");
    expect(canonicalizeRouteIdentity("5511999999999")).toBe("5511999999999");
  });

  it("keeps group: and thread: prefixes and group JIDs", () => {
    expect(canonicalizeRouteIdentity("120363424772797713@g.us")).toBe("group:120363424772797713");
    expect(canonicalizeRouteIdentity("group:120363424772797713")).toBe("group:120363424772797713");
    expect(canonicalizeRouteIdentity("thread:abc123")).toBe("thread:abc123");
  });

  it("does not strip Slack / Discord / Telegram ids", () => {
    expect(canonicalizeRouteIdentity("U012ABCDEF")).toBe("U012ABCDEF");
    expect(canonicalizeRouteIdentity("C0BG33ZUWJC")).toBe("C0BG33ZUWJC");
    expect(canonicalizeRouteIdentity("D012ABCDEF")).toBe("D012ABCDEF");
  });

  it("never promotes bare digits to lid:", () => {
    expect(canonicalizeRouteIdentity("224420715061374")).toBe("224420715061374");
  });
});
