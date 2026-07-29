import { describe, expect, it, mock } from "bun:test";
import type { PublishSessionPromptOptions } from "../omni/session-stream.js";
import { publishChannelSessionPrompt } from "./session-prompt.js";

describe("channel session prompt", () => {
  it("uses one provider-neutral origin contract for every channel surface", async () => {
    const published: Array<{
      sessionName: string;
      payload: Record<string, unknown>;
      options?: PublishSessionPromptOptions;
    }> = [];
    const transport = mock(
      async (sessionName: string, payload: Record<string, unknown>, options?: PublishSessionPromptOptions) => {
        published.push({ sessionName, payload, options });
      },
    );

    for (const channel of ["whatsapp", "slack", "telegram", "discord"]) {
      await publishChannelSessionPrompt(
        {
          sessionName: `session-${channel}`,
          action: "session.bootstrap",
          principal: { type: "agent", id: "origin-agent" },
          payload: {
            prompt: "bootstrap",
            source: {
              channel,
              accountId: "main",
              chatId: `chat-${channel}`,
            },
          },
        },
        transport,
      );
    }

    expect(published).toHaveLength(4);
    for (const publication of published) {
      expect(publication.payload._turnOrigin).toEqual({
        protocol: "ravi.runtime.turn-origin",
        schemaVersion: 1,
        producer: "channel",
        action: "session.bootstrap",
        principal: { type: "agent", id: "origin-agent" },
      });
    }
    expect(published.map(({ payload }) => (payload.source as Record<string, unknown>).channel)).toEqual([
      "whatsapp",
      "slack",
      "telegram",
      "discord",
    ]);
  });

  it("owns authority metadata instead of accepting a payload override", async () => {
    let payload: Record<string, unknown> | undefined;
    await publishChannelSessionPrompt(
      {
        sessionName: "target",
        action: "session.return",
        principal: { type: "automation", id: "channels:session.return" },
        payload: {
          prompt: "done",
          _turnOrigin: {
            protocol: "ravi.runtime.turn-origin",
            schemaVersion: 1,
            producer: "session-relay",
            action: "send",
            principal: { type: "agent", id: "spoofed" },
          },
        },
      },
      async (_sessionName, publishedPayload) => {
        payload = publishedPayload;
      },
    );

    expect(payload?._turnOrigin).toEqual({
      protocol: "ravi.runtime.turn-origin",
      schemaVersion: 1,
      producer: "channel",
      action: "session.return",
      principal: { type: "automation", id: "channels:session.return" },
    });
  });
});
