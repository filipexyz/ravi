import { describe, expect, it } from "bun:test";

import type { ArtifactRecord } from "../../artifacts/store.js";
import type { ToolContext } from "../context.js";
import { resolveImageArtifactMediaTarget } from "./image.js";

describe("resolveImageArtifactMediaTarget", () => {
  it("uses the artifact delivery target when a background worker has no runtime env context", () => {
    const artifact = {
      accountId: "main",
      channel: "whatsapp-baileys",
      chatId: "120363407387601415@g.us",
      threadId: "thread-1",
    } as ArtifactRecord;

    expect(resolveImageArtifactMediaTarget(artifact, undefined)).toEqual({
      channel: "whatsapp-baileys",
      accountId: "main",
      chatId: "120363407387601415@g.us",
      threadId: "thread-1",
    });
  });

  it("falls back to the live tool context for synchronous sends", () => {
    const ctx = {
      source: {
        channel: "whatsapp-baileys",
        accountId: "main",
        chatId: "120363407387601415@g.us",
      },
    } as ToolContext;

    expect(resolveImageArtifactMediaTarget(undefined, ctx)).toEqual({
      channel: "whatsapp-baileys",
      accountId: "main",
      chatId: "120363407387601415@g.us",
    });
  });
});
