import { describe, expect, it, mock } from "bun:test";
import { parseYouTubeCredential, YouTubeClient } from "./client.js";

type RequestRecord = { url: URL; init: RequestInit };

function fakeFetch(handler: (request: RequestRecord) => Response | Promise<Response>): typeof fetch {
  return mock(async (input: string | URL | Request, init: RequestInit = {}) =>
    handler({ url: new URL(String(input)), init }),
  ) as unknown as typeof fetch;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("YouTubeClient", () => {
  it("reports credential metadata health without resolving a secret or calling fetch", () => {
    const fetch = fakeFetch(() => {
      throw new Error("health must not call fetch");
    });
    const credentialResolver = mock(async () => {
      throw new Error("health must not resolve a secret");
    });
    const client = new YouTubeClient({
      connection: "brand",
      fetch,
      credentialResolver,
      connectionInspector: () => ({ status: "active" }),
    });

    expect(client.health()).toEqual({
      app: "youtube",
      connection: "brand",
      ready: true,
      credentialConfigured: true,
      credentialStatus: "active",
      authenticated: false,
      externalCheckPerformed: false,
      message: "Credential metadata is active; authentication was not exercised in Phase 1.",
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(credentialResolver).not.toHaveBeenCalled();
  });

  it("fails closed before fetch when the credential broker has no connection", async () => {
    const fetch = fakeFetch(() => {
      throw new Error("missing credentials must fail before fetch");
    });
    const client = new YouTubeClient({
      fetch,
      credentialResolver: async () => {
        throw new Error("Vault lookup failed at secret/ravi/credentials/youtube/default");
      },
      connectionInspector: () => null,
    });

    await expect(client.channelInfo()).rejects.toThrow(
      'YouTube credential unavailable for connection "default". Configure provider "youtube"',
    );
    try {
      await client.channelInfo();
    } catch (error) {
      expect(error instanceof Error ? error.message : String(error)).not.toContain("secret/ravi");
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("lists uploads through the uploads playlist and preserves provider pagination", async () => {
    const requests: RequestRecord[] = [];
    const fetch = fakeFetch((request) => {
      requests.push(request);
      const path = request.url.pathname;
      if (path.endsWith("/channels")) {
        return json({
          items: [
            {
              id: "UC123",
              snippet: { title: "Canal", description: "Descrição" },
              statistics: { subscriberCount: "3", videoCount: "2", viewCount: "40" },
              contentDetails: { relatedPlaylists: { uploads: "UU123" } },
            },
          ],
        });
      }
      if (path.endsWith("/playlistItems")) {
        return json({
          items: [
            { id: "PLI-1", contentDetails: { videoId: "video-1" } },
            { id: "PLI-2", contentDetails: { videoId: "video-2" } },
          ],
          pageInfo: { totalResults: 9 },
          nextPageToken: "next-2",
        });
      }
      if (path.endsWith("/videos")) {
        return json({
          items: [
            {
              id: "video-1",
              snippet: { title: "Primeiro", publishedAt: "2026-07-01T00:00:00Z" },
              statistics: { viewCount: "10", likeCount: "2", commentCount: "1" },
              contentDetails: { duration: "PT1M" },
              status: { privacyStatus: "public" },
            },
            {
              id: "video-2",
              snippet: { title: "Segundo", publishedAt: "2026-06-01T00:00:00Z" },
              statistics: { viewCount: "20", likeCount: "4", commentCount: "2" },
              contentDetails: { duration: "PT2M" },
              status: { privacyStatus: "unlisted" },
            },
          ],
        });
      }
      return json({ error: "unexpected request" }, 500);
    });
    const client = new YouTubeClient({ fetch, credential: { accessToken: "unit-test-token" } });

    const result = await client.listVideos({ maxResults: 2, pageToken: "page-1" });

    expect(result.totalResults).toBe(9);
    expect(result.nextPageToken).toBe("next-2");
    expect(result.videos.map((video) => video.videoId)).toEqual(["video-1", "video-2"]);
    expect(requests.map((request) => request.url.pathname)).toEqual([
      "/youtube/v3/channels",
      "/youtube/v3/playlistItems",
      "/youtube/v3/videos",
    ]);
    expect(requests[1]?.url.searchParams.get("playlistId")).toBe("UU123");
    expect(requests[1]?.url.searchParams.get("pageToken")).toBe("page-1");
    expect(new Headers(requests[0]?.init.headers).get("authorization")).toBe("Bearer unit-test-token");
  });

  it("searches the authenticated channel with forMine to avoid the channel cap", async () => {
    const requests: RequestRecord[] = [];
    const fetch = fakeFetch((request) => {
      requests.push(request);
      if (request.url.pathname.endsWith("/channels")) {
        return json({ items: [{ id: "UC123", contentDetails: { relatedPlaylists: { uploads: "UU123" } } }] });
      }
      return json({ items: [] });
    });
    const client = new YouTubeClient({ fetch, credential: { accessToken: "unit-test-token" } });

    await client.searchVideos("lançamento");

    const search = requests.find((request) => request.url.pathname.endsWith("/search"));
    expect(search?.url.searchParams.get("channelId")).toBe("UC123");
    expect(search?.url.searchParams.get("forMine")).toBe("true");
    expect(search?.url.searchParams.get("type")).toBe("video");
  });

  it("preserves duplicate and unavailable playlist item identities", async () => {
    const fetch = fakeFetch((request) => {
      if (request.url.pathname.endsWith("/playlistItems")) {
        return json({
          items: [
            { id: "PLI-A", snippet: { title: "Vídeo" }, contentDetails: { videoId: "video-1" } },
            { id: "PLI-B", snippet: { title: "Vídeo repetido" }, contentDetails: { videoId: "video-1" } },
            { id: "PLI-C", snippet: { title: "Vídeo indisponível" }, contentDetails: { videoId: "video-2" } },
          ],
        });
      }
      return json({ items: [{ id: "video-1", snippet: { title: "Vídeo" } }] });
    });
    const client = new YouTubeClient({ fetch, credential: { accessToken: "unit-test-token" } });

    const result = await client.getPlaylistVideos("PL-1");

    expect(result.videos.map((video) => video.playlistItemId)).toEqual(["PLI-A", "PLI-B", "PLI-C"]);
    expect(result.videos.map((video) => video.videoId)).toEqual(["video-1", "video-1", "video-2"]);
    expect(result.videos[2]).toMatchObject({ title: "Vídeo indisponível", playlistItemId: "PLI-C" });
  });

  it("uses the official top-level comment id when publishing a reply", async () => {
    const requests: RequestRecord[] = [];
    const fetch = fakeFetch((request) => {
      requests.push(request);
      return json({ id: "reply-1" });
    });
    const client = new YouTubeClient({ fetch, credential: { accessToken: "unit-test-token" } });

    expect(await client.replyToComment("comment-1", "Texto aprovado")).toEqual({
      success: true,
      replyId: "reply-1",
    });
    const recorded = requests[0];
    expect(recorded?.url.href).toBe("https://www.googleapis.com/youtube/v3/comments?part=snippet");
    expect(recorded?.init.method).toBe("POST");
    expect(JSON.parse(String(recorded?.init.body))).toEqual({
      snippet: { parentId: "comment-1", textOriginal: "Texto aprovado" },
    });
  });

  it("preserves mutable video fields and refetches a complete result after update", async () => {
    const requests: RequestRecord[] = [];
    const fetch = fakeFetch((request) => {
      requests.push(request);
      if (requests.length === 1) {
        return json({
          items: [
            {
              id: "video-1",
              snippet: {
                title: "Título atual",
                description: "Descrição atual",
                tags: ["atual"],
                categoryId: "22",
                defaultLanguage: "pt-BR",
              },
              status: {
                privacyStatus: "private",
                embeddable: true,
                license: "youtube",
                publicStatsViewable: true,
                publishAt: "2026-08-01T00:00:00Z",
                selfDeclaredMadeForKids: false,
                containsSyntheticMedia: false,
              },
            },
          ],
        });
      }
      if (request.init.method === "PUT") return json({ id: "video-1", snippet: { title: "Título novo" } });
      return json({
        items: [
          {
            id: "video-1",
            snippet: { title: "Título novo", description: "Descrição atual" },
            statistics: { viewCount: "40", likeCount: "4", commentCount: "2" },
            contentDetails: { duration: "PT2M" },
            status: { privacyStatus: "public" },
          },
        ],
      });
    });
    const client = new YouTubeClient({ fetch, credential: { accessToken: "unit-test-token" } });

    const result = await client.updateVideo("video-1", { title: "Título novo", privacyStatus: "public" });

    expect(result).toMatchObject({
      success: true,
      video: { title: "Título novo", viewCount: 40, duration: "PT2M", privacyStatus: "public" },
    });
    expect(requests[1]?.init.method).toBe("PUT");
    expect(requests[1]?.url.searchParams.get("part")).toBe("snippet,status");
    expect(JSON.parse(String(requests[1]?.init.body))).toEqual({
      id: "video-1",
      snippet: {
        title: "Título novo",
        description: "Descrição atual",
        tags: ["atual"],
        categoryId: "22",
        defaultLanguage: "pt-BR",
      },
      status: {
        privacyStatus: "public",
        embeddable: true,
        license: "youtube",
        publicStatsViewable: true,
        selfDeclaredMadeForKids: false,
        containsSyntheticMedia: false,
      },
    });
    expect(requests[2]?.url.searchParams.get("part")).toBe("snippet,statistics,contentDetails,status");
  });

  it("builds every playlist/video mutation request with fake fetch only", async () => {
    const requests: RequestRecord[] = [];
    const fetch = fakeFetch((request) => {
      requests.push(request);
      if (request.url.pathname.endsWith("/playlists") && request.init.method === "POST") {
        return json({ id: "PL-1", snippet: { title: "Nova" }, status: { privacyStatus: "private" } });
      }
      if (request.url.pathname.endsWith("/playlistItems") && request.init.method === "POST") {
        return json({ id: "PLI-1", snippet: { title: "Vídeo" } });
      }
      return new Response(null, { status: 204 });
    });
    const client = new YouTubeClient({ fetch, credential: { accessToken: "unit-test-token" } });

    await client.deleteVideo("video-1");
    await client.createPlaylist("Nova");
    await client.deletePlaylist("PL-1");
    await client.addToPlaylist("PL-1", "video-1");
    await client.removeFromPlaylist("PLI-1");

    expect(requests.map((request) => `${request.init.method}:${request.url.pathname}`)).toEqual([
      "DELETE:/youtube/v3/videos",
      "POST:/youtube/v3/playlists",
      "DELETE:/youtube/v3/playlists",
      "POST:/youtube/v3/playlistItems",
      "DELETE:/youtube/v3/playlistItems",
    ]);
    expect(JSON.parse(String(requests[1]?.init.body))).toEqual({
      snippet: { title: "Nova", description: "" },
      status: { privacyStatus: "private" },
    });
    expect(JSON.parse(String(requests[3]?.init.body))).toEqual({
      snippet: { playlistId: "PL-1", resourceId: { kind: "youtube#video", videoId: "video-1" } },
    });
  });

  it("queries non-monetary Analytics metrics with deterministic dates", async () => {
    const requests: RequestRecord[] = [];
    const fetch = fakeFetch((request) => {
      requests.push(request);
      return json({ rows: [[100, 200, 30, 4, 1, 8, 2, 3, 5]] });
    });
    const client = new YouTubeClient({
      fetch,
      credential: { accessToken: "unit-test-token" },
      now: () => new Date("2026-07-13T12:00:00Z"),
    });

    const result = await client.analyticsOverview({ days: 7 });

    expect(result.overview).toEqual({
      views: 100,
      watchTimeMinutes: 200,
      avgViewDurationSec: 30,
      subscribersGained: 4,
      subscribersLost: 1,
      netSubscribers: 3,
      likes: 8,
      dislikes: 2,
      comments: 3,
      shares: 5,
    });
    const recorded = requests[0];
    expect(recorded?.url.origin).toBe("https://youtubeanalytics.googleapis.com");
    expect(recorded?.url.pathname).toBe("/v2/reports");
    expect(recorded?.url.searchParams.get("startDate")).toBe("2026-07-06");
    expect(recorded?.url.searchParams.get("endDate")).toBe("2026-07-12");
    expect(recorded?.url.searchParams.get("metrics")).not.toMatch(/Revenue|cpm|adImpressions/i);
  });

  it("downloads captions as text and redacts provider secrets from errors", async () => {
    let mode: "caption" | "error" = "caption";
    const fetch = fakeFetch(() => {
      if (mode === "caption") return new Response("1\n00:00:00,000 --> 00:00:01,000\nOlá\n");
      return json({ error: { access_token: "should-not-leak", message: "denied" } }, 401);
    });
    const client = new YouTubeClient({ fetch, credential: { accessToken: "unit-test-token" } });

    expect(await client.downloadCaption("caption-1", { format: "srt" })).toEqual({
      success: true,
      captionId: "caption-1",
      format: "srt",
      content: "1\n00:00:00,000 --> 00:00:01,000\nOlá\n",
    });

    mode = "error";
    let message = "";
    try {
      await client.getVideo("video-1");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("[redacted]");
    expect(message).not.toContain("should-not-leak");
  });

  it("accepts only a non-empty access-token envelope", () => {
    expect(parseYouTubeCredential(JSON.stringify({ accessToken: "unit-test-token" }))).toEqual({
      accessToken: "unit-test-token",
    });
    expect(() => parseYouTubeCredential("not-json")).toThrow("must be a JSON object");
    expect(() => parseYouTubeCredential(JSON.stringify({ refreshToken: "unsupported" }))).toThrow(
      'missing the "accessToken" field',
    );
    expect(() => parseYouTubeCredential(JSON.stringify({ accessToken: "   " }))).toThrow(
      'missing the "accessToken" field',
    );
    expect(parseYouTubeCredential(JSON.stringify({ accessToken: "  trimmed-token  " }))).toEqual({
      accessToken: "trimmed-token",
    });
  });
});
