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

  it("normalizes the channel activity feed and extracts the related video id", async () => {
    const requests: RequestRecord[] = [];
    const fetch = fakeFetch((request) => {
      requests.push(request);
      return json({
        items: [
          {
            id: "act-1",
            snippet: {
              type: "upload",
              title: "Novo vídeo",
              description: "desc",
              publishedAt: "2026-07-14T15:00:00Z",
              thumbnails: { medium: { url: "https://example.test/m.jpg" } },
            },
            contentDetails: { upload: { videoId: "vid-1" } },
          },
        ],
        pageInfo: { totalResults: 16 },
        nextPageToken: "NEXT",
      });
    });
    const client = new YouTubeClient({ fetch, credential: { accessToken: "unit-test-token" } });

    const result = await client.listActivities({ maxResults: 3 });
    expect(result).toEqual({
      activities: [
        {
          activityId: "act-1",
          type: "upload",
          title: "Novo vídeo",
          description: "desc",
          publishedAt: "2026-07-14T15:00:00Z",
          thumbnail: "https://example.test/m.jpg",
          videoId: "vid-1",
        },
      ],
      totalResults: 16,
      nextPageToken: "NEXT",
    });
    expect(requests[0]?.url.href).toContain("/activities?");
    expect(requests[0]?.url.searchParams.get("mine")).toBe("true");
    expect(requests[0]?.url.searchParams.get("maxResults")).toBe("3");
  });

  it("maps i18n languages and regions to code/name pairs", async () => {
    const fetch = fakeFetch((request) =>
      request.url.href.includes("i18nLanguages")
        ? json({ items: [{ id: "pt", snippet: { hl: "pt", name: "Português" } }] })
        : json({ items: [{ id: "BR", snippet: { gl: "BR", name: "Brasil" } }] }),
    );
    const client = new YouTubeClient({ fetch, credential: { accessToken: "unit-test-token" } });

    expect(await client.listI18nLanguages({})).toEqual({
      languages: [{ code: "pt", name: "Português" }],
      totalResults: 1,
    });
    expect(await client.listI18nRegions({})).toEqual({
      regions: [{ code: "BR", name: "Brasil" }],
      totalResults: 1,
    });
  });

  it("returns the caller's own like/dislike rating for videos", async () => {
    const requests: RequestRecord[] = [];
    const fetch = fakeFetch((request) => {
      requests.push(request);
      return json({
        items: [
          { videoId: "vid-1", rating: "like" },
          { videoId: "vid-2", rating: "none" },
        ],
      });
    });
    const client = new YouTubeClient({ fetch, credential: { accessToken: "unit-test-token" } });

    expect(await client.getVideoRating(["vid-1", "vid-2"])).toEqual({
      ratings: [
        { videoId: "vid-1", rating: "like" },
        { videoId: "vid-2", rating: "none" },
      ],
      totalResults: 2,
    });
    expect(requests[0]?.url.href).toContain("/videos/getRating?");
    expect(requests[0]?.url.searchParams.get("id")).toBe("vid-1,vid-2");
  });

  it("merges channel branding before updating and refetches channel info", async () => {
    const requests: RequestRecord[] = [];
    const fetch = fakeFetch((request) => {
      requests.push(request);
      if (requests.length === 1) {
        return json({ items: [{ id: "UC1", brandingSettings: { channel: { description: "old", keywords: "a b" } } }] });
      }
      if (request.init.method === "PUT") return json({});
      return json({ items: [{ id: "UC1", snippet: { title: "Canal" }, statistics: {}, contentDetails: {} }] });
    });
    const client = new YouTubeClient({ fetch, credential: { accessToken: "unit-test-token" } });

    const result = await client.updateChannel({ description: "new" });
    expect(result.success).toBe(true);
    expect(requests[1]?.init.method).toBe("PUT");
    expect(requests[1]?.url.searchParams.get("part")).toBe("brandingSettings");
    expect(JSON.parse(String(requests[1]?.init.body))).toEqual({
      id: "UC1",
      brandingSettings: {
        channel: { description: "new", keywords: "a b", country: undefined, defaultLanguage: undefined },
      },
    });
  });

  it("rejects a channel update with no fields", async () => {
    const fetch = fakeFetch(() => json({}));
    const client = new YouTubeClient({ fetch, credential: { accessToken: "unit-test-token" } });
    await expect(client.updateChannel({})).rejects.toThrow("at least one channel branding field");
  });

  it("updates playlist metadata after reading current values", async () => {
    const requests: RequestRecord[] = [];
    const fetch = fakeFetch((request) => {
      requests.push(request);
      if (requests.length === 1) {
        return json({
          items: [{ id: "PL1", snippet: { title: "old", description: "d" }, status: { privacyStatus: "public" } }],
        });
      }
      return json({
        id: "PL1",
        snippet: { title: "new", description: "d", publishedAt: "2026-01-01T00:00:00Z" },
        status: { privacyStatus: "public" },
        contentDetails: { itemCount: 3 },
      });
    });
    const client = new YouTubeClient({ fetch, credential: { accessToken: "unit-test-token" } });

    const result = await client.updatePlaylist("PL1", { title: "new" });
    expect(result.playlist.title).toBe("new");
    expect(requests[1]?.init.method).toBe("PUT");
    expect(JSON.parse(String(requests[1]?.init.body))).toEqual({
      id: "PL1",
      snippet: { title: "new", description: "d" },
      status: { privacyStatus: "public" },
    });
  });

  it("moves a playlist item preserving playlistId and resourceId", async () => {
    const requests: RequestRecord[] = [];
    const fetch = fakeFetch((request) => {
      requests.push(request);
      if (requests.length === 1) {
        return json({
          items: [
            { id: "PI1", snippet: { playlistId: "PL1", resourceId: { kind: "youtube#video", videoId: "vid-1" } } },
          ],
        });
      }
      return json({ id: "PI1", snippet: { playlistId: "PL1", resourceId: { videoId: "vid-1" }, position: 0 } });
    });
    const client = new YouTubeClient({ fetch, credential: { accessToken: "unit-test-token" } });

    const result = await client.movePlaylistItem("PI1", 0);
    expect(result.item).toEqual({ playlistItemId: "PI1", playlistId: "PL1", videoId: "vid-1", position: 0 });
    expect(JSON.parse(String(requests[1]?.init.body))).toEqual({
      id: "PI1",
      snippet: { playlistId: "PL1", resourceId: { kind: "youtube#video", videoId: "vid-1" }, position: 0 },
    });
  });

  it("publishes a top-level comment thread and returns thread and comment ids", async () => {
    const requests: RequestRecord[] = [];
    const fetch = fakeFetch((request) => {
      requests.push(request);
      return json({ id: "thread-1", snippet: { topLevelComment: { id: "comment-1" } } });
    });
    const client = new YouTubeClient({ fetch, credential: { accessToken: "unit-test-token" } });

    expect(await client.insertComment("vid-1", "Olá")).toEqual({
      success: true,
      threadId: "thread-1",
      commentId: "comment-1",
    });
    expect(requests[0]?.url.href).toBe("https://www.googleapis.com/youtube/v3/commentThreads?part=snippet");
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual({
      snippet: { videoId: "vid-1", topLevelComment: { snippet: { textOriginal: "Olá" } } },
    });
  });

  it("sets comment moderation status via query params without a body", async () => {
    const requests: RequestRecord[] = [];
    const fetch = fakeFetch((request) => {
      requests.push(request);
      return new Response("", { status: 204 });
    });
    const client = new YouTubeClient({ fetch, credential: { accessToken: "unit-test-token" } });

    expect(await client.setCommentModeration("comment-1", "rejected", true)).toEqual({
      success: true,
      commentId: "comment-1",
      moderationStatus: "rejected",
    });
    expect(requests[0]?.url.href).toContain("/comments/setModerationStatus?");
    expect(requests[0]?.init.method).toBe("POST");
    expect(requests[0]?.url.searchParams.get("moderationStatus")).toBe("rejected");
    expect(requests[0]?.url.searchParams.get("banAuthor")).toBe("true");
    expect(requests[0]?.init.body).toBeUndefined();
  });

  it("deletes and edits comments through the official endpoints", async () => {
    const requests: RequestRecord[] = [];
    const fetch = fakeFetch((request) => {
      requests.push(request);
      if (request.init.method === "DELETE") return new Response("", { status: 204 });
      return json({ id: "comment-1", snippet: { textDisplay: "novo" } });
    });
    const client = new YouTubeClient({ fetch, credential: { accessToken: "unit-test-token" } });

    expect(await client.deleteComment("comment-1")).toEqual({ success: true, deleted: "comment-1" });
    expect(requests[0]?.init.method).toBe("DELETE");
    expect(await client.updateComment("comment-1", "novo")).toEqual({
      success: true,
      commentId: "comment-1",
      text: "novo",
    });
    expect(requests[1]?.init.method).toBe("PUT");
  });

  it("subscribes and unsubscribes through the subscriptions endpoints", async () => {
    const requests: RequestRecord[] = [];
    const fetch = fakeFetch((request) => {
      requests.push(request);
      if (request.init.method === "DELETE") return new Response("", { status: 204 });
      return json({ id: "sub-1" });
    });
    const client = new YouTubeClient({ fetch, credential: { accessToken: "unit-test-token" } });

    expect(await client.subscribe("UC2")).toEqual({ success: true, subscriptionId: "sub-1", channelId: "UC2" });
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual({
      snippet: { resourceId: { kind: "youtube#channel", channelId: "UC2" } },
    });
    expect(await client.unsubscribe("sub-1")).toEqual({ success: true, deleted: "sub-1" });
    expect(requests[1]?.init.method).toBe("DELETE");
    expect(requests[1]?.url.searchParams.get("id")).toBe("sub-1");
  });

  it("deletes a caption track", async () => {
    const requests: RequestRecord[] = [];
    const fetch = fakeFetch((request) => {
      requests.push(request);
      return new Response("", { status: 204 });
    });
    const client = new YouTubeClient({ fetch, credential: { accessToken: "unit-test-token" } });

    expect(await client.deleteCaption("caption-1")).toEqual({ success: true, deleted: "caption-1" });
    expect(requests[0]?.url.href).toContain("/captions?");
    expect(requests[0]?.init.method).toBe("DELETE");
  });

  it("uploads a thumbnail to the media endpoint with the image content type", async () => {
    const requests: RequestRecord[] = [];
    const fetch = fakeFetch((request) => {
      requests.push(request);
      return json({ items: [{ high: { url: "https://example.test/hq.jpg" } }] });
    });
    const client = new YouTubeClient({ fetch, credential: { accessToken: "unit-test-token" } });

    const result = await client.setThumbnail("vid-1", { data: new Uint8Array([1, 2, 3]), contentType: "image/jpeg" });
    expect(result).toEqual({ success: true, videoId: "vid-1", thumbnail: "https://example.test/hq.jpg" });
    expect(requests[0]?.url.href).toContain("https://www.googleapis.com/upload/youtube/v3/thumbnails/set");
    expect(requests[0]?.url.searchParams.get("videoId")).toBe("vid-1");
    expect(requests[0]?.url.searchParams.get("uploadType")).toBe("media");
    expect(requests[0]?.init.method).toBe("POST");
    expect((requests[0]?.init.headers as Record<string, string>)["content-type"]).toBe("image/jpeg");
  });
});
