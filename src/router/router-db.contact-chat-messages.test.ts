import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { dbListContactChatMessagesSince, dbUpsertChat, dbUpsertChatMessage } from "./router-db.js";

// The owner read confirmation (src/link/owner-read-confirmation.ts) reads the
// owner's own recent messages in one chat through this query.
describe("dbListContactChatMessagesSince", () => {
  let stateDir: string | null = null;

  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-contact-chat-messages-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  function say(chatId: string, contactId: string | null, text: string, at: number) {
    dbUpsertChatMessage({
      chatId,
      channel: "slack",
      instanceId: "ravi-slack",
      providerMessageId: `m-${chatId}-${at}-${contactId ?? "agent"}`,
      rawChatId: chatId,
      actorType: contactId ? "contact" : "agent",
      contactId,
      agentId: contactId ? null : "main",
      content: { type: "text", text },
      providerTimestamp: at,
      ingestedAt: at,
    });
  }

  it("returns only that contact's messages in that chat since the time, newest first", () => {
    const group = dbUpsertChat({
      channel: "slack",
      instanceId: "ravi-slack",
      platformChatId: "C0GROUP",
      chatType: "group",
    });
    const other = dbUpsertChat({
      channel: "slack",
      instanceId: "ravi-slack",
      platformChatId: "C0OTHER",
      chatType: "group",
    });
    const t = 1_795_700_000_000;
    say(group.id, "c_owner", "old", t - 60_000);
    say(group.id, "c_owner", "first", t + 1_000);
    say(group.id, "c_owner", "second", t + 2_000);
    say(group.id, "c_client", "not the owner", t + 3_000);
    say(group.id, null, "the agent", t + 4_000);
    say(other.id, "c_owner", "another chat", t + 5_000);

    const texts = dbListContactChatMessagesSince({ chatId: group.id, contactId: "c_owner", sinceMs: t }).map(
      (message) => message.content?.text,
    );
    expect(texts).toEqual(["second", "first"]);
  });

  it("clamps the limit", () => {
    const group = dbUpsertChat({
      channel: "slack",
      instanceId: "ravi-slack",
      platformChatId: "C0LIMIT",
      chatType: "group",
    });
    const t = 1_795_700_000_000;
    for (let i = 0; i < 5; i++) say(group.id, "c_owner", `m${i}`, t + i);
    expect(
      dbListContactChatMessagesSince({ chatId: group.id, contactId: "c_owner", sinceMs: t, limit: 2 }),
    ).toHaveLength(2);
    expect(
      dbListContactChatMessagesSince({ chatId: group.id, contactId: "c_owner", sinceMs: t, limit: 0 }),
    ).toHaveLength(1);
  });
});
