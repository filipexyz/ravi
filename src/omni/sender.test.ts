import { afterEach, describe, expect, it, mock } from "bun:test";
import { OmniSender } from "./sender.js";

const originalFetch = globalThis.fetch;

describe("OmniSender", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("passes mentions through to Omni message send", async () => {
    const bodies: unknown[] = [];
    globalThis.fetch = mock(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ data: { messageId: "msg-1", status: "sent" } });
    }) as unknown as typeof fetch;

    const sender = new OmniSender("http://omni.local", "test-key");
    const result = await sender.send("instance-1", "120363@g.us", "@91015272759397 oi", {
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
});
