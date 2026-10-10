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

  test("keeps only the approval id, expiry and reason of an approval answer", async () => {
    const client = new LinkApiClient({
      fetch: mockFetch(
        async () =>
          new Response(
            JSON.stringify({
              error: "connector_approval_required",
              approvalId: "apr_123",
              approvalUrl: "https://evil.example/connectors/approvals/apr_123",
              expiresAt: "2026-10-10T12:00:00.000Z",
              reason: "write_after_read",
              preview: "PRIVATE_MESSAGE_8K2R",
            }),
            { status: 409 },
          ),
      ),
    });

    const error = (await client.request("POST", "/cli/exec/abc", "tok", {}).catch((e) => e)) as CloudAuthError;

    expect(error.code).toBe("CONNECTOR_APPROVAL_REQUIRED");
    expect(error.details).toEqual({
      approvalId: "apr_123",
      expiresAt: "2026-10-10T12:00:00.000Z",
      reason: "write_after_read",
    });
  });

  test("drops a malformed approval id", async () => {
    const client = new LinkApiClient({
      fetch: mockFetch(
        async () =>
          new Response(JSON.stringify({ error: "connector_approval_pending", approvalId: "../../x" }), { status: 409 }),
      ),
    });

    const error = (await client.request("POST", "/cli/exec/abc", "tok", {}).catch((e) => e)) as CloudAuthError;

    expect(error.code).toBe("CONNECTOR_APPROVAL_PENDING");
    expect(error.details).toBeUndefined();
  });

  test("keeps only the read-only flag of a permission answer", async () => {
    const answer = (body: Record<string, unknown>) =>
      new LinkApiClient({
        fetch: mockFetch(async () => new Response(JSON.stringify(body), { status: 403 })),
      })
        .request("POST", "/cli/exec/abc", "tok", {})
        .catch((e) => e) as Promise<CloudAuthError>;

    const readOnly = await answer({ error: "connector_permission_required", accessMode: "read_only", requestId: "r" });
    expect(readOnly.code).toBe("CONNECTOR_PERMISSION_REQUIRED");
    expect(readOnly.details).toEqual({ accessMode: "read_only" });

    const missing = await answer({ error: "connector_permission_required", missingScopes: ["gmail.send"] });
    expect(missing.code).toBe("CONNECTOR_PERMISSION_REQUIRED");
    expect(missing.details).toBeUndefined();
  });

  test("maps the Worker's policy answers to their CLI codes", async () => {
    const cases: Array<[number, string, string]> = [
      [403, "connector_group_blocked", "CONNECTOR_GROUP_BLOCKED"],
      [403, "connector_speaker_not_owner", "CONNECTOR_SPEAKER_NOT_OWNER"],
      [403, "connector_disabled_by_org", "CONNECTOR_DISABLED_BY_ORG"],
      [403, "connector_tool_blocked", "CONNECTOR_TOOL_BLOCKED"],
      [409, "connector_approval_required", "CONNECTOR_APPROVAL_REQUIRED"],
      [409, "connector_approval_pending", "CONNECTOR_APPROVAL_PENDING"],
      [403, "connector_approval_denied", "CONNECTOR_APPROVAL_DENIED"],
      [400, "connector_approval_invalid", "CONNECTOR_APPROVAL_INVALID"],
      [409, "connector_consent_required", "CONNECTOR_CONSENT_REQUIRED"],
      [403, "connector_not_linked", "CONNECTOR_NOT_LINKED"],
      [409, "connector_connection_required", "CONNECTOR_CONNECTION_REQUIRED"],
      [409, "connector_policy_above_ceiling", "CONNECTOR_POLICY_ABOVE_CEILING"],
      [403, "connector_forbidden", "CONNECTOR_FORBIDDEN"],
    ];
    for (const [status, workerCode, cliCode] of cases) {
      const client = new LinkApiClient({
        fetch: mockFetch(
          async () => new Response(JSON.stringify({ error: workerCode, requestId: "req_1" }), { status }),
        ),
      });
      const error = (await client.request("POST", "/cli/exec/abc", "tok", {}).catch((e) => e)) as CloudAuthError;
      const seen: { workerCode: string; code: string; status?: number } = {
        workerCode,
        code: error.code,
        status: error.status,
      };
      expect(seen).toEqual({ workerCode, code: cliCode, status });
    }
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
