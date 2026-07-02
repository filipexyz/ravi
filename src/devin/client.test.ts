import { describe, expect, it } from "bun:test";
import {
  createDevinClientFromEnv,
  DevinApiError,
  DevinClient,
  getDefaultCreateAsUserId,
  getDefaultDevinMode,
  getDefaultDevinPlatform,
  getDefaultDevinRepos,
} from "./client.js";

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

  it("sends v3 fields only when explicitly provided", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    const client = new DevinClient({
      apiKey: "cog_test",
      orgId: "org_123",
      baseUrl: "https://api.example.test/v3",
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return jsonResponse({
          session_id: "devin-v3test",
          org_id: "org_123",
          url: "https://app.devin.ai/s/devin-v3test",
          status: "running",
          tags: [],
          pull_requests: [],
          acus_consumed: 0,
          created_at: 1,
          updated_at: 2,
        });
      },
    });

    await client.createSession({
      prompt: "test v3",
      devin_mode: "fast",
      platform: "windows",
      resumable: false,
      structured_output_required: true,
      session_secrets: [{ key: "MY_KEY", value: "secret_val", sensitive: true }],
    });

    expect(requests).toHaveLength(1);
    const body = requests[0]?.body as Record<string, unknown>;
    expect(body.prompt).toBe("test v3");
    expect(body.devin_mode).toBe("fast");
    expect(body.platform).toBe("windows");
    expect(body.resumable).toBe(false);
    expect(body.structured_output_required).toBe(true);
    expect(body.session_secrets).toEqual([{ key: "MY_KEY", value: "secret_val", sensitive: true }]);
  });

  it("omits v3 fields when not provided", async () => {
    const requests: Array<{ body: unknown }> = [];
    const client = new DevinClient({
      apiKey: "cog_test",
      orgId: "org_123",
      fetchImpl: async (_url, init) => {
        requests.push({ body: JSON.parse(String(init?.body)) });
        return jsonResponse({
          session_id: "devin-omit",
          org_id: "org_123",
          url: "https://app.devin.ai/s/devin-omit",
          status: "running",
          tags: [],
          pull_requests: [],
          acus_consumed: 0,
          created_at: 1,
          updated_at: 2,
        });
      },
    });

    await client.createSession({ prompt: "minimal" });

    const body = requests[0]?.body as Record<string, unknown>;
    expect(body).toEqual({ prompt: "minimal" });
    expect(body).not.toHaveProperty("devin_mode");
    expect(body).not.toHaveProperty("platform");
    expect(body).not.toHaveProperty("resumable");
    expect(body).not.toHaveProperty("session_secrets");
    expect(body).not.toHaveProperty("structured_output_required");
  });

  it("sends idempotency key as query parameter", async () => {
    const requests: Array<{ url: string }> = [];
    const client = new DevinClient({
      apiKey: "cog_test",
      orgId: "org_123",
      baseUrl: "https://api.example.test/v3",
      fetchImpl: async (url) => {
        requests.push({ url: String(url) });
        return jsonResponse({
          session_id: "devin-idem",
          org_id: "org_123",
          url: "https://app.devin.ai/s/devin-idem",
          status: "running",
          tags: [],
          pull_requests: [],
          acus_consumed: 0,
          created_at: 1,
          updated_at: 2,
        });
      },
    });

    await client.createSession({ prompt: "idempotent" }, { idempotencyKey: "devin-custom-id" });

    expect(requests[0]?.url).toContain("devin_id=devin-custom-id");
  });

  it("resolves env config defaults correctly", () => {
    expect(getDefaultDevinMode({ DEVIN_DEFAULT_MODE: "fast" } as NodeJS.ProcessEnv)).toBe("fast");
    expect(getDefaultDevinMode({ DEVIN_DEFAULT_MODE: "" } as NodeJS.ProcessEnv)).toBeUndefined();
    expect(getDefaultDevinPlatform({ DEVIN_DEFAULT_PLATFORM: "windows" } as NodeJS.ProcessEnv)).toBe("windows");
    expect(getDefaultDevinRepos({ DEVIN_DEFAULT_REPOS: "repo1,repo2" } as NodeJS.ProcessEnv)).toEqual([
      "repo1",
      "repo2",
    ]);
    expect(getDefaultDevinRepos({ DEVIN_DEFAULT_REPOS: "" } as NodeJS.ProcessEnv)).toBeUndefined();
    expect(getDefaultCreateAsUserId({ DEVIN_DEFAULT_CREATE_AS_USER_ID: "user_abc" } as NodeJS.ProcessEnv)).toBe(
      "user_abc",
    );
  });
});
