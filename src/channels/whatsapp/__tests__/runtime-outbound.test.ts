/**
 * WhatsAppRuntime outbound + RPC surface: every `WhatsAppRpcMethod` returns the
 * contract shape and fails with a typed `{status, code}` error.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WHATSAPP_RPC_METHODS } from "../contract.js";
import { WhatsAppRuntimeError } from "../runtime-errors.js";
import { OWNER_JID, createHarness, flush } from "./runtime-harness.js";

const DM = "5511988887777@s.whatsapp.net";
const DM_LID = "217046273028329@lid";
const GROUP = "120363000000000000@g.us";
const MEMBER = "5511777776666@s.whatsapp.net";

let dir = "";
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "ravi-wa-runtime-"));
  writeFileSync(join(dir, "photo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(join(dir, "note.mp3"), Buffer.from("ID3-fake-mp3"));
  writeFileSync(
    join(dir, "sticker.webp"),
    Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBPVP8 ")]),
  );
});
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function lastSend(sock: ReturnType<ReturnType<typeof createHarness>["socket"]>) {
  const call = sock.fake.sendMessage.mock.calls.at(-1);
  if (!call) throw new Error("sendMessage was not called");
  return { jid: call[0], content: call[1] as Record<string, unknown>, options: call[2] as Record<string, unknown> };
}

async function inboundGroupMessage(h: ReturnType<typeof createHarness>, id: string, participant: string) {
  h.socket().emit("messages.upsert", {
    type: "notify",
    messages: [
      {
        key: { id, remoteJid: GROUP, fromMe: false, participant },
        messageTimestamp: 1_750_000_000,
        message: { conversation: "msg" },
      },
    ],
  });
  await flush();
}

describe("RPC dispatcher", () => {
  it("covers every contract method", async () => {
    const h = createHarness();
    for (const method of WHATSAPP_RPC_METHODS) {
      const error = await h.runtime.call(method, { definitely: "invalid" }).catch((e: unknown) => e);
      if (error instanceof WhatsAppRuntimeError) {
        expect(error.message).not.toContain("Unknown WhatsApp RPC method");
      }
    }
  });

  it("rejects unknown methods and invalid params with 400 INVALID_REQUEST", async () => {
    const h = createHarness();
    await expect(h.runtime.call("nope" as "connection.status", {})).rejects.toMatchObject({
      status: 400,
      code: "INVALID_REQUEST",
    });
    await expect(h.runtime.call("messages.sendText", { to: DM })).rejects.toMatchObject({ status: 400 });
    const error = await h.runtime.call("messages.sendText", {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WhatsAppRuntimeError);
    expect((error as WhatsAppRuntimeError).toRpcError()).toMatchObject({ status: 400, code: "INVALID_REQUEST" });
  });

  it("sends fail with 503 NOT_CONNECTED until the socket is open", async () => {
    const h = createHarness({ registered: false });
    h.runtime.start();
    await expect(h.runtime.call("messages.sendText", { to: DM, text: "oi" })).rejects.toMatchObject({
      status: 503,
      code: "NOT_CONNECTED",
    });
    await expect(h.runtime.call("groups.list", {})).rejects.toMatchObject({ status: 503 });
    expect(await h.runtime.call("connection.status", {})).toEqual({
      state: "disconnected",
      isConnected: false,
      profileName: null,
    });
  });
});

describe("messages.sendText", () => {
  it("sends text with markdown converted and returns the Baileys message id", async () => {
    const h = createHarness();
    const sock = await h.connect();
    const result = await h.runtime.call("messages.sendText", { to: "5511988887777", text: "**oi** _tudo_?" });
    expect(result).toEqual({ messageId: "SENT-1", status: "sent" });
    const { jid, content } = lastSend(sock);
    expect(jid).toBe(DM);
    expect(content).toEqual({ text: "*oi* _tudo_?" });
    expect(h.runtime.isBotSentMessage(h.instanceId, "SENT-1")).toBe(true);
    expect(h.observedOfType("message.sent")[0]?.payload).toMatchObject({ externalId: "SENT-1", chatId: DM });
  });

  it("passthrough keeps the text verbatim", async () => {
    const h = createHarness();
    const sock = await h.connect();
    await h.runtime.call("messages.sendText", { to: DM, text: "**raw**", messageFormatMode: "passthrough" });
    expect(lastSend(sock).content).toEqual({ text: "**raw**" });
  });

  it("drops text made only of routing headers ('filtered')", async () => {
    const h = createHarness();
    const sock = await h.connect();
    const result = await h.runtime.call("messages.sendText", {
      to: DM,
      text: "[channel:whatsapp-baileys instance:abc chat:x@s.whatsapp.net]\n⚡ REPLY NOW",
    });
    expect(result).toEqual({ messageId: "", status: "sent" });
    expect(sock.fake.sendMessage).not.toHaveBeenCalled();
  });

  it("upgrades a phone target to its LID (LID-first)", async () => {
    const h = createHarness();
    const sock = await h.connect();
    sock.fake.signalRepository.lidMapping.getLIDForPN.mockImplementation(async () => DM_LID);
    await h.runtime.call("messages.sendText", { to: DM, text: "oi" });
    expect(lastSend(sock).jid).toBe(DM_LID);
    expect(h.runtime.getLidMappingCache().get(DM_LID)).toBe(DM);
  });

  it("quotes the cached inbound message on replyTo and forwards explicit mentions", async () => {
    const h = createHarness();
    const sock = await h.connect();
    await inboundGroupMessage(h, "IN-1", MEMBER);
    await h.runtime.call("messages.sendText", {
      to: GROUP,
      text: "@5511777776666 respondendo",
      replyTo: "IN-1",
      mentions: [{ id: MEMBER, type: "user" }],
    });
    const { jid, content, options } = lastSend(sock);
    expect(jid).toBe(GROUP);
    expect(content.mentions).toEqual([MEMBER]);
    const quoted = options.quoted as { key: Record<string, unknown> };
    expect(quoted.key).toMatchObject({ id: "IN-1", remoteJid: GROUP, participant: MEMBER, fromMe: false });
  });

  it("falls back to a minimal quoted key for unknown replyTo ids", async () => {
    const h = createHarness();
    const sock = await h.connect();
    await h.runtime.call("messages.sendText", { to: DM, text: "x", replyTo: "UNKNOWN" });
    expect((lastSend(sock).options.quoted as { key: unknown }).key).toEqual({
      id: "UNKNOWN",
      remoteJid: DM,
      fromMe: false,
    });
  });

  it("RATE_LIMITED errors carry retryAfterMs (explicit retry_after or the runtime's backoff) to the RPC error", async () => {
    const h = createHarness();
    const sock = await h.connect();
    sock.fake.sendMessage.mockImplementationOnce(async () => {
      throw Object.assign(new Error("rate-overlimit"), { output: { statusCode: 429 }, retryAfter: 7 });
    });
    const explicit = await h.runtime.call("messages.sendText", { to: DM, text: "a" }).catch((error: unknown) => error);
    expect(explicit).toBeInstanceOf(WhatsAppRuntimeError);
    expect((explicit as WhatsAppRuntimeError).toRpcError()).toEqual({
      message: "rate-overlimit",
      status: 429,
      code: "RATE_LIMITED",
      retryAfterMs: 7_000,
    });

    // No explicit delay: the exponential backoff the runtime itself waits before its next send.
    sock.fake.sendMessage.mockImplementationOnce(async () => {
      throw Object.assign(new Error("rate-overlimit"), { output: { statusCode: 429 } });
    });
    const backoff = await h.runtime.call("messages.sendText", { to: DM, text: "b" }).catch((error: unknown) => error);
    const body = (backoff as WhatsAppRuntimeError).toRpcError();
    expect(body.code).toBe("RATE_LIMITED");
    expect(body.retryAfterMs).toBeGreaterThan(0);

    // Reactions report it too.
    sock.fake.sendMessage.mockImplementationOnce(async () => {
      throw Object.assign(new Error("rate-overlimit"), { output: { statusCode: 429 }, retryAfter: 2 });
    });
    await expect(h.runtime.call("messages.react", { to: DM, messageId: "X", emoji: "👍" })).rejects.toMatchObject({
      code: "RATE_LIMITED",
      retryAfterMs: 2_000,
    });

    // Other failures have none.
    sock.fake.sendMessage.mockImplementationOnce(async () => {
      throw new Error("socket hang up");
    });
    const other = await h.runtime.call("messages.sendText", { to: DM, text: "c" }).catch((error: unknown) => error);
    expect((other as WhatsAppRuntimeError).toRpcError()).not.toHaveProperty("retryAfterMs");
  });

  it("maps rate limits to 429 RATE_LIMITED and other failures to 502, observing message.failed", async () => {
    const h = createHarness();
    const sock = await h.connect();
    sock.fake.sendMessage.mockImplementationOnce(async () => {
      throw Object.assign(new Error("rate-overlimit"), { output: { statusCode: 429 } });
    });
    await expect(h.runtime.call("messages.sendText", { to: DM, text: "a" })).rejects.toMatchObject({
      status: 429,
      code: "RATE_LIMITED",
    });
    sock.fake.sendMessage.mockImplementationOnce(async () => {
      throw new Error("socket hang up");
    });
    await expect(h.runtime.call("messages.sendText", { to: DM, text: "b" })).rejects.toMatchObject({
      status: 502,
      code: "TRANSPORT_ERROR",
    });
    const failed = h.observedOfType("message.failed").map((event) => event.payload as Record<string, unknown>);
    expect(failed).toHaveLength(2);
    expect(failed[0]).toMatchObject({ chatId: DM, retryable: true });
    expect(h.published.map((record) => record.event.type as string)).not.toContain("message.failed");
  });
});

describe("messages.sendMedia / sendSticker", () => {
  it("streams an absolute filePath with inferred mime and filename", async () => {
    const h = createHarness();
    const sock = await h.connect();
    const filePath = join(dir, "photo.png");
    const result = await h.runtime.call("messages.sendMedia", {
      to: DM,
      type: "image",
      filePath,
      caption: "olha",
    });
    expect(result.status).toBe("sent");
    expect(lastSend(sock).content).toMatchObject({ image: { url: filePath }, caption: "olha", mimetype: "image/png" });
    expect(h.observedOfType("message.sent")[0]?.payload).toMatchObject({
      content: { type: "image", localPath: filePath, filename: "photo.png" },
      rawPayload: { mediaSource: "url" },
    });
  });

  it("rejects relative or missing files with 400", async () => {
    const h = createHarness();
    await h.connect();
    await expect(
      h.runtime.call("messages.sendMedia", { to: DM, type: "image", filePath: "photo.png" }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      h.runtime.call("messages.sendMedia", { to: DM, type: "image", filePath: join(dir, "missing.png") }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(h.runtime.call("messages.sendMedia", { to: DM, type: "document" })).rejects.toMatchObject({
      status: 400,
    });
  });

  it("has no base64 path: media and stickers without an absolute filePath are rejected", async () => {
    const h = createHarness();
    const sock = await h.connect();
    const sendsBefore = sock.fake.sendMessage.mock.calls.length;
    await expect(
      h.runtime.call("messages.sendMedia", {
        to: DM,
        type: "document",
        base64: Buffer.from("%PDF-1.4").toString("base64"),
        filename: "report.pdf",
      }),
    ).rejects.toMatchObject({ status: 400, code: "INVALID_REQUEST" });
    await expect(
      h.runtime.call("messages.sendSticker", { to: DM, base64: Buffer.from("RIFF0000WEBP").toString("base64") }),
    ).rejects.toMatchObject({ status: 400, code: "INVALID_REQUEST" });
    expect(sock.fake.sendMessage.mock.calls.length).toBe(sendsBefore);
  });

  it("converts voice notes to OGG/Opus and sends them as ptt", async () => {
    const h = createHarness();
    const sock = await h.connect();
    await h.runtime.call("messages.sendMedia", {
      to: DM,
      type: "audio",
      filePath: join(dir, "note.mp3"),
      voiceNote: true,
    });
    expect(h.library.convertBufferForVoiceNote).toHaveBeenCalledTimes(1);
    const content = lastSend(sock).content;
    expect(content.ptt).toBe(true);
    expect(content.mimetype).toBe("audio/ogg; codecs=opus");
    expect(Buffer.from(content.audio as Buffer).toString()).toBe("OggS-converted");
  });

  it("sends webp stickers as-is and converts other images", async () => {
    const convertSticker = mock(async () => Buffer.from("RIFF0000WEBPconverted"));
    const h = createHarness({ convertSticker });
    const sock = await h.connect();
    await h.runtime.call("messages.sendSticker", { to: DM, filePath: join(dir, "sticker.webp") });
    expect(convertSticker).not.toHaveBeenCalled();
    expect(Buffer.isBuffer(lastSend(sock).content.sticker)).toBe(true);

    const result = await h.runtime.call("messages.sendSticker", { to: DM, filePath: join(dir, "photo.png") });
    expect(convertSticker).toHaveBeenCalledTimes(1);
    expect(String(lastSend(sock).content.sticker)).toBe("RIFF0000WEBPconverted");
    expect(result).toEqual({ messageId: "SENT-2", status: "sent" });
  });

  it("a failing sticker conversion is a 400", async () => {
    const h = createHarness({
      convertSticker: async () => {
        throw new Error("unsupported image format");
      },
    });
    await h.connect();
    await expect(
      h.runtime.call("messages.sendSticker", { to: DM, filePath: join(dir, "photo.png") }),
    ).rejects.toMatchObject({ status: 400, code: "INVALID_REQUEST" });
  });
});

describe("reactions, edits, deletes", () => {
  it("reacts to a group message with the cached participant key", async () => {
    const h = createHarness();
    const sock = await h.connect();
    await inboundGroupMessage(h, "IN-R", MEMBER);
    const result = await h.runtime.call("messages.react", { to: GROUP, messageId: "IN-R", emoji: "🔥" });
    expect(result).toEqual({ messageId: "SENT-1", success: true });
    expect(lastSend(sock)).toMatchObject({
      jid: GROUP,
      content: { react: { text: "🔥", key: { remoteJid: GROUP, id: "IN-R", fromMe: false, participant: MEMBER } } },
    });
  });

  it("reacts to our own sent message with fromMe=true", async () => {
    const h = createHarness();
    const sock = await h.connect();
    const sent = await h.runtime.call("messages.sendText", { to: DM, text: "oi" });
    await h.runtime.call("messages.react", { to: DM, messageId: sent.messageId, emoji: "" });
    expect(lastSend(sock).content).toEqual({
      react: { text: "", key: { remoteJid: DM, id: sent.messageId, fromMe: true } },
    });
  });

  it("rejects custom (numeric) emoji ids with 400", async () => {
    const h = createHarness();
    await h.connect();
    await expect(
      h.runtime.call("messages.react", { to: DM, messageId: "X", emoji: "123456789" }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("edits own group messages with the account JID as participant", async () => {
    const h = createHarness();
    const sock = await h.connect();
    expect(await h.runtime.call("messages.edit", { chatId: GROUP, messageId: "OWN-1", text: "fix" })).toEqual({});
    expect(lastSend(sock).content).toEqual({
      edit: { remoteJid: GROUP, id: "OWN-1", fromMe: true, participant: OWNER_JID },
      text: "fix",
    });
    expect(h.runtime.isBotSentMessage(h.instanceId, "SENT-1")).toBe(true);
  });

  it("deletes for everyone with the known key", async () => {
    const h = createHarness();
    const sock = await h.connect();
    await inboundGroupMessage(h, "IN-D", MEMBER);
    await h.runtime.call("messages.delete", { chatId: GROUP, messageId: "IN-D" });
    expect(lastSend(sock).content).toEqual({
      delete: { remoteJid: GROUP, id: "IN-D", fromMe: false, participant: MEMBER },
    });
  });
});

describe("presence and read receipts", () => {
  it("typing sends composing and auto-pauses after the duration", async () => {
    const h = createHarness();
    const sock = await h.connect();
    await h.runtime.call("presence.set", { to: DM, state: "typing" });
    expect(sock.fake.sendPresenceUpdate).toHaveBeenLastCalledWith("composing", DM);
    expect(h.manual.delays()).toEqual([5000]);
    h.manual.runAll();
    expect(sock.fake.sendPresenceUpdate).toHaveBeenLastCalledWith("paused", DM);
  });

  it("recording, explicit pause, duration 0 and global availability", async () => {
    const h = createHarness();
    const sock = await h.connect();
    await h.runtime.call("presence.set", { to: DM, state: "recording", durationMs: 0 });
    expect(sock.fake.sendPresenceUpdate).toHaveBeenLastCalledWith("recording", DM);
    expect(h.manual.pending.size).toBe(0);
    await h.runtime.call("presence.set", { to: DM, state: "paused" });
    expect(sock.fake.sendPresenceUpdate).toHaveBeenLastCalledWith("paused", DM);
    await h.runtime.call("presence.set", { to: DM, state: "available" });
    expect(sock.fake.sendPresenceUpdate).toHaveBeenLastCalledWith("available");
  });

  it("marks group messages read with the participant (LID mapped to phone)", async () => {
    const h = createHarness();
    const sock = await h.connect();
    h.runtime.storeLidMapping(h.instanceId, DM_LID, "555197285829@s.whatsapp.net");
    await inboundGroupMessage(h, "IN-READ-1", DM_LID);
    await h.runtime.call("messages.markRead", { chatId: GROUP, messageIds: ["IN-READ-1"] });
    expect(sock.fake.readMessages).toHaveBeenCalledWith([
      { remoteJid: GROUP, id: "IN-READ-1", fromMe: false, participant: "555197285829@s.whatsapp.net" },
    ]);
  });

  it("'all' marks the whole chat read; readReceiptMode off sends nothing", async () => {
    const h = createHarness();
    const sock = await h.connect();
    await h.runtime.call("messages.markRead", { chatId: DM, messageIds: ["all"] });
    expect(sock.fake.readMessages).toHaveBeenCalledWith([{ remoteJid: DM, id: "all", fromMe: false }]);

    const off = createHarness({ readReceiptMode: "off" });
    const offSock = await off.connect();
    await off.runtime.call("messages.markRead", { chatId: DM, messageIds: ["X"] });
    expect(offSock.fake.readMessages).not.toHaveBeenCalled();
  });
});

describe("groups", () => {
  const groups = {
    [GROUP]: {
      id: GROUP,
      subject: "Equipe Ravi",
      desc: "time",
      owner: OWNER_JID,
      creation: 1_700_000_000,
      size: 3,
      participants: [
        { id: OWNER_JID, admin: "superadmin" as const },
        { id: DM_LID, admin: "admin" as const },
        { id: MEMBER, admin: null },
      ],
    },
    "120363111111111111@g.us": { id: "120363111111111111@g.us", subject: "Outro", participants: [] },
  };

  it("lists groups with search and limit (group record shape)", async () => {
    const h = createHarness({ socket: { groups } });
    await h.connect();
    const all = await h.runtime.call("groups.list", {});
    expect(all.items).toHaveLength(2);
    const filtered = await h.runtime.call("groups.list", { search: "ravi", limit: 5 });
    expect(filtered.items).toEqual([
      {
        id: GROUP,
        externalId: GROUP,
        subject: "Equipe Ravi",
        name: "Equipe Ravi",
        owner: OWNER_JID,
        creation: 1_700_000_000,
        participants: [
          { id: OWNER_JID, admin: "superadmin" },
          { id: DM_LID, admin: "admin" },
          { id: MEMBER, admin: null },
        ],
        memberCount: 3,
        isCommunity: false,
      },
    ]);
  });

  it("omits participant lists (participantsTruncated) when the result would exceed the NATS payload budget", async () => {
    const big: Record<
      string,
      { id: string; subject: string; size?: number; participants: Array<{ id: string; admin: null }> }
    > = {};
    for (let g = 0; g < 40; g++) {
      const id = `1203639${String(g).padStart(11, "0")}@g.us`;
      big[id] = {
        id,
        subject: `Big ${g}`,
        participants: Array.from({ length: 1_024 }, (_, p) => ({
          id: `55119${String(g * 10_000 + p).padStart(8, "0")}@s.whatsapp.net`,
          admin: null,
        })),
      };
    }
    const h = createHarness({ socket: { groups: big } });
    await h.connect();
    const result = await h.runtime.call("groups.list", {});
    expect(result.participantsTruncated).toBe(true);
    expect(result.items).toHaveLength(40);
    expect(result.items.every((item) => item.participants.length === 0 && item.memberCount === 1_024)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(900_000);

    // Small results are untouched (no flag).
    const small = await h.runtime.call("groups.list", { limit: 1 });
    expect(small.participantsTruncated).toBeUndefined();
    expect(small.items[0]?.participants).toHaveLength(1_024);
  });

  it("groups.metadata resolves names and LID phones, honoring maxAgeMs", async () => {
    const h = createHarness({ socket: { groups } });
    const sock = await h.connect();
    sock.emit("contacts.upsert", [{ id: MEMBER, notify: "Bia" }]);
    h.runtime.storeLidMapping(h.instanceId, DM_LID, "555197285829@s.whatsapp.net");
    const metadata = await h.runtime.call("groups.metadata", { groupJid: GROUP });
    expect(metadata).toEqual({
      groupJid: GROUP,
      subject: "Equipe Ravi",
      description: "time",
      owner: OWNER_JID,
      participants: [
        {
          platformUserId: OWNER_JID,
          phoneJid: OWNER_JID,
          phoneNumber: "5511999990000",
          displayName: null,
          role: "owner",
        },
        {
          platformUserId: DM_LID,
          phoneJid: "555197285829@s.whatsapp.net",
          phoneNumber: "555197285829",
          displayName: null,
          role: "admin",
        },
        { platformUserId: MEMBER, phoneJid: MEMBER, phoneNumber: "5511777776666", displayName: "Bia", role: "member" },
      ],
      fetchedAt: h.clock.now,
    });
    const callsAfterFirst = sock.fake.groupMetadata.mock.calls.length;
    await h.runtime.call("groups.metadata", { groupJid: GROUP });
    expect(sock.fake.groupMetadata.mock.calls.length).toBe(callsAfterFirst);
    h.clock.now += 10;
    await h.runtime.call("groups.metadata", { groupJid: GROUP, maxAgeMs: 0 });
    expect(sock.fake.groupMetadata.mock.calls.length).toBe(callsAfterFirst + 1);
  });

  it("create, participants, invites, join, leave, rename, description, settings", async () => {
    const h = createHarness({ socket: { groups } });
    const sock = await h.connect();

    const created = await h.runtime.call("groups.create", { subject: "Novo", participants: ["5511777776666"] });
    expect(created).toMatchObject({ id: "120363999999999999@g.us", subject: "Novo", memberCount: 1 });
    expect(sock.fake.groupCreate).toHaveBeenCalledWith("Novo", [MEMBER]);

    expect(
      await h.runtime.call("groups.addParticipants", { groupJid: GROUP, participants: ["5511666665555"] }),
    ).toEqual({ groupJid: GROUP, results: [{ jid: "5511666665555@s.whatsapp.net", status: "200" }] });
    await h.runtime.call("groups.updateParticipants", {
      groupJid: "group:120363000000000000",
      action: "promote",
      participants: [MEMBER],
    });
    expect(sock.fake.groupParticipantsUpdate).toHaveBeenLastCalledWith(GROUP, [MEMBER], "promote");

    expect(await h.runtime.call("groups.getInvite", { groupJid: GROUP })).toEqual({
      groupJid: GROUP,
      code: "INVITECODE",
      inviteLink: "https://chat.whatsapp.com/INVITECODE",
    });
    expect((await h.runtime.call("groups.revokeInvite", { groupJid: GROUP })).code).toBe("NEWCODE");
    expect(await h.runtime.call("groups.join", { code: "https://chat.whatsapp.com/AbC123" })).toEqual({
      groupJid: "120363555555555555@g.us",
      joined: true,
    });
    expect(sock.fake.groupAcceptInvite).toHaveBeenCalledWith("AbC123");
    expect(await h.runtime.call("groups.leave", { groupJid: GROUP })).toEqual({ groupJid: GROUP, left: true });
    expect(await h.runtime.call("groups.rename", { groupJid: GROUP, subject: "Renomeado" })).toEqual({
      groupJid: GROUP,
      subject: "Renomeado",
    });
    expect(await h.runtime.call("groups.setDescription", { groupJid: GROUP, description: "" })).toEqual({
      groupJid: GROUP,
      description: "",
    });
    expect(sock.fake.groupUpdateDescription).toHaveBeenCalledWith(GROUP, undefined);
    expect(await h.runtime.call("groups.setSettings", { groupJid: GROUP, setting: "announcement" })).toEqual({
      groupJid: GROUP,
      setting: "announcement",
    });
    await expect(
      h.runtime.call("groups.setSettings", { groupJid: GROUP, setting: "everyone-can-edit" }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("prewarms device/session caches before a group send", async () => {
    const h = createHarness({ socket: { groups } });
    const sock = await h.connect();
    sock.fake.getUSyncDevices.mockClear();
    await h.runtime.call("messages.sendText", { to: GROUP, text: "oi grupo" });
    expect(sock.fake.getUSyncDevices).toHaveBeenCalledWith([OWNER_JID, DM_LID, MEMBER], true, false);
  });
});
