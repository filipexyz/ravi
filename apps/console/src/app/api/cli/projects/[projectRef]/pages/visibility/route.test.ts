import { describe, expect, test } from "bun:test";

import { PATCH } from "./route";

function routeContext() {
  return { params: Promise.resolve({ projectRef: "demo-project" }) };
}

describe("PATCH /api/cli/projects/:projectRef/pages/visibility", () => {
  test("returns AUTH_REQUIRED without CLI auth", async () => {
    const request = new Request("https://example.test/api/cli/projects/demo-project/pages/visibility", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ siteRef: "demo", path: "/", visibility: "public" }),
    });

    const response = await PATCH(request as never, routeContext());
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toMatch(/json/);
    expect(await response.json()).toMatchObject({
      error: { code: "AUTH_REQUIRED" },
    });
  });
});
