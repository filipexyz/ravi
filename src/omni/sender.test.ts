import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
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

  it("drops only a text the Knowledge guard emptied", async () => {
    const stateDir = await createIsolatedRaviState("ravi-omni-sender-");
    try {
      const bodies: Array<{ text: string }> = [];
      globalThis.fetch = mock(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        return Response.json({ data: { messageId: "msg-1", status: "sent" } });
      }) as unknown as typeof fetch;
      const guardRow = {
        sessionName: "s",
        agentId: "a",
        instanceId: "wa-main",
        channel: "whatsapp",
        chatId: "5511@s.whatsapp.net",
        normalizedChatId: "5511@s.whatsapp.net",
        contactId: "c",
        guardedUntil: Date.now() + 60_000,
      };

      const unguarded = new OmniSender("http://omni.local", "test-key", { knowledgeGuard: () => null });
      await unguarded.send("instance-1", "5511@s.whatsapp.net", " ");
      expect(bodies).toHaveLength(1);

      const guarded = new OmniSender("http://omni.local", "test-key", { knowledgeGuard: () => guardRow });
      await guarded.send("instance-1", "5511@s.whatsapp.net", " ");
      expect(bodies).toHaveLength(2);
      expect(await guarded.send("instance-1", "5511@s.whatsapp.net", "![x](https://evil.example/a.png)")).toEqual({});
      expect(bodies).toHaveLength(2);
    } finally {
      await cleanupIsolatedRaviState(stateDir);
    }
  });
});
