import { afterEach, describe, expect, test } from "bun:test";

import { DELETE, GET } from "./route";

const TOKEN = "test-admin-token-with-enough-length-aaaa";
const BUG_ID = "11111111-1111-4111-8111-111111111111";

function makeRequest(method: "GET" | "DELETE", headers: Record<string, string> = {}) {
  return new Request(`https://example.test/api/internal/admin/bugs/${BUG_ID}`, {
    headers,
    method,
  });
}

function routeContext() {
  return { params: Promise.resolve({ id: BUG_ID }) };
}

describe("admin bug report DELETE authorization", () => {
  const original = process.env.RAVI_ADMIN_TOKEN;

  afterEach(() => {
    if (original === undefined) delete process.env.RAVI_ADMIN_TOKEN;
    else process.env.RAVI_ADMIN_TOKEN = original;
  });

  test("returns 503 when the admin token is not configured", async () => {
    delete process.env.RAVI_ADMIN_TOKEN;
    const response = await DELETE(makeRequest("DELETE", { authorization: `Bearer ${TOKEN}` }), routeContext());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ status: "error", code: "admin_token_not_configured" });
  });

  test("returns 401 when the bearer token is missing or wrong", async () => {
    process.env.RAVI_ADMIN_TOKEN = TOKEN;
    const missing = await DELETE(makeRequest("DELETE"), routeContext());
    expect(missing.status).toBe(401);
    expect(await missing.json()).toMatchObject({ status: "error", code: "unauthorized" });

    const wrong = await DELETE(
      makeRequest("DELETE", { authorization: "Bearer wrong-token-with-enough-len-aaaa" }),
      routeContext(),
    );
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toMatchObject({ status: "error", code: "unauthorized" });
  });

  test("GET stays gated the same way and remains available", async () => {
    process.env.RAVI_ADMIN_TOKEN = TOKEN;
    const response = await GET(makeRequest("GET"), routeContext());
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ status: "error", code: "unauthorized" });
  });
});
