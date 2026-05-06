import { describe, expect, it } from "bun:test";
import { createDevinClientFromEnv, DevinApiError, DevinClient } from "./client.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("DevinClient", () => {
  it("builds organization session requests without leaking auth into the URL", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const client = new DevinClient({
      apiKey: "cog_test",
      orgId: "org_123",
      baseUrl: "https://api.example.test/v3",
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), init: init ?? {} });
        return jsonResponse({
          session_id: "devin-abc",
          org_id: "org_123",
          url: "https://app.devin.ai/s/devin-abc",
          status: "running",
          tags: ["ravi"],
          pull_requests: [],
          acus_consumed: 0,
          created_at: 1,
          updated_at: 2,
        });
      },
    });

    await client.createSession({
      prompt: "do work",
      title: "Test",
      tags: ["ravi"],
      max_acu_limit: 500,
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://api.example.test/v3/organizations/org_123/sessions");
    expect(requests[0]?.url).not.toContain("cog_test");
    expect(requests[0]?.init.method).toBe("POST");
    expect(requests[0]?.init.headers).toMatchObject({
      Authorization: "Bearer cog_test",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(requests[0]?.init.body))).toMatchObject({
      prompt: "do work",
      max_acu_limit: 500,
    });
  });

  it("lists all paginated messages", async () => {
    const afterValues: Array<string | null> = [];
    const client = new DevinClient({
      apiKey: "cog_test",
      orgId: "org_123",
      fetchImpl: async (url) => {
        const parsed = new URL(String(url));
        afterValues.push(parsed.searchParams.get("after"));
        if (!parsed.searchParams.get("after")) {
          return jsonResponse({
            items: [{ event_id: "a", created_at: 1, source: "devin", message: "one" }],
            end_cursor: "cursor-1",
            has_next_page: true,
          });
        }
        return jsonResponse({
          items: [{ event_id: "b", created_at: 2, source: "user", message: "two" }],
          end_cursor: null,
          has_next_page: false,
        });
      },
    });

    const messages = await client.listAllMessages("devin-abc");
    expect(messages.map((message) => message.event_id)).toEqual(["a", "b"]);
    expect(afterValues).toEqual([null, "cursor-1"]);
  });

  it("gets session insights from the organization scoped endpoint", async () => {
    const requests: Array<{ url: string; method?: string }> = [];
    const client = new DevinClient({
      apiKey: "cog_test",
      orgId: "org_123",
      baseUrl: "https://api.example.test/v3",
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), method: init?.method });
        return jsonResponse({
          session_id: "devin-abc",
          org_id: "org_123",
          url: "https://app.devin.ai/sessions/abc",
          status: "running",
          status_detail: "working",
          tags: ["ravi"],
          pull_requests: [],
          acus_consumed: 0,
          created_at: 1,
          updated_at: 2,
          num_user_messages: 1,
          num_devin_messages: 2,
          session_size: "xs",
          analysis: null,
        });
      },
    });

    const insights = await client.getSessionInsights("abc");

    expect(insights.session_id).toBe("devin-abc");
    expect(insights.num_user_messages).toBe(1);
    expect(requests).toEqual([
      {
        url: "https://api.example.test/v3/organizations/org_123/sessions/devin-abc/insights",
        method: "GET",
      },
    ]);
    expect(requests[0]?.url).not.toContain("cog_test");
  });

  it("generates session insights from the organization scoped endpoint", async () => {
    const requests: Array<{ url: string; method?: string }> = [];
    const client = new DevinClient({
      apiKey: "cog_test",
      orgId: "org_123",
      baseUrl: "https://api.example.test/v3",
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), method: init?.method });
        return jsonResponse({
          session_id: "devin-abc",
          org_id: "org_123",
          url: "https://app.devin.ai/sessions/abc",
          status: "running",
          tags: ["ravi"],
          pull_requests: [],
          acus_consumed: 0,
          created_at: 1,
          updated_at: 2,
          analysis: { timeline: [] },
        });
      },
    });

    await client.generateSessionInsights("devin-abc");

    expect(requests).toEqual([
      {
        url: "https://api.example.test/v3/organizations/org_123/sessions/devin-abc/insights/generate",
        method: "POST",
      },
    ]);
  });

  it("maps API errors to stable local codes", async () => {
    const client = new DevinClient({
      apiKey: "cog_test",
      orgId: "org_123",
      fetchImpl: async () => jsonResponse({ detail: "slow down" }, 429),
    });

    await expect(client.self()).rejects.toMatchObject({
      name: "DevinApiError",
      code: "devin.rate_limited",
      status: 429,
    } satisfies Partial<DevinApiError>);
  });

  it("validates service user env shape", () => {
    expect(() =>
      createDevinClientFromEnv({
        DEVIN_API_KEY: "apk_user_bad",
        DEVIN_ORG_ID: "org_123",
      } as NodeJS.ProcessEnv),
    ).toThrow("cog_");
  });
});
