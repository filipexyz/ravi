import { describe, expect, test } from "bun:test";

import { CloudAuthError } from "../cloud-auth/errors.js";
import { LinkApiClient, normalizeLinkUrl } from "./client.js";

function mockFetch(handler: (url: string, init?: RequestInit) => Promise<Response>) {
  return (async (url: string, init?: RequestInit) => handler(url, init)) as (
    url: string,
    init?: RequestInit,
  ) => Promise<Response>;
}

describe("LinkApiClient", () => {
  test("normalizeLinkUrl strips trailing slash and adds https", () => {
    expect(normalizeLinkUrl("link.ravi.so")).toBe("https://link.ravi.so");
    expect(normalizeLinkUrl("https://link.ravi.so/")).toBe("https://link.ravi.so");
  });

  test("issues an Authorization header with the bearer", async () => {
    let captured: { url: string; init?: RequestInit } | null = null;
    const client = new LinkApiClient({
      linkUrl: "https://link.ravi.so",
      fetch: mockFetch(async (url, init) => {
        captured = { url, init };
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    });
    const result = await client.request<{ ok: boolean }>("GET", "/cli/connect/list", "bearer-xyz");
    expect(result.ok).toBe(true);
    const seen = captured as { url: string; init?: RequestInit } | null;
    expect(seen?.url).toBe("https://link.ravi.so/cli/connect/list");
    const headers = seen?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer bearer-xyz");
  });

  test("maps 401 to AUTH_EXPIRED CloudAuthError", async () => {
    const client = new LinkApiClient({
      fetch: mockFetch(async () => new Response(JSON.stringify({ error: "connector_unauthorized" }), { status: 401 })),
    });
    await expect(client.request("GET", "/cli/connect/list", "bad")).rejects.toMatchObject({
      code: "AUTH_EXPIRED",
    });
  });

  test("maps 429 to RATE_LIMITED", async () => {
    const client = new LinkApiClient({
      fetch: mockFetch(async () => new Response(JSON.stringify({ error: "connector_rate_limited" }), { status: 429 })),
    });
    await expect(client.request("POST", "/cli/exec/abc", "tok", {})).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
  });

  test("wraps network errors as SERVER_UNAVAILABLE", async () => {
    const client = new LinkApiClient({
      fetch: mockFetch(async () => {
        throw new Error("ECONNREFUSED");
      }),
    });
    await expect(client.request("GET", "/cli/connect/list", "tok")).rejects.toBeInstanceOf(CloudAuthError);
  });
});
