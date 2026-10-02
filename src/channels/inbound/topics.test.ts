import { describe, expect, it } from "bun:test";
import {
  bridgeConnectedTopic,
  bridgeQrTopic,
  pairingTopicsFor,
  whatsappConnectedTopic,
  whatsappQrTopic,
} from "./topics.js";

const ID = "0b7c3d1e-1111-4222-8333-944455556666";

describe("pairing relay topics", () => {
  it("builds the WhatsApp and bridge topics", () => {
    expect(whatsappQrTopic(ID)).toBe(`ravi.whatsapp.qr.${ID}`);
    expect(whatsappConnectedTopic(ID)).toBe(`ravi.whatsapp.connected.${ID}`);
    expect(bridgeQrTopic(ID)).toBe(`ravi.bridge.qr.${ID}`);
    expect(bridgeConnectedTopic(ID)).toBe(`ravi.bridge.connected.${ID}`);
  });

  it("uses the WhatsApp topics for every canonical WhatsApp channel type", () => {
    for (const channelType of ["whatsapp", "whatsapp-baileys", "whatsapp baileys", " WhatsApp-Baileys "]) {
      expect(pairingTopicsFor(channelType, ID)).toEqual({
        qr: `ravi.whatsapp.qr.${ID}`,
        connected: `ravi.whatsapp.connected.${ID}`,
      });
    }
  });

  it("uses the bridge topics for every other channel type, WhatsApp-family included", () => {
    for (const channelType of ["telegram", "discord", "twilio-whatsapp", "gupshup", ""]) {
      expect(pairingTopicsFor(channelType, ID)).toEqual({
        qr: `ravi.bridge.qr.${ID}`,
        connected: `ravi.bridge.connected.${ID}`,
      });
    }
  });
});
