import { describe, expect, test } from "bun:test";

import { POST } from "./route";

describe("POST /api/cli/pages/kit", () => {
  // The OSS reads a bare 404 or 405 as an older Console; this route always answers a coded error.
  test("returns a coded AUTH_REQUIRED without CLI auth", async () => {
    const request = new Request("https://example.test/api/cli/pages/kit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: "demo", site: "demo", route: "/", visibility: "private", theme: null, files: [] }),
    });

    const response = await POST(request as never);
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ error: { code: "AUTH_REQUIRED" } });
  });
});
