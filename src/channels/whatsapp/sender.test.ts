import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import type { ChannelConfig, InstanceConfig } from "../../router/router-db.js";
import type { RouterConfig } from "../../router/types.js";
import type { TransportRetryOptions } from "../outbound/retry.js";
import { createWhatsAppClient } from "./client.js";
import { WHATSAPP_RPC_ERROR_CODES, type WhatsAppRpcMethod } from "./contract.js";
import { WhatsAppRpcError } from "./errors.js";
import type { requestWhatsAppRpc } from "./rpc-client.js";
import {
  createWhatsAppSender,
  isRetryableWhatsAppIdempotentOp,
  isRetryableWhatsAppSend,
  isWhatsAppSendNotAttempted,
  toWhatsAppJid,
} from "./sender.js";

const NATIVE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function config(): Pick<RouterConfig, "instances" | "channels" | "instanceToAccount"> {
  const instance = {
    name: "wa",
    instanceId: NATIVE_ID,
    channel: "whatsapp",
    dmPolicy: "open",
    groupPolicy: "open",
    contactIntakeMode: "off",
    createdAt: 0,
    updatedAt: 0,
  } as InstanceConfig;
  const channel = { name: "wa", provider: "whatsapp", enabled: true, createdAt: 0, updatedAt: 0 } as ChannelConfig;
  return { instances: { wa: instance }, channels: { wa: channel }, instanceToAccount: { [NATIVE_ID]: "wa" } };
}

type Outcome = unknown | Error;
interface RecordedCall {
  method: WhatsAppRpcMethod;
  params: Record<string, unknown>;
}

/** Fake runner: each call consumes the next outcome for its method (the last one repeats). */
function harness(outcomes: Partial<Record<WhatsAppRpcMethod, Outcome[]>> = {}) {
  const calls: RecordedCall[] = [];
  const used = new Map<WhatsAppRpcMethod, number>();
  const request = (async (_instanceId, method, params) => {
    calls.push({ method, params: params as Record<string, unknown> });
    const list = outcomes[method] ?? [{ messageId: `${method}-ok`, status: "sent", success: true }];
    const index = used.get(method) ?? 0;
    used.set(method, index + 1);
    const outcome = list[Math.min(index, list.length - 1)];
    if (outcome instanceof Error) throw outcome;
    return outcome;
  }) as typeof requestWhatsAppRpc;
  const sleeps: number[] = [];
  const retry: TransportRetryOptions = {
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    log: { warn: () => {} },
    // Ignored: the sender picks the retry policy per operation.
    isRetryable: () => true,
  };
  const sender = createWhatsAppSender(createWhatsAppClient({ getConfig: config, request }), { retry });
  return { sender, calls, sleeps };
}

function rpcError(
  status: number,
  code: string,
  extra: Partial<ConstructorParameters<typeof WhatsAppRpcError>[1]> = {},
) {
  return new WhatsAppRpcError(`${code} failure`, { status, code, ...extra });
}

const runnerUnavailable = () => rpcError(503, WHATSAPP_RPC_ERROR_CODES.runnerUnavailable, { details: "no responders" });
const notConnected = () => rpcError(503, WHATSAPP_RPC_ERROR_CODES.notConnected);
const rateLimited = (retryAfterMs?: number) =>
  rpcError(429, WHATSAPP_RPC_ERROR_CODES.rateLimited, retryAfterMs === undefined ? {} : { retryAfterMs });
const timeout = () => rpcError(504, WHATSAPP_RPC_ERROR_CODES.timeout);
const transportError = () => rpcError(502, WHATSAPP_RPC_ERROR_CODES.transportError);
const invalidResponse = () => rpcError(502, "WHATSAPP_RPC_INVALID_RESPONSE");

function withTempFile(name: string, run: (path: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "ravi-wa-sender-"));
  const path = join(dir, name);
  writeFileSync(path, "bytes");
  return run(path).finally(() => rmSync(dir, { recursive: true, force: true }));
}

describe("toWhatsAppJid", () => {
  it("maps group: refs to @g.us and leaves everything else unchanged", () => {
    expect(toWhatsAppJid("group:120363")).toBe("120363@g.us");
    expect(toWhatsAppJid("120363@g.us")).toBe("120363@g.us");
    expect(toWhatsAppJid("5511999@s.whatsapp.net")).toBe("5511999@s.whatsapp.net");
    expect(toWhatsAppJid("123@lid")).toBe("123@lid");
    expect(toWhatsAppJid("5511999")).toBe("5511999");
  });
});

