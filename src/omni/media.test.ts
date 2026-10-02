import { afterEach, describe, expect, it, mock } from "bun:test";
import type { ChannelInboundEventOf } from "../channels/inbound/types.js";
import { createOmniMediaLoader, fetchCachedOmniMedia, fetchOmniMedia } from "./media.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Omni media fetchers", () => {
  it("rejects HTML responses when media bytes are expected", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response("<!DOCTYPE html><html><body>login required</body></html>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    ) as unknown as typeof fetch;

    const result = await fetchOmniMedia(
      "https://files.slack.com/private/photo.png",
      "http://omni.local",
      "test-key",
      undefined,
      "image/png",
    );

    expect(result).toBeNull();
  });

  it("fetches media through the Omni cache endpoint", async () => {
    const calls: string[] = [];
    globalThis.fetch = mock(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/api/v2/messages/media/download")) {
        return Response.json({
          data: {
            downloadUrl: "/api/v2/media/inst-1/2026-06/msg-1.png",
          },
        });
      }
      return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    }) as unknown as typeof fetch;

    const result = await fetchCachedOmniMedia(
      { instanceId: "inst-1", chatExternalId: "C123", externalId: "123.456-file-F1" },
      "http://omni.local",
      "test-key",
      undefined,
      "image/png",
    );

    expect(result?.length).toBe(4);
    expect(calls).toEqual([
      "http://omni.local/api/v2/messages/media/download",
      "http://omni.local/api/v2/media/inst-1/2026-06/msg-1.png",
    ]);
  });
});

function omniMediaEvent(content: Record<string, unknown>): ChannelInboundEventOf<"message.received"> {
  return {
    id: "evt-1",
    type: "message.received",
    channelType: "telegram",
    instanceId: "inst-1",
    timestamp: 1,
    provenance: { transport: "omni", subject: "message.received.telegram.inst-1" },
    payload: { externalId: "msg-1", chatId: "C123", from: "u1", content: { type: "image", ...content } },
  };
}

function recordingFetch(handler: (url: string) => Response) {
  const calls: Array<{ url: string; method: string; body?: string; apiKey?: string }> = [];
  globalThis.fetch = mock(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({
      url,
      method: init?.method ?? "GET",
      ...(typeof init?.body === "string" ? { body: init.body } : {}),
      apiKey: headers.get("x-api-key") ?? undefined,
    });
    return handler(url);
  }) as unknown as typeof fetch;
  return calls;
}

const png = () => new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { headers: { "content-type": "image/png" } });

describe("createOmniMediaLoader", () => {
  const load = createOmniMediaLoader({ apiUrl: "http://omni.local", apiKey: "test-key" });

  it("returns null without a media URL and never touches the network", async () => {
    const calls = recordingFetch(() => png());
    expect(
      await load(omniMediaEvent({ localPath: "/tmp/x.png" }), { maxBytes: 1_000, mimeType: "image/png" }),
    ).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("fetches relative Omni media paths directly", async () => {
    const calls = recordingFetch(() => png());
    const buffer = await load(omniMediaEvent({ mediaUrl: "/api/v2/media/inst-1/a.png" }), {
      maxBytes: 1_000,
      mimeType: "image/png",
    });
    expect(buffer?.length).toBe(4);
    expect(calls).toEqual([{ url: "http://omni.local/api/v2/media/inst-1/a.png", method: "GET", apiKey: "test-key" }]);
  });

  it("asks Omni to cache http media first, with the message reference", async () => {
    const calls = recordingFetch((url) =>
      url.endsWith("/api/v2/messages/media/download")
        ? Response.json({ data: { downloadUrl: "/api/v2/media/inst-1/cached.png" } })
        : png(),
    );
    const buffer = await load(omniMediaEvent({ mediaUrl: "https://files.example/a.png" }), {
      maxBytes: 1_000,
      mimeType: "image/png",
    });
    expect(buffer?.length).toBe(4);
    expect(calls.map(({ url, method }) => `${method} ${url}`)).toEqual([
      "POST http://omni.local/api/v2/messages/media/download",
      "GET http://omni.local/api/v2/media/inst-1/cached.png",
    ]);
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
      instanceId: "inst-1",
      chatExternalId: "C123",
      externalId: "msg-1",
    });
  });

  it("falls back to the http URL when the cache request fails", async () => {
    const calls = recordingFetch((url) =>
      url.endsWith("/api/v2/messages/media/download") ? new Response("nope", { status: 500 }) : png(),
    );
    const buffer = await load(omniMediaEvent({ mediaUrl: "https://files.example/a.png" }), {
      maxBytes: 1_000,
      mimeType: "image/png",
    });
    expect(buffer?.length).toBe(4);
    expect(calls.map(({ url }) => url)).toEqual([
      "http://omni.local/api/v2/messages/media/download",
      "https://files.example/a.png",
    ]);
  });

  it("applies the size limit", async () => {
    recordingFetch(() => png());
    expect(
      await load(omniMediaEvent({ mediaUrl: "/api/v2/media/inst-1/a.png" }), { maxBytes: 2, mimeType: "image/png" }),
    ).toBeNull();
  });
});
