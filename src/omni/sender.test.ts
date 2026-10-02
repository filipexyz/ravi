import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { ChannelMessageSender } from "../channels/outbound/sender.js";
import { OmniSender } from "./sender.js";

function withTempFile(name: string, contents: string, run: (path: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "ravi-omni-sender-"));
  const path = join(dir, name);
  writeFileSync(path, contents);
  return run(path).finally(() => rmSync(dir, { recursive: true, force: true }));
}

const originalFetch = globalThis.fetch;

type FetchReply = () => Response | Promise<Response>;

/** Fake Omni HTTP API: one reply per call (the last one repeats); records the JSON bodies. */
function fakeOmni(replies: FetchReply[]) {
  const bodies: Array<Record<string, unknown>> = [];
  const urls: string[] = [];
  const apiKeys: Array<string | null> = [];
  globalThis.fetch = mock(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    urls.push(String(input));
    apiKeys.push(new Headers(init?.headers).get("x-api-key"));
    bodies.push(init?.body ? JSON.parse(String(init.body)) : {});
    const reply = replies[Math.min(bodies.length - 1, replies.length - 1)]!;
    return reply();
  }) as unknown as typeof fetch;
  return { bodies, urls, apiKeys };
}

const ok =
  (data: Record<string, unknown>): FetchReply =>
  () =>
    Response.json({ data });
const fail =
  (status: number): FetchReply =>
  () =>
    Response.json({ error: { message: `HTTP ${status}` } }, { status });
const networkError: FetchReply = () => {
  throw new TypeError("fetch failed");
};

function sender() {
  const sleeps: number[] = [];
  const instance = new OmniSender("http://omni.local", "test-key", {
    retry: {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    },
  });
  return { sender: instance, sleeps };
}

describe("OmniSender (legacy bridge)", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("is a ChannelMessageSender", () => {
    const channelSender: ChannelMessageSender = new OmniSender("http://omni.local", "test-key");
    expect(typeof channelSender.send).toBe("function");
  });

  it("passes mentions through to Omni message send", async () => {
    const { bodies } = fakeOmni([ok({ messageId: "msg-1", status: "sent" })]);

    const result = await sender().sender.send("instance-1", "120363@g.us", "@91015272759397 oi", {
      threadId: "thread-1",
      mentions: [{ id: "91015272759397@lid", type: "user" }],
    });

    expect(result).toEqual({ messageId: "msg-1" });
    expect(bodies[0]).toEqual({
      instanceId: "instance-1",
      to: "120363@g.us",
      text: "@91015272759397 oi",
      threadId: "thread-1",
      mentions: [{ id: "91015272759397@lid", type: "user" }],
    });
  });

  it("always sends media and stickers as base64 plus the absolute filePath (relative paths resolve against cwd)", async () => {
    const { bodies } = fakeOmni([ok({ messageId: "media-1", status: "sent" })]);

    await withTempFile("photo.png", "png-bytes", async (path) => {
      const { sender: omni } = sender();
      const result = await omni.sendMedia(
        "instance-1",
        "120363@g.us",
        relative(process.cwd(), path),
        "image",
        "photo.png",
      );
      expect(result).toEqual({ messageId: "media-1" });
      await omni.sendSticker("instance-1", "120363@g.us", path);
      expect(bodies[0]).toMatchObject({
        instanceId: "instance-1",
        type: "image",
        filePath: path,
        base64: Buffer.from("png-bytes").toString("base64"),
        filename: "photo.png",
      });
      expect(bodies[1]).toMatchObject({ filePath: path, base64: Buffer.from("png-bytes").toString("base64") });
    });
  });

  it("retries 5xx and network errors on send/reaction/edit/delete (3 attempts, 1s then 2s)", async () => {
    const { bodies } = fakeOmni([fail(503), networkError, ok({ messageId: "msg-3", status: "sent" })]);
    const { sender: omni, sleeps } = sender();

    expect(await omni.send("instance-1", "5511@s.whatsapp.net", "oi")).toEqual({ messageId: "msg-3" });
    expect(bodies).toHaveLength(3);
    expect(sleeps).toEqual([1000, 2000]);

    for (const run of [
      () => omni.sendReaction("instance-1", "chat", "m1", "👍"),
      () => omni.editMessage("instance-1", "chat", "m1", "edited"),
      () => omni.deleteMessage("instance-1", "chat", "m1"),
    ]) {
      const calls = fakeOmni([fail(502), ok({ success: true })]);
      await run();
      expect(calls.bodies).toHaveLength(2);
    }
  });

  it("gives up after 3 attempts and does not retry 4xx", async () => {
    const failing = fakeOmni([fail(500)]);
    const { sender: omni } = sender();
    await expect(omni.send("instance-1", "chat", "oi")).rejects.toMatchObject({ status: 500 });
    expect(failing.bodies).toHaveLength(3);

    const rejecting = fakeOmni([fail(404)]);
    await expect(omni.deleteMessage("instance-1", "chat", "m1")).rejects.toMatchObject({ status: 404 });
    expect(rejecting.bodies).toHaveLength(1);
  });

  it("does not retry media or stickers", async () => {
    await withTempFile("clip.mp4", "video", async (path) => {
      const calls = fakeOmni([fail(503)]);
      const { sender: omni } = sender();
      await expect(omni.sendMedia("instance-1", "chat", path, "video", "clip.mp4")).rejects.toMatchObject({
        status: 503,
      });
      await expect(omni.sendSticker("instance-1", "chat", path)).rejects.toMatchObject({ status: 503 });
      expect(calls.bodies).toHaveLength(2);
    });
  });

  it("never throws from sendTyping or markRead", async () => {
    const calls = fakeOmni([fail(500)]);
    const { sender: omni } = sender();

    await expect(omni.sendTyping("instance-1", "chat", true)).resolves.toBeUndefined();
    await expect(omni.sendTyping("instance-1", "chat", false)).resolves.toBeUndefined();
    await expect(omni.markRead("instance-1", "chat", ["m1"])).resolves.toBeUndefined();
    expect(calls.bodies[0]).toMatchObject({ type: "typing", duration: 30_000 });
    expect(calls.bodies[1]).toMatchObject({ type: "paused", duration: 0 });
  });

  it("talks to the configured Omni API URL with its API key", async () => {
    const { bodies, urls, apiKeys } = fakeOmni([ok({ messageId: "msg-2", status: "sent" })]);
    const omni = new OmniSender("http://omni.local/", "k");
    expect(await omni.send("instance-1", "5511@s.whatsapp.net", "oi")).toEqual({ messageId: "msg-2" });
    expect(bodies).toHaveLength(1);
    expect(urls[0]?.startsWith("http://omni.local/api/v2/")).toBe(true);
    expect(apiKeys).toEqual(["k"]);
  });
});
