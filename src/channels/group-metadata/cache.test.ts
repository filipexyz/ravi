import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { dbUpsertChat, dbUpsertChatParticipant, getDb } from "../../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import {
  formatGroupMembersForPrompt,
  getCachedGroupMetadata,
  normalizeGroupParticipant,
  resolveGroupMetadata,
  upsertGroupMetadata,
} from "./cache.js";
import type { ChannelGroupMetadata, GroupMetadataFetchInput } from "./types.js";

const GROUP = "120363424772797713@g.us";

let stateDir: string | null = null;

function metadata(overrides: Partial<ChannelGroupMetadata> = {}): ChannelGroupMetadata {
  return {
    accountId: "main",
    instanceId: "instance-1",
    chatId: GROUP,
    chatUuid: "chat-uuid",
    externalId: GROUP,
    channel: "whatsapp-baileys",
    name: "ravi - dev",
    description: "dev group",
    participantCount: 3,
    participants: [
      { id: "participant-1", platformUserId: "5511947879044", displayName: "Luis Filipe", role: "admin" },
      { id: "participant-2", platformUserId: "63295117615153", displayName: "R M", role: "member" },
      { id: "participant-3", platformUserId: "278507271802901", role: "-" },
    ],
    platformMetadata: { transport: "whatsapp" },
    fetchedAt: Date.now(),
    ...overrides,
  };
}

function fetcherReturning(result: ChannelGroupMetadata | null) {
  return mock(async (_input: GroupMetadataFetchInput) => result);
}

