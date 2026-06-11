import { describe, expect, it } from "bun:test";
import { markCronSourceAsBackground } from "./source.js";

describe("cron prompt sources", () => {
  it("marks reply sources as background while preserving routing fields", () => {
    const source = {
      channel: "whatsapp-baileys",
      accountId: "main",
      chatId: "178035101794451@lid",
      threadId: "thread-1",
    };

    expect(markCronSourceAsBackground(source)).toEqual({
      ...source,
      suppressPresence: true,
    });
    expect(source).not.toHaveProperty("suppressPresence");
  });

  it("keeps missing reply sources missing", () => {
    expect(markCronSourceAsBackground(undefined)).toBeUndefined();
  });
});
