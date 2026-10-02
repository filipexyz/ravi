import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { resolveGroupMetadata } from "../channels/group-metadata/cache.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { createOmniGroupMetadataFetcher } from "./group-metadata.js";

const GROUP = "120363424772797713@g.us";

let stateDir: string | null = null;
const originalFetch = globalThis.fetch;
const fetchCalls: string[] = [];
let chatsResponse: () => Response;

const CHAT = {
  id: "chat-uuid",
  instanceId: "instance-1",
  externalId: GROUP,
  chatType: "group",
  channel: "whatsapp-baileys",
  name: "ravi - dev",
  description: "dev group",
  avatarUrl: "https://example.test/avatar.jpg",
  participantCount: 2,
  settings: { disappearing: "off" },
  platformMetadata: { source: "test" },
};

describe("Omni group metadata fetcher", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-omni-group-metadata-");
    fetchCalls.length = 0;
    chatsResponse = () => Response.json({ items: [CHAT], meta: { hasMore: false } });
    globalThis.fetch = mock(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      if (!url.startsWith("http://omni.local/")) {
        return Response.json({ error: { message: "not found" } }, { status: 404 });
      }
      fetchCalls.push(url);
      expect(new Headers(init?.headers).get("x-api-key")).toBe("test-key");

      if (url.includes("/api/v2/chats?")) return chatsResponse();
      if (url.includes("/api/v2/chats/chat-uuid/participants")) {
        return Response.json({
          items: [
            { id: "participant-1", platformUserId: "5511947879044", displayName: "Luis Filipe", role: "admin" },
            { id: "participant-2", platformUserId: "63295117615153", displayName: "R M", role: "member" },
            { id: "participant-3", platformUserId: "278507271802901", name: "-", role: "-" },
            { id: "participant-4", platformUserId: "  " },
          ],
        });
      }
      return Response.json({ error: { message: "not found" } }, { status: 404 });
    }) as unknown as typeof fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  const fetcher = () => createOmniGroupMetadataFetcher({ apiUrl: "http://omni.local", apiKey: "test-key" });

  it("finds the chat by external id, reads participants and tags transport omni", async () => {
    const result = await fetcher()({
      accountId: "main",
      instanceId: "instance-1",
      chatId: GROUP,
      channel: "whatsapp-baileys",
      fallbackName: "ravi - dev",
      fetchTimeoutMs: 5_000,
    });

    expect(result).toMatchObject({
      accountId: "main",
      instanceId: "instance-1",
      chatId: GROUP,
      chatUuid: "chat-uuid",
      externalId: GROUP,
      channel: "whatsapp-baileys",
      name: "ravi - dev",
      description: "dev group",
      avatarUrl: "https://example.test/avatar.jpg",
      participantCount: 2,
      settings: { disappearing: "off" },
      platformMetadata: { source: "test", transport: "omni" },
    });
    expect(result?.participants).toEqual([
      { id: "participant-1", platformUserId: "5511947879044", displayName: "Luis Filipe", role: "admin" },
      { id: "participant-2", platformUserId: "63295117615153", displayName: "R M", role: "member" },
      { id: "participant-3", platformUserId: "278507271802901" },
    ]);
    expect(fetchCalls).toHaveLength(2);
    const search = new URL(fetchCalls[0] as string);
    expect(search.pathname).toBe("/api/v2/chats");
    expect(Object.fromEntries(search.searchParams)).toEqual({
      instanceId: "instance-1",
      chatType: "group",
      search: GROUP,
      limit: "20",
    });
  });

  it("matches the chat by the fallback name when no external id matches", async () => {
    chatsResponse = () => Response.json({ data: [{ ...CHAT, externalId: "other@g.us", name: "Renamed Group" }] });

    const result = await fetcher()({
      accountId: "main",
      instanceId: "instance-1",
      chatId: GROUP,
      fallbackName: "renamed group",
      fetchTimeoutMs: 5_000,
    });

    expect(result?.chatUuid).toBe("chat-uuid");
    // Matched by name on the first search (chatId), then participants.
    expect(fetchCalls).toHaveLength(2);
  });

  it("returns null when no chat matches", async () => {
    chatsResponse = () => Response.json({ items: [] });
    const result = await fetcher()({
      accountId: "main",
      instanceId: "instance-1",
      chatId: GROUP,
      fetchTimeoutMs: 5_000,
    });
    expect(result).toBeNull();
    // chatId, normalized chatId, then the 500-row listing.
    expect(fetchCalls).toHaveLength(3);
    expect(new URL(fetchCalls[2] as string).searchParams.get("limit")).toBe("500");
  });

  it("throws the API error, which resolveGroupMetadata turns into a cache fallback", async () => {
    chatsResponse = () => Response.json({ error: { message: "bad key" } }, { status: 401 });
    await expect(
      fetcher()({ accountId: "main", instanceId: "instance-1", chatId: GROUP, fetchTimeoutMs: 5_000 }),
    ).rejects.toThrow("bad key");

    const resolved = await resolveGroupMetadata({
      accountId: "main",
      instanceId: "instance-1",
      chatId: GROUP,
      fetcher: fetcher(),
    });
    expect(resolved).toBeNull();
  });
});
