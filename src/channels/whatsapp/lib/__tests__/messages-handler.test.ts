/**
 * Handler-level coverage for the ported `setupMessageHandlers` (ravi host seam).
 *
 * Omni covered these paths through `WhatsAppPlugin`; here they are pinned at the
 * handler/host boundary so the runtime (step 2) can rely on exactly these calls.
 */

import { describe, expect, it, mock } from "bun:test";
import { EventEmitter } from "node:events";
import { createInboundDedupeCache } from "../foundation.js";
import { setupMessageHandlers } from "../handlers/messages.js";
import { DecryptFailureTracker } from "../utils/decrypt-failure-tracker.js";
import { createFakeHost } from "./fake-host.js";

const INSTANCE = "inst-handler";
const DM_LID = "217046273028329@lid";
const DM_PHONE = "555197285829@s.whatsapp.net";
const GROUP = "120363000000000000@g.us";
const ME = "5511999990000:7@s.whatsapp.net";

function harness(options: Parameters<typeof createFakeHost>[0] = {}) {
  const ev = new EventEmitter();
  const presenceSubscribe = mock(async (_jid: string) => {});
  const sock = { ev, presenceSubscribe } as unknown as Parameters<typeof setupMessageHandlers>[0];
  const host = createFakeHost({ meJid: ME, ...options });
  const dedupe = createInboundDedupeCache();
  const tracker = new DecryptFailureTracker();
  setupMessageHandlers(sock, host, INSTANCE, tracker, dedupe);
  return { ev, host, presenceSubscribe, tracker, dedupe };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

function upsert(messages: unknown[]) {
  return { type: "notify" as const, messages };
}

describe("setupMessageHandlers → host.handleMessageReceived", () => {
  it("passes the LID-first chat id, the bare sender id and the annotated raw message", async () => {
    const h = harness();
    h.ev.emit(
      "messages.upsert",
      upsert([
        {
          key: { id: "MSG-1", remoteJid: DM_PHONE, remoteJidAlt: DM_LID, fromMe: false },
          messageTimestamp: 1_700_000_000,
          pushName: "Ana",
          message: { conversation: "oi" },
        },
      ]),
    );
    await flush();

    expect(h.host.handleMessageReceived).toHaveBeenCalledTimes(1);
    const call = h.host.handleMessageReceived.mock.calls[0] as unknown[];
    expect(call[0]).toBe(INSTANCE);
    expect(call[1]).toBe("MSG-1");
    expect(call[2]).toBe(DM_LID);
    expect(call[3]).toBe("217046273028329");
    expect(call[4]).toMatchObject({ type: "text", text: "oi" });
    expect(call[5]).toBeUndefined();
    const raw = call[6] as Record<string, unknown>;
    expect(raw.rawChatId).toBe(DM_PHONE);
    expect(raw.originalLidJid).toBe(DM_LID);
    expect(raw.resolvedPhoneJid).toBe(DM_PHONE);
    expect(raw.addressingMode).toBe("phone");
    expect(raw.senderIsLid).toBe(true);
    expect(raw.resolvedSenderPhone).toBe("555197285829");
    expect(call[7]).toBe(false);
    expect(call[8]).toBe(1_700_000_000_000);
    expect(h.host.getLidMappingCache(INSTANCE).get(DM_PHONE)).toBe(DM_LID);
  });

  it("uses the account's own JID (device suffix kept) as sender for fromMe group messages", async () => {
    const h = harness();
    h.ev.emit(
      "messages.upsert",
      upsert([
        {
          key: { id: "MSG-ME", remoteJid: GROUP, fromMe: true, participant: "x@lid" },
          messageTimestamp: 1_700_000_000,
          message: { extendedTextMessage: { text: "from my phone", contextInfo: { stanzaId: "QUOTED-1" } } },
        },
      ]),
    );
    await flush();

    const call = h.host.handleMessageReceived.mock.calls[0] as unknown[];
    expect(call[2]).toBe(GROUP);
    expect(call[3]).toBe("5511999990000:7");
    expect(call[5]).toBe("QUOTED-1");
    expect(call[7]).toBe(true);
  });

  it("drops the echo of a message this runtime sent", async () => {
    const h = harness();
    h.host.trackSent("SENT-1");
    h.ev.emit(
      "messages.upsert",
      upsert([{ key: { id: "SENT-1", remoteJid: DM_LID, fromMe: true }, message: { conversation: "echo" } }]),
    );
    await flush();
    expect(h.host.handleMessageReceived).not.toHaveBeenCalled();
  });

  it("drops a redelivered message id inside the dedupe window", async () => {
    const h = harness();
    const message = { key: { id: "DUP-1", remoteJid: DM_LID, fromMe: false }, message: { conversation: "x" } };
    h.ev.emit("messages.upsert", upsert([message]));
    h.ev.emit("messages.upsert", upsert([message]));
    await flush();
    expect(h.host.handleMessageReceived).toHaveBeenCalledTimes(1);
  });

  it("subscribes to presence once per phone-addressed DM chat", async () => {
    const h = harness();
    h.ev.emit(
      "messages.upsert",
      upsert([
        { key: { id: "P-1", remoteJid: DM_PHONE, fromMe: false }, message: { conversation: "1" } },
        { key: { id: "P-2", remoteJid: DM_PHONE, fromMe: false }, message: { conversation: "2" } },
        { key: { id: "P-3", remoteJid: GROUP, participant: DM_LID, fromMe: false }, message: { conversation: "3" } },
      ]),
    );
    await flush();
    expect(h.presenceSubscribe).toHaveBeenCalledTimes(1);
    expect(h.presenceSubscribe).toHaveBeenCalledWith(DM_PHONE);
  });

  it("records CIPHERTEXT stubs in the decrypt tracker and blocks after three", async () => {
    const h = harness();
    const stub = (id: string) => ({ key: { id, remoteJid: DM_LID, fromMe: false }, messageStubType: 2 });
    h.ev.emit("messages.upsert", upsert([stub("C-1"), stub("C-2"), stub("C-3")]));
    await flush();
    expect(h.tracker.shouldIgnore(DM_LID)).toBe(true);
    expect(h.host.handleMessageReceived).not.toHaveBeenCalled();
  });
});

describe("setupMessageHandlers special messages", () => {
  it("routes an upsert reaction to handleReactionReceived", async () => {
    const h = harness();
    h.ev.emit(
      "messages.upsert",
      upsert([
        {
          key: { id: "R-1", remoteJid: GROUP, participant: DM_LID, fromMe: false },
          message: { reactionMessage: { text: "👍", key: { id: "TARGET-1", remoteJid: GROUP } } },
        },
      ]),
    );
    await flush();
    expect(h.host.handleReactionReceived).toHaveBeenCalledWith(
      INSTANCE,
      "R-1",
      GROUP,
      "217046273028329",
      "👍",
      "TARGET-1",
      false,
    );
    expect(h.host.handleMessageReceived).not.toHaveBeenCalled();
  });

  it("routes a revoke protocol message to handleMessageDeleted", async () => {
    const h = harness();
    h.ev.emit(
      "messages.upsert",
      upsert([
        {
          key: { id: "D-1", remoteJid: DM_LID, fromMe: false },
          message: { protocolMessage: { type: 0, key: { id: "TARGET-2", remoteJid: DM_LID } } },
        },
      ]),
    );
    await flush();
    expect(h.host.handleMessageDeleted).toHaveBeenCalledWith(INSTANCE, "TARGET-2", DM_LID, false);
  });

  it("routes messages.delete and messages.reaction events", async () => {
    const h = harness();
    h.ev.emit("messages.delete", { keys: [{ id: "GONE-1", remoteJid: DM_PHONE, fromMe: true }] });
    h.ev.emit("messages.reaction", [
      {
        key: { id: "TARGET-3", remoteJid: GROUP },
        reaction: { text: "", key: { id: "RX-1", participant: DM_LID, fromMe: false } },
      },
    ]);
    await flush();
    expect(h.host.handleMessageDeleted).toHaveBeenCalledWith(INSTANCE, "GONE-1", DM_PHONE, true);
    expect(h.host.handleReactionReceived).toHaveBeenCalledWith(
      INSTANCE,
      "RX-1",
      GROUP,
      "217046273028329",
      "",
      "TARGET-3",
      false,
    );
  });

  it("maps receipt statuses to delivered / read", async () => {
    const h = harness();
    h.ev.emit("messages.update", [
      { key: { id: "S-1", remoteJid: DM_LID, fromMe: true }, update: { status: 3 } },
      { key: { id: "S-2", remoteJid: DM_LID, fromMe: true }, update: { status: 4 } },
      { key: { id: "S-3", remoteJid: DM_LID, fromMe: true }, update: { status: 5 } },
    ]);
    await flush();
    expect(h.host.handleMessageDelivered).toHaveBeenCalledWith(INSTANCE, "S-1", DM_LID);
    expect(h.host.handleMessageRead).toHaveBeenCalledWith(INSTANCE, "S-2", DM_LID);
    expect(h.host.handleMessageRead).toHaveBeenCalledWith(INSTANCE, "S-3", DM_LID);
  });
});
