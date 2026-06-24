import { afterEach, describe, expect, it, mock } from "bun:test";
import { fetchCachedOmniMedia, fetchOmniMedia } from "./media.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("media utilities", () => {
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
