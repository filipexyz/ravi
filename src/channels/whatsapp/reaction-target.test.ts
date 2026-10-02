import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { dbUpsertChat, dbUpsertChatMessage } from "../../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { findWhatsAppGroupReactionTarget, reactionTargetFromRawProvenance } from "./reaction-target.js";

const INSTANCE_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const GROUP = "120363407390920496@g.us";
const SENDER = "112233445566778@lid";

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-wa-reaction-target-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

/** Store an inbound group message the way the inbound pipeline does (channel "whatsapp", raw WAMessage). */
function storeGroupMessage(messageId: string, key: Record<string, unknown> | null, instanceId = INSTANCE_ID) {
  const chat = dbUpsertChat({ channel: "whatsapp", instanceId, platformChatId: GROUP, chatType: "group" });
  dbUpsertChatMessage({
    chatId: chat.id,
    channel: "whatsapp",
    instanceId,
    providerMessageId: messageId,
    rawChatId: GROUP,
    rawSenderId: "112233445566778",
    actorType: "contact",
    messageType: "text",
    content: { type: "text", text: "oi" },
    rawProvenance: {
      source: "whatsapp.message.received",
      chatId: GROUP,
      rawPayload: key ? { key: { remoteJid: GROUP, id: messageId, ...key } } : { pushName: "Ana" },
    },
    providerTimestamp: 1_700_000_000_000,
  });
}

describe("reactionTargetFromRawProvenance", () => {
  it("reads the participant or fromMe from the stored message key", () => {
    expect(reactionTargetFromRawProvenance({ rawPayload: { key: { fromMe: false, participant: SENDER } } })).toEqual({
      participant: SENDER,
      fromMe: false,
    });
    expect(reactionTargetFromRawProvenance({ rawPayload: { key: { fromMe: true, participant: SENDER } } })).toEqual({
      fromMe: true,
    });
  });

  it("returns null when the key says nothing useful", () => {
    for (const value of [
      null,
      undefined,
      "x",
      {},
      { rawPayload: null },
      { rawPayload: { key: "k" } },
      { rawPayload: { key: { fromMe: false } } },
      { rawPayload: { key: { participant: " " } } },
    ]) {
      expect(reactionTargetFromRawProvenance(value)).toBeNull();
    }
  });
});

describe("findWhatsAppGroupReactionTarget", () => {
  it("finds the sender of a stored group message", () => {
    storeGroupMessage("WAMID-1", { fromMe: false, participant: SENDER });
    storeGroupMessage("WAMID-OWN", { fromMe: true, participant: "5511999999999@s.whatsapp.net" });

    expect(findWhatsAppGroupReactionTarget(INSTANCE_ID, GROUP, "WAMID-1")).toEqual({
      participant: SENDER,
      fromMe: false,
    });
    expect(findWhatsAppGroupReactionTarget(INSTANCE_ID, GROUP, "WAMID-OWN")).toEqual({ fromMe: true });
  });

  it("returns undefined for unknown messages, other instances, DMs and rows without a raw key", () => {
    storeGroupMessage("WAMID-1", { fromMe: false, participant: SENDER });
    storeGroupMessage("WAMID-NOKEY", null);

    expect(findWhatsAppGroupReactionTarget(INSTANCE_ID, GROUP, "WAMID-MISSING")).toBeUndefined();
    expect(findWhatsAppGroupReactionTarget("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", GROUP, "WAMID-1")).toBeUndefined();
    expect(findWhatsAppGroupReactionTarget(INSTANCE_ID, "5511999999999@s.whatsapp.net", "WAMID-1")).toBeUndefined();
    expect(findWhatsAppGroupReactionTarget(INSTANCE_ID, GROUP, "WAMID-NOKEY")).toBeUndefined();
    expect(findWhatsAppGroupReactionTarget(INSTANCE_ID, GROUP, " ")).toBeUndefined();
  });
});