describe("channel group metadata cache", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-channel-group-cache-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("refreshes through the fetcher, stores the row, then serves the cache without fetching", async () => {
    const chat = dbUpsertChat({
      channel: "whatsapp",
      instanceId: "instance-1",
      platformChatId: GROUP,
      chatType: "group",
      title: "ravi - dev",
      seenAt: Date.now(),
    });
    dbUpsertChatParticipant({
      chatId: chat.id,
      rawPlatformUserId: "5511947879044",
      normalizedPlatformUserId: "5511999990000",
      role: "member",
      status: "active",
      source: "inbound_message",
      metadata: { displayName: "Luis Filipe" },
      seenAt: Date.now(),
    });
    const fetcher = fetcherReturning(metadata());

    const first = await resolveGroupMetadata({
      accountId: "main",
      instanceId: "instance-1",
      chatId: GROUP,
      channel: "whatsapp-baileys",
      fallbackName: "ravi - dev",
      fetcher,
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toEqual({
      accountId: "main",
      instanceId: "instance-1",
      chatId: GROUP,
      channel: "whatsapp-baileys",
      fallbackName: "ravi - dev",
      fetchTimeoutMs: 5_000,
    });
    expect(first).toMatchObject({ chatUuid: "chat-uuid", name: "ravi - dev", participantCount: 3 });

    const row = getDb()
      .prepare("SELECT name, participant_count FROM channel_group_metadata WHERE instance_id = ? AND chat_id = ?")
      .get("instance-1", GROUP) as { name: string; participant_count: number } | undefined;
    expect(row).toEqual({ name: "ravi - dev", participant_count: 3 });

    const second = await resolveGroupMetadata({ accountId: "main", instanceId: "instance-1", chatId: GROUP, fetcher });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(second?.participants).toHaveLength(3);
    // Cached rows are enriched from the chat model (phone alias + mention id).
    expect(second?.participants[0]).toMatchObject({
      platformUserId: "5511947879044",
      normalizedPlatformUserId: "5511999990000",
      mentionUserId: "5511999990000@s.whatsapp.net",
    });
    expect(formatGroupMembersForPrompt(second)).toEqual(["Luis Filipe (admin)", "R M"]);
  });

  it("passes an explicit fetch timeout through", async () => {
    const fetcher = fetcherReturning(null);
    await resolveGroupMetadata({
      accountId: "main",
      instanceId: "instance-1",
      chatId: GROUP,
      fetchTimeoutMs: 1_234,
      fetcher,
    });
    expect(fetcher.mock.calls[0]?.[0]).toEqual({
      accountId: "main",
      instanceId: "instance-1",
      chatId: GROUP,
      fetchTimeoutMs: 1_234,
    });
  });

  it("falls back to the stale row when the fetcher fails, and to null without one", async () => {
    upsertGroupMetadata(metadata({ fetchedAt: Date.now() - 60 * 60 * 1000 }));
    const failing = mock(async (_input: GroupMetadataFetchInput): Promise<ChannelGroupMetadata | null> => {
      throw new Error("runner down");
    });

    const stale = await resolveGroupMetadata({
      accountId: "main",
      instanceId: "instance-1",
      chatId: GROUP,
      fetcher: failing,
    });
    expect(failing).toHaveBeenCalledTimes(1);
    expect(stale?.name).toBe("ravi - dev");

    const missing = await resolveGroupMetadata({
      accountId: "main",
      instanceId: "instance-1",
      chatId: "120363499999999999@g.us",
      fetcher: failing,
    });
    expect(missing).toBeNull();
  });

  it("is cache-only without a fetcher (fresh or stale row, else null)", async () => {
    upsertGroupMetadata(metadata({ fetchedAt: Date.now() - 60 * 60 * 1000 }));
    const stale = await resolveGroupMetadata({
      accountId: "main",
      instanceId: "instance-1",
      chatId: GROUP,
      fetcher: null,
    });
    expect(stale?.name).toBe("ravi - dev");

    const none = await resolveGroupMetadata({ accountId: "main", instanceId: "instance-1", chatId: "other@g.us" });
    expect(none).toBeNull();
  });

  it("maxAgeMs 0 always refetches", async () => {
    upsertGroupMetadata(metadata());
    const fetcher = fetcherReturning(metadata({ name: "renamed" }));
    const result = await resolveGroupMetadata({
      accountId: "main",
      instanceId: "instance-1",
      chatId: GROUP,
      maxAgeMs: 0,
      fetcher,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result?.name).toBe("renamed");
    expect(
      getCachedGroupMetadata({ accountId: "main", instanceId: "instance-1", chatId: GROUP, maxAgeMs: 0 }),
    ).toBeNull();
    expect(getCachedGroupMetadata({ accountId: "main", instanceId: "instance-1", chatId: GROUP })?.name).toBe(
      "renamed",
    );
  });

  it("records chat provenance group_metadata and the transport as participant source", () => {
    upsertGroupMetadata(metadata());
    upsertGroupMetadata(
      metadata({
        instanceId: "instance-2",
        participants: [{ id: "p-omni", platformUserId: "5511900000000", displayName: "Omni Person" }],
        platformMetadata: { transport: "omni" },
      }),
    );
    upsertGroupMetadata(
      metadata({
        instanceId: "instance-3",
        participants: [{ platformUserId: "5511911111111" }],
        platformMetadata: null,
      }),
    );

    const chats = getDb()
      .prepare("SELECT instance_id, raw_provenance_json FROM chats WHERE platform_chat_id = ? ORDER BY instance_id")
      .all(GROUP) as Array<{ instance_id: string; raw_provenance_json: string }>;
    expect(chats.map((chat) => JSON.parse(chat.raw_provenance_json).source)).toEqual([
      "group_metadata",
      "group_metadata",
      "group_metadata",
    ]);

    const participants = getDb()
      .prepare(
        `SELECT c.instance_id, p.raw_platform_user_id, p.source, p.metadata_json
           FROM chat_participants p JOIN chats c ON c.id = p.chat_id
          ORDER BY c.instance_id, p.raw_platform_user_id`,
      )
      .all() as Array<{ instance_id: string; raw_platform_user_id: string; source: string; metadata_json: string }>;
    const byUser = new Map(participants.map((row) => [row.raw_platform_user_id, row]));
    expect(byUser.get("5511947879044")?.source).toBe("whatsapp");
    expect(JSON.parse(byUser.get("5511947879044")?.metadata_json ?? "{}")).toEqual({
      providerParticipantId: "participant-1",
      displayName: "Luis Filipe",
    });
    expect(byUser.get("5511900000000")?.source).toBe("omni");
    expect(byUser.get("5511911111111")?.source).toBe("omni");
  });

  it("normalizes participant records and drops unusable ones", () => {
    expect(
      normalizeGroupParticipant({
        userId: " 5511 ",
        normalizedUserId: "5511",
        phone: "+55 11",
        name: "Ana",
        role: "-",
      }),
    ).toEqual({ platformUserId: "5511", normalizedPlatformUserId: "5511", phoneNumber: "+55 11", displayName: "Ana" });
    expect(normalizeGroupParticipant({ platformUserId: "  " })).toBeNull();
    expect(normalizeGroupParticipant(["x"])).toBeNull();
  });

  it("formats prompt members without raw identifiers or the member role", () => {
    expect(formatGroupMembersForPrompt(null)).toBeUndefined();
    expect(
      formatGroupMembersForPrompt(
        metadata({
          participants: [
            { platformUserId: "1", displayName: "Ana", role: "owner" },
            { platformUserId: "2", displayName: "5511947879044@s.whatsapp.net" },
            { platformUserId: "3", displayName: "Bia", role: "member" },
          ],
        }),
      ),
    ).toEqual(["Ana (owner)", "Bia"]);
  });
});
