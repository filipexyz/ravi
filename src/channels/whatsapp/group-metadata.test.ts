import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { RouterConfig } from "../../router/types.js";
import { getDb } from "../../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { formatGroupMembersForPrompt, resolveGroupMetadata } from "../group-metadata/cache.js";
import { createWhatsAppClient } from "./client.js";
import type { WhatsAppRpcResult } from "./contract.js";
import {
  createWhatsAppGroupMetadataFetcher,
  toWhatsAppGroupJid,
  whatsappGroupMetadataToChannel,
  type WhatsAppGroupMetadataClient,
} from "./group-metadata.js";
import type { requestWhatsAppRpc } from "./rpc-client.js";

const INSTANCE_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const GROUP = "120363400000000001@g.us";

let stateDir: string | null = null;

function rpcResult(): WhatsAppRpcResult<"groups.metadata"> {
  return {
    groupJid: GROUP,
    subject: "grupo nativo",
    description: "descricao",
    owner: "5511000000000@s.whatsapp.net",
    participants: [
      {
        platformUserId: "111111111111111@lid",
        phoneJid: "5511947879044@s.whatsapp.net",
        phoneNumber: "+55 11 94787-9044",
        displayName: "Luis Filipe",
        role: "owner",
      },
      { platformUserId: "5511900000000@s.whatsapp.net", displayName: "R M", role: "member" },
      { platformUserId: "  ", role: "member" },
    ],
    fetchedAt: 1_760_000_000_000,
  };
}

function fakeClient(result: () => Promise<WhatsAppRpcResult<"groups.metadata">>) {
  const metadata = mock((_ref: string, _params: { groupJid: string }, _options?: { timeoutMs?: number }) => result());
  const client: WhatsAppGroupMetadataClient = { groups: { metadata } };
  return { client, metadata };
}

describe("WhatsApp group metadata", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-whatsapp-group-metadata-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("maps group ids to a group JID for the RPC", () => {
    expect(toWhatsAppGroupJid(GROUP)).toBe(GROUP);
    expect(toWhatsAppGroupJid("group:120363400000000001")).toBe(GROUP);
    expect(toWhatsAppGroupJid("120363400000000001")).toBe(GROUP);
  });

  it("maps the RPC result into the channel cache shape with transport whatsapp", () => {
    const mapped = whatsappGroupMetadataToChannel(rpcResult(), {
      accountId: "main",
      instanceId: INSTANCE_ID,
      chatId: GROUP,
    });
    expect(mapped).toMatchObject({
      accountId: "main",
      instanceId: INSTANCE_ID,
      chatId: GROUP,
      chatUuid: null,
      externalId: GROUP,
      channel: "whatsapp-baileys",
      name: "grupo nativo",
      description: "descricao",
      participantCount: 2,
      platformMetadata: { transport: "whatsapp", owner: "5511000000000@s.whatsapp.net" },
      fetchedAt: 1_760_000_000_000,
    });
    expect(mapped.participants[0]).toEqual({
      platformUserId: "111111111111111@lid",
      phoneJid: "5511947879044@s.whatsapp.net",
      mentionUserId: "5511947879044@s.whatsapp.net",
      phoneNumber: "+55 11 94787-9044",
      normalizedPlatformUserId: "5511947879044",
      displayName: "Luis Filipe",
      role: "owner",
    });
    expect(formatGroupMembersForPrompt(mapped)).toEqual(["Luis Filipe (owner)", "R M"]);
  });

  it("keeps the fallback name when the group has no subject", () => {
    const mapped = whatsappGroupMetadataToChannel(
      { groupJid: GROUP, subject: null, participants: [], fetchedAt: 0 },
      { accountId: "main", instanceId: INSTANCE_ID, chatId: GROUP, fallbackName: "pelo payload" },
    );
    expect(mapped).toMatchObject({ name: "pelo payload", channel: "whatsapp-baileys", participantCount: 0 });
    expect(mapped.fetchedAt).toBeGreaterThan(0);
  });

  it("refreshes the cache through groups.metadata with the fetch timeout, then serves it locally", async () => {
    const { client, metadata } = fakeClient(async () => rpcResult());
    const fetcher = createWhatsAppGroupMetadataFetcher(client);

    const first = await resolveGroupMetadata({
      accountId: "main",
      instanceId: INSTANCE_ID,
      chatId: "group:120363400000000001",
      channel: "whatsapp-baileys",
      fetcher,
    });
    expect(metadata).toHaveBeenCalledTimes(1);
    expect(metadata.mock.calls[0]).toEqual([INSTANCE_ID, { groupJid: GROUP }, { timeoutMs: 5_000 }]);
    expect(first?.name).toBe("grupo nativo");

    const row = getDb()
      .prepare(
        "SELECT name, participant_count, platform_metadata_json FROM channel_group_metadata WHERE instance_id = ?",
      )
      .get(INSTANCE_ID) as { name: string; participant_count: number; platform_metadata_json: string } | undefined;
    expect(row?.name).toBe("grupo nativo");
    expect(row?.participant_count).toBe(2);
    expect(JSON.parse(row?.platform_metadata_json ?? "{}")).toMatchObject({ transport: "whatsapp" });

    // fetchedAt is old, so pin maxAgeMs past it.
    const second = await resolveGroupMetadata({
      accountId: "main",
      instanceId: INSTANCE_ID,
      chatId: "group:120363400000000001",
      maxAgeMs: Number.MAX_SAFE_INTEGER,
      fetcher,
    });
    expect(second?.participants).toHaveLength(2);
    expect(metadata).toHaveBeenCalledTimes(1);
  });

  it("falls back to the cached row when the runner RPC fails", async () => {
    await resolveGroupMetadata({
      accountId: "main",
      instanceId: INSTANCE_ID,
      chatId: GROUP,
      fetcher: createWhatsAppGroupMetadataFetcher(fakeClient(async () => rpcResult()).client),
    });
    const failing = fakeClient(async () => {
      throw new Error("runner down");
    });
    const cached = await resolveGroupMetadata({
      accountId: "main",
      instanceId: INSTANCE_ID,
      chatId: GROUP,
      maxAgeMs: 0,
      fetcher: createWhatsAppGroupMetadataFetcher(failing.client),
    });
    expect(failing.metadata).toHaveBeenCalledTimes(1);
    expect(cached?.name).toBe("grupo nativo");
  });

  it("never reaches the runner for an instance not bound to a WhatsApp channel", async () => {
    const request = mock(async () => rpcResult());
    const client = createWhatsAppClient({
      getConfig: () =>
        ({ instances: {}, channels: {}, instanceToAccount: {} }) as unknown as Pick<
          RouterConfig,
          "instances" | "channels" | "instanceToAccount"
        >,
      request: request as unknown as typeof requestWhatsAppRpc,
    });
    const fetcher = createWhatsAppGroupMetadataFetcher(client);

    await expect(
      fetcher({ accountId: "main", instanceId: "unbound", chatId: GROUP, fetchTimeoutMs: 5_000 }),
    ).rejects.toMatchObject({ status: 404, code: "WHATSAPP_NOT_BOUND" });
    expect(await resolveGroupMetadata({ accountId: "main", instanceId: "unbound", chatId: GROUP, fetcher })).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });
});
