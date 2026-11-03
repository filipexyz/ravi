import { describe, expect, test } from "bun:test";

import { POST } from "./route";

const BUG_ID = "11111111-1111-4111-8111-111111111111";

function routeContext() {
  return { params: Promise.resolve({ id: BUG_ID }) };
}

describe("POST /api/cli/bugs/:id/comments", () => {
  test("returns AUTH_REQUIRED without CLI auth instead of an HTML 404", async () => {
    const request = new Request(`https://example.test/api/cli/bugs/${BUG_ID}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schemaVersion: "ravi.bug_comment/v1",
        text: "follow-up",
        payload: { schemaVersion: "ravi.bug_comment/v1", text: "follow-up", source: "cli" },
        idempotencyKey: "sha256:test-unauthenticated-key",
      }),
    });

    const response = await POST(request as never, routeContext());
    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toMatch(/json/);
    expect(await response.json()).toMatchObject({
      error: { code: "AUTH_REQUIRED" },
    });
  });
});