describe("WhatsApp retry policies (R2)", () => {
  it("treats only certainly-unsent failures as retryable for non-idempotent sends", () => {
    expect(isRetryableWhatsAppSend(runnerUnavailable())).toBe(true);
    expect(
      isRetryableWhatsAppSend(
        rpcError(503, WHATSAPP_RPC_ERROR_CODES.runnerUnavailable, { details: "CONNECTION_REFUSED" }),
      ),
    ).toBe(true);
    expect(isRetryableWhatsAppSend(notConnected())).toBe(true);
    expect(isRetryableWhatsAppSend(rateLimited())).toBe(true);

    expect(isRetryableWhatsAppSend(timeout())).toBe(false);
    expect(isRetryableWhatsAppSend(transportError())).toBe(false);
    expect(isRetryableWhatsAppSend(invalidResponse())).toBe(false);
    // The NATS connection dropped mid-request: the runner may have sent it.
    expect(
      isRetryableWhatsAppSend(rpcError(503, WHATSAPP_RPC_ERROR_CODES.runnerUnavailable, { details: "DISCONNECT" })),
    ).toBe(false);
    expect(isRetryableWhatsAppSend(rpcError(500, "INTERNAL"))).toBe(false);
    expect(isRetryableWhatsAppSend(rpcError(400, WHATSAPP_RPC_ERROR_CODES.invalidRequest))).toBe(false);
    expect(isRetryableWhatsAppSend(new TypeError("fetch failed"))).toBe(false);
    // Look-alikes that are not WhatsApp RPC errors.
    expect(isWhatsAppSendNotAttempted({ status: 503, code: "NOT_CONNECTED" })).toBe(false);
  });

  it("lets idempotent operations also retry ambiguous 5xx outcomes", () => {
    for (const err of [
      runnerUnavailable(),
      notConnected(),
      rateLimited(),
      timeout(),
      transportError(),
      invalidResponse(),
    ]) {
      expect(isRetryableWhatsAppIdempotentOp(err)).toBe(true);
    }
    expect(isRetryableWhatsAppIdempotentOp(new TypeError("network"))).toBe(true);
    expect(isRetryableWhatsAppIdempotentOp(rpcError(404, WHATSAPP_RPC_ERROR_CODES.notFound))).toBe(false);
    expect(isRetryableWhatsAppIdempotentOp(rpcError(400, WHATSAPP_RPC_ERROR_CODES.invalidRequest))).toBe(false);
  });
});

