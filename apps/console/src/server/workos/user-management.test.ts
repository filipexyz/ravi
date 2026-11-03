import { describe, expect, test } from "bun:test";

import {
  fetchWorkosUserManagementMetadata,
  isWorkosUserManagementUserId,
  workosUserManagementUserUrl,
} from "./user-management";

describe("WorkOS User Management metadata fetch", () => {
  test("accepts WorkOS user ids", () => {
    expect(isWorkosUserManagementUserId("user_01HPLATFORMOPS")).toBe(true);
    expect(isWorkosUserManagementUserId("email:ops@ravi.bot")).toBe(false);
    expect(isWorkosUserManagementUserId("org_01HABC")).toBe(false);
  });

  test("reads metadata from GET /user_management/users/:id", async () => {
    const calls: Array<{ headers: HeadersInit | undefined; url: string }> = [];
    const result = await fetchWorkosUserManagementMetadata("user_01HPLATFORMOPS", {
      apiKey: "sk_test_operator",
      fetchImpl: (async (url: string | URL, init?: RequestInit) => {
        calls.push({ headers: init?.headers, url: String(url) });
        return new Response(
          JSON.stringify({
            id: "user_01HPLATFORMOPS",
            email: "ops@ravi.bot",
            metadata: { ravi_platform_operator: "true" },
          }),
          { headers: { "content-type": "application/json" }, status: 200 },
        );
      }) as typeof fetch,
    });

    expect(calls).toEqual([
      {
        headers: {
          Accept: "application/json",
          Authorization: "Bearer sk_test_operator",
        },
        url: workosUserManagementUserUrl("user_01HPLATFORMOPS"),
      },
    ]);
    expect(result).toEqual({
      ok: true,
      metadata: { ravi_platform_operator: "true" },
    });
  });

  test("treats a missing metadata object on a successful user payload as empty metadata", async () => {
    const result = await fetchWorkosUserManagementMetadata("user_01HPLATFORMOPS", {
      apiKey: "sk_test_operator",
      fetchImpl: (async () =>
        new Response(JSON.stringify({ id: "user_01HPLATFORMOPS", email: "ops@ravi.bot" }), {
          headers: { "content-type": "application/json" },
          status: 200,
        })) as unknown as typeof fetch,
    });

    expect(result).toEqual({ ok: true, metadata: {} });
  });

  test("does not treat a failed lookup as resolved empty metadata", async () => {
    await expect(
      fetchWorkosUserManagementMetadata("user_01HPLATFORMOPS", {
        apiKey: "sk_test_operator",
        fetchImpl: (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch,
      }),
    ).resolves.toEqual({ ok: false, reason: "bad_status" });

    await expect(fetchWorkosUserManagementMetadata("user_01HPLATFORMOPS", { apiKey: "" })).resolves.toEqual({
      ok: false,
      reason: "missing_api_key",
    });
  });
});
