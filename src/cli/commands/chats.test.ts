import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { dbUpsertChat, dbUpsertChatMessage } from "../../router/router-db.js";
import { ChatReadingListCommands, ChatsCommands } from "./chats.js";

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-chats-cli-test-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

function captureLogs(run: () => void): string {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };

  try {
    run();
  } finally {
    console.log = originalLog;
  }

  return lines.join("\n");
}

function captureJson(run: () => void): Record<string, unknown> {
  return JSON.parse(captureLogs(run)) as Record<string, unknown>;
}

describe("ChatsCommands --json", () => {
  it("reads durable chat messages and manages list cursors with scoped readers", () => {
    const chat = dbUpsertChat({
      channel: "whatsapp",
      instanceId: "instance-1",
      platformChatId: "5511999999999@s.whatsapp.net",
      chatType: "dm",
      title: "Maria",
      rawProvenance: { provider: "omni", rawChatId: "5511999999999@s.whatsapp.net" },
    });

    const first = dbUpsertChatMessage({
      chatId: chat.id,
      channel: "whatsapp",
      instanceId: "instance-1",
      providerMessageId: "wamid-1",
      rawChatId: "5511999999999@s.whatsapp.net",
      actorType: "contact",
      contactId: "contact_1",
      content: { type: "text", text: "primeira" },
      rawProvenance: { rawPayload: { messageSecret: "secret-value", deviceListMetadata: { senderKeyHash: "hash" } } },
      providerTimestamp: 1_700_000_000_000,
      ingestedAt: 1_700_000_000_100,
    }).message;

    dbUpsertChatMessage({
      chatId: chat.id,
      channel: "whatsapp",
      instanceId: "instance-1",
      providerMessageId: "wamid-2",
      rawChatId: "5511999999999@s.whatsapp.net",
      actorType: "contact",
      contactId: "contact_1",
      content: { type: "text", text: "segunda" },
      providerTimestamp: 1_700_000_001_000,
      ingestedAt: 1_700_000_001_100,
    });

    const chats = new ChatsCommands();
    const lists = new ChatReadingListCommands();

    const readPayload = captureJson(() => {
      chats.read(chat.id, undefined, undefined, undefined, "10", undefined, undefined, true);
    });
    expect(readPayload.total).toBe(2);
    expect(JSON.stringify(readPayload)).not.toContain("messageSecret");
    expect((readPayload.messages as Array<Record<string, unknown>>)[0]!.rawProvenance).toBeUndefined();

    const rawReadPayload = captureJson(() => {
      chats.read(chat.id, undefined, undefined, undefined, "10", undefined, undefined, true, true);
    });
    expect(JSON.stringify(rawReadPayload)).toContain("messageSecret");

    const createdPayload = captureJson(() => {
      lists.create(
        "crm-analysis-pending",
        "agent:ravi-crm",
        "CRM analysis queue",
        undefined,
        undefined,
        undefined,
        true,
      );
    });
    expect((createdPayload.list as Record<string, unknown>).ownerType).toBe("agent");

    captureJson(() => {
      lists.add("crm-analysis-pending", chat.id, undefined, undefined, "test", undefined, true);
    });

    const initialDelta = captureJson(() => {
      lists.delta("crm-analysis-pending", chat.id, "agent:crm-observer", undefined, undefined, "10", false, true);
    });
    expect(initialDelta.newMessageCount).toBe(2);
    expect(initialDelta.events).toEqual([]);
    expect(initialDelta.editedMessageCount).toBe(0);
    expect(initialDelta.deletedMessageCount).toBe(0);
    expect(initialDelta.participantChanges).toEqual([]);

    captureJson(() => {
      lists.markRead(
        "crm-analysis-pending",
        chat.id,
        first.id,
        "agent:crm-observer",
        undefined,
        undefined,
        "test",
        true,
      );
    });

    const members = captureJson(() => {
      lists.members("crm-analysis-pending", "agent:crm-observer", undefined, undefined, true);
    });
    const member = (members.members as Array<Record<string, unknown>>)[0]!;
    expect(member.unreadMessageCount).toBe(1);
  });
});