describe("createWhatsAppSender", () => {
  it("sends text with thread and mentions to the bound instance", async () => {
    const { sender, calls } = harness({ "messages.sendText": [{ messageId: "BAE5", status: "sent" }] });
    const result = await sender.send(NATIVE_ID, "group:120363", "@1 oi", {
      threadId: "t1",
      mentions: [{ id: "1@lid", type: "user" }],
    });
    expect(result).toEqual({ messageId: "BAE5" });
    expect(calls).toEqual([
      {
        method: "messages.sendText",
        params: { to: "120363@g.us", text: "@1 oi", threadId: "t1", mentions: [{ id: "1@lid", type: "user" }] },
      },
    ]);
    await sender.send("wa", "x@g.us", "plain");
    expect(calls[1]!.params).toEqual({ to: "x@g.us", text: "plain" });
  });

  for (const [label, makeError] of [
    ["503 WHATSAPP_RUNNER_UNAVAILABLE", runnerUnavailable],
    ["503 NOT_CONNECTED", notConnected],
    ["429 RATE_LIMITED", () => rateLimited()],
  ] as const) {
    it(`retries text sends on ${label} (3 attempts, 1s/2s)`, async () => {
      const { sender, calls, sleeps } = harness({
        "messages.sendText": [makeError(), makeError(), { messageId: "LATE", status: "sent" }],
      });
      expect(await sender.send(NATIVE_ID, "x@g.us", "hi")).toEqual({ messageId: "LATE" });
      expect(calls).toHaveLength(3);
      expect(sleeps).toEqual([1_000, 2_000]);
    });
  }

  it("gives up after 3 attempts and rethrows the last error", async () => {
    const { sender, calls, sleeps } = harness({ "messages.sendText": [notConnected()] });
    await expect(sender.send(NATIVE_ID, "x@g.us", "hi")).rejects.toMatchObject({ status: 503, code: "NOT_CONNECTED" });
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([1_000, 2_000]);
  });

  it("honours the runner's retryAfterMs when it is longer than the backoff", async () => {
    const { sender, sleeps } = harness({
      "messages.sendText": [rateLimited(5_000), { messageId: "OK", status: "sent" }],
    });
    expect(await sender.send(NATIVE_ID, "x@g.us", "hi")).toEqual({ messageId: "OK" });
    expect(sleeps).toEqual([5_000]);
  });

  for (const [label, makeError] of [
    ["504 WHATSAPP_RPC_TIMEOUT", timeout],
    ["502 TRANSPORT_ERROR", transportError],
    ["502 WHATSAPP_RPC_INVALID_RESPONSE", invalidResponse],
  ] as const) {
    it(`never retries an ambiguous ${label} for text, media or sticker sends`, async () => {
      await withTempFile("photo.png", async (path) => {
        const err = makeError();
        const { sender, calls, sleeps } = harness({
          "messages.sendText": [err],
          "messages.sendMedia": [err],
          "messages.sendSticker": [err],
        });
        await expect(sender.send(NATIVE_ID, "x@g.us", "hi")).rejects.toBe(err);
        await expect(sender.sendMedia(NATIVE_ID, "x@g.us", path, "image", "photo.png")).rejects.toBe(err);
        await expect(sender.sendSticker(NATIVE_ID, "x@g.us", path)).rejects.toBe(err);
        expect(calls.map((call) => call.method)).toEqual([
          "messages.sendText",
          "messages.sendMedia",
          "messages.sendSticker",
        ]);
        expect(sleeps).toEqual([]);
      });
    });
  }

  it("retries media and sticker sends only when they certainly did not send", async () => {
    await withTempFile("photo.png", async (path) => {
      const { sender, calls } = harness({
        "messages.sendMedia": [runnerUnavailable(), { messageId: "MEDIA", status: "sent" }],
        "messages.sendSticker": [rateLimited(), { messageId: "STICKER", status: "sent" }],
      });
      expect(await sender.sendMedia(NATIVE_ID, "x@g.us", path, "image", "photo.png")).toEqual({ messageId: "MEDIA" });
      expect(await sender.sendSticker(NATIVE_ID, "x@g.us", path)).toEqual({ messageId: "STICKER" });
      expect(calls.map((call) => call.method)).toEqual([
        "messages.sendMedia",
        "messages.sendMedia",
        "messages.sendSticker",
        "messages.sendSticker",
      ]);
    });
  });

  it("does not retry 4xx failures", async () => {
    const { sender, calls } = harness({ "messages.sendText": [rpcError(404, "NOT_FOUND")] });
    await expect(sender.send(NATIVE_ID, "x@g.us", "hi")).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(calls).toHaveLength(1);
  });

  it("fails an unbound instance with 404 WHATSAPP_NOT_BOUND without retrying or calling the runner", async () => {
    const { sender, calls, sleeps } = harness();
    await expect(sender.send("not-bound", "x@g.us", "hi")).rejects.toMatchObject({
      status: 404,
      code: "WHATSAPP_NOT_BOUND",
    });
    await expect(sender.sendReaction("not-bound", "x@g.us", "m", "👍")).rejects.toMatchObject({ status: 404 });
    expect(calls).toHaveLength(0);
    expect(sleeps).toEqual([]);
  });

  it("passes a known reaction target (participant, fromMe) to the runner", async () => {
    const { sender, calls } = harness();
    await sender.sendReaction(NATIVE_ID, "group:120363", "M1", "👍", { participant: "123@lid", fromMe: false });
    await sender.sendReaction(NATIVE_ID, "group:120363", "M2", "🔥", { fromMe: true });
    await sender.sendReaction(NATIVE_ID, "group:120363", "M3", "👍", {});
    expect(calls).toEqual([
      {
        method: "messages.react",
        params: { to: "120363@g.us", messageId: "M1", emoji: "👍", participant: "123@lid", fromMe: false },
      },
      { method: "messages.react", params: { to: "120363@g.us", messageId: "M2", emoji: "🔥", fromMe: true } },
      { method: "messages.react", params: { to: "120363@g.us", messageId: "M3", emoji: "👍" } },
    ]);
  });

  it("retries idempotent reaction, edit and delete on 504/502 as well", async () => {
    const { sender, calls, sleeps } = harness({
      "messages.react": [timeout(), { messageId: "R", success: true }],
      "messages.edit": [transportError(), {}],
      "messages.delete": [invalidResponse(), notConnected(), {}],
    });
    await sender.sendReaction(NATIVE_ID, "group:120363", "M1", "👍");
    await sender.editMessage(NATIVE_ID, "group:120363", "M2", "fixed");
    await sender.deleteMessage(NATIVE_ID, "x@g.us", "M3");
    expect(calls).toEqual([
      { method: "messages.react", params: { to: "120363@g.us", messageId: "M1", emoji: "👍" } },
      { method: "messages.react", params: { to: "120363@g.us", messageId: "M1", emoji: "👍" } },
      { method: "messages.edit", params: { chatId: "120363@g.us", messageId: "M2", text: "fixed" } },
      { method: "messages.edit", params: { chatId: "120363@g.us", messageId: "M2", text: "fixed" } },
      { method: "messages.delete", params: { chatId: "x@g.us", messageId: "M3" } },
      { method: "messages.delete", params: { chatId: "x@g.us", messageId: "M3" } },
      { method: "messages.delete", params: { chatId: "x@g.us", messageId: "M3" } },
    ]);
    expect(sleeps).toEqual([1_000, 1_000, 1_000, 2_000]);
  });

  it("treats a connection dropped mid-request as ambiguous: no text retry, reaction retried", async () => {
    const dropped = () => rpcError(503, WHATSAPP_RPC_ERROR_CODES.runnerUnavailable, { details: "DISCONNECT" });
    const { sender, calls, sleeps } = harness({
      "messages.sendText": [dropped()],
      "messages.react": [dropped(), { success: true }],
    });
    await expect(sender.send(NATIVE_ID, "x@g.us", "hi")).rejects.toMatchObject({
      status: 503,
      code: WHATSAPP_RPC_ERROR_CODES.runnerUnavailable,
      details: "DISCONNECT",
    });
    await sender.sendReaction(NATIVE_ID, "x@g.us", "M1", "👍");
    expect(calls.map((call) => call.method)).toEqual(["messages.sendText", "messages.react", "messages.react"]);
    expect(sleeps).toEqual([1_000]);
  });

  it("honours retryAfterMs for idempotent operations too", async () => {
    const { sender, sleeps } = harness({ "messages.delete": [rateLimited(7_500), {}] });
    await sender.deleteMessage(NATIVE_ID, "x@g.us", "M1");
    expect(sleeps).toEqual([7_500]);
  });

  it("does not retry idempotent operations on 4xx", async () => {
    const { sender, calls } = harness({ "messages.edit": [rpcError(400, WHATSAPP_RPC_ERROR_CODES.invalidRequest)] });
    await expect(sender.editMessage(NATIVE_ID, "x@g.us", "M", "t")).rejects.toMatchObject({ status: 400 });
    expect(calls).toHaveLength(1);
  });

  it("sends media by absolute filePath, resolving a relative localPath against cwd, never base64", async () => {
    await withTempFile("note.ogg", async (path) => {
      const { sender, calls } = harness({
        "messages.sendMedia": [{ messageId: "BAE5", status: "sent" }],
        "messages.sendSticker": [{ messageId: "STK", status: "sent" }],
      });
      const relativePath = relative(process.cwd(), path);
      expect(
        await sender.sendMedia(NATIVE_ID, "5511@s.whatsapp.net", relativePath, "audio", "note.ogg", "cap", true),
      ).toEqual({ messageId: "BAE5" });
      expect(await sender.sendSticker(NATIVE_ID, "group:1", relativePath)).toEqual({ messageId: "STK" });
      await sender.sendMedia(NATIVE_ID, "5511@s.whatsapp.net", path, "image", "photo.png");

      expect(calls[0]).toEqual({
        method: "messages.sendMedia",
        params: {
          to: "5511@s.whatsapp.net",
          type: "audio",
          filePath: resolve(relativePath),
          filename: "note.ogg",
          caption: "cap",
          voiceNote: true,
        },
      });
      expect(calls[0]!.params.filePath).toBe(path);
      expect(calls[1]).toEqual({ method: "messages.sendSticker", params: { to: "1@g.us", filePath: path } });
      expect(calls[2]!.params).toEqual({
        to: "5511@s.whatsapp.net",
        type: "image",
        filePath: path,
        filename: "photo.png",
      });
      for (const call of calls) expect(call.params).not.toHaveProperty("base64");
    });
  });

  it("sends typing as presence.set and swallows failures", async () => {
    const { sender, calls } = harness({ "presence.set": [{}, new Error("socket down")] });
    await sender.sendTyping(NATIVE_ID, "group:120363");
    await expect(sender.sendTyping(NATIVE_ID, "x@g.us", false)).resolves.toBeUndefined();
    await expect(sender.sendTyping("not-bound", "x@g.us")).resolves.toBeUndefined();
    expect(calls).toEqual([
      { method: "presence.set", params: { to: "120363@g.us", state: "typing", durationMs: 30_000 } },
      { method: "presence.set", params: { to: "x@g.us", state: "paused", durationMs: 0 } },
    ]);
  });

  it("marks messages read and swallows failures", async () => {
    const { sender, calls } = harness({ "messages.markRead": [{}, notConnected()] });
    await sender.markRead(NATIVE_ID, "group:120363", ["A", "B"]);
    await expect(sender.markRead(NATIVE_ID, "x@g.us", ["C"])).resolves.toBeUndefined();
    await expect(sender.markRead("not-bound", "x@g.us", ["D"])).resolves.toBeUndefined();
    expect(calls).toEqual([
      { method: "messages.markRead", params: { chatId: "120363@g.us", messageIds: ["A", "B"] } },
      { method: "messages.markRead", params: { chatId: "x@g.us", messageIds: ["C"] } },
    ]);
  });
});
