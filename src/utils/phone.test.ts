import { describe, expect, it } from "bun:test";
import { isBroadcastJid } from "./phone.js";

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
