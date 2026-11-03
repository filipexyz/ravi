import { describe, expect, test } from "bun:test";

import Anthropic from "@anthropic-ai/sdk";

import { ANTHROPIC_MANAGED_AGENTS_BETA, anthropicCloudProvider } from "./anthropic";
import { CloudProviderError } from "./types";

// The adapter over the real SDK with a scripted fetch: request shapes, event
// normalization, the event cursor and error mapping. Never reaches the network.
type Recorded = { method: string; path: string; search: URLSearchParams; headers: Headers; body: unknown };
type Reply = { status?: number; json: unknown };

function scripted(routes: (request: Recorded) => Reply | undefined) {
  const requests: Recorded[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    const request = { method: init?.method ?? "GET", path: url.pathname, search: url.searchParams, headers: new Headers(init?.headers), body };
    requests.push(request);
    const reply = routes(request) ?? { status: 404, json: { type: "error", error: { type: "not_found_error", message: "no route" } } };
    return new Response(JSON.stringify(reply.json), { status: reply.status ?? 200, headers: { "content-type": "application/json" } });
  };
  const client = new Anthropic({ apiKey: "sk-ant-fake-test", baseURL: "https://anthropic.test.invalid", fetch: fetch as typeof globalThis.fetch, maxRetries: 0 });
  return { provider: anthropicCloudProvider({ apiKey: "sk-ant-fake-test", client }), requests };
}

const event = (id: string, type: string, processedAt: string | null, extra: Record<string, unknown> = {}) => ({
  id,
  type,
  processed_at: processedAt,
  ...extra,
});

describe("Anthropic managed agents adapter", () => {
  test("creates a session with the beta header, agent version, vault, budget and repositories", async () => {
    const { provider, requests } = scripted((request) =>
      request.method === "POST" && request.path === "/v1/sessions" ? { json: { id: "sesn_1", type: "session" } } : undefined,
    );
    const created = await provider.createSession({
      agentId: "agent_1",
      agentVersion: 3,
      environmentId: "env_1",
      vaultIds: ["vlt_1"],
      budgetCents: 250,
      resources: [{ url: "https://github.com/acme/site", authorizationToken: "ghs_fake", branch: "main" }],
      title: "Reporter: weekly",
      metadata: { ravi_run: "run-1" },
    });
    expect(created).toEqual({ sessionId: "sesn_1" });
    const [request] = requests;
    expect(request!.headers.get("anthropic-beta")).toContain(ANTHROPIC_MANAGED_AGENTS_BETA);
    expect(request!.body).toMatchObject({
      agent: { type: "agent", id: "agent_1", version: 3 },
      environment_id: "env_1",
      vault_ids: ["vlt_1"],
      budget: { type: "limit", max_list_cost: { amount: "250", currency: "USD" } },
      resources: [{ type: "github_repository", url: "https://github.com/acme/site", authorization_token: "ghs_fake", checkout: { type: "branch", name: "main" } }],
    });
  });

  test("normalizes events, skips unprocessed ones and never repeats an event across reads", async () => {
    const pages: Reply[] = [
      {
        json: {
          data: [
            event("e1", "agent.message", "2026-10-19T12:00:00Z", { content: [{ type: "text", text: "Hi" }] }),
            event("e2", "agent.mcp_tool_use", "2026-10-19T12:00:01Z", {
              name: "ravi_bases_views_rows_create",
              mcp_server_name: "ravi",
              input: { viewId: "v1" },
              evaluated_permission: "ask",
            }),
            event("e3", "session.status_idle", "2026-10-19T12:00:02Z", { stop_reason: { type: "requires_action", event_ids: ["e2"] } }),
            event("e4", "user.message", null, { content: [{ type: "text", text: "queued" }] }),
          ],
          next_page: null,
        },
      },
      {
        json: {
          data: [
            event("e3", "session.status_idle", "2026-10-19T12:00:02Z", { stop_reason: { type: "requires_action", event_ids: ["e2"] } }),
            event("e5", "session.error", "2026-10-19T12:00:05Z", { error: { type: "overloaded", message: "busy", retry_status: { type: "retrying" } } }),
          ],
          next_page: null,
        },
      },
    ];
    const { provider, requests } = scripted((request) => (request.path === "/v1/sessions/sesn_1/events" ? pages.shift() : undefined));
    const first = await provider.listEvents("sesn_1", null, 100);
    expect(first.hasMore).toBe(false);
    expect(first.events.map(({ id, at: _at, ...rest }) => ({ id, ...rest }))).toEqual([
      { id: "e1", kind: "message", role: "agent", text: "Hi" },
      { id: "e2", kind: "tool_use", tool: "ravi_bases_views_rows_create", server: "ravi", input: { viewId: "v1" }, permission: "ask" },
      { id: "e3", kind: "status", status: "idle", stopReason: { type: "requires_action", eventIds: ["e2"] } },
    ]);
    const second = await provider.listEvents("sesn_1", first.cursor, 100);
    expect(second.events.map((item) => item.id)).toEqual(["e5"]);
    expect(second.events[0]).toMatchObject({ kind: "error", retrying: true });
    // The second read starts just before the newest processed event.
    expect(requests[1]!.search.get("created_at[gte]")).toBe("2026-10-19T11:59:02.000Z");
  });

  test("reads usage and cost, and a missing session is null", async () => {
    const { provider } = scripted((request) => {
      if (request.path === "/v1/sessions/sesn_1") {
        return {
          json: {
            id: "sesn_1",
            type: "session",
            status: "idle",
            usage: {
              input_tokens: 10,
              output_tokens: 5,
              cache_read_input_tokens: 2,
              cache_creation: { ephemeral_5m_input_tokens: 1, ephemeral_1h_input_tokens: 3 },
              list_cost: { amount: "42", currency: "USD" },
            },
            stats: { active_seconds: 12.4 },
          },
        };
      }
      return undefined;
    });
    expect(await provider.getSession("sesn_1")).toEqual({
      id: "sesn_1",
      status: "idle",
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 4, listCostCents: 42, activeSeconds: 12 },
    });
    expect(await provider.getSession("sesn_gone")).toBeNull();
  });

  test("sends a denial with its message, and maps API errors without echoing the request", async () => {
    const { provider, requests } = scripted((request) => {
      if (request.path === "/v1/sessions/sesn_1/events" && request.method === "POST") return { json: { data: [] } };
      if (request.path === "/v1/models") return { status: 401, json: { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } } };
      if (request.path === "/v1/sessions/sesn_2/events") return { status: 429, json: { type: "error", error: { type: "rate_limit_error", message: "slow down" } } };
      return undefined;
    });
    await provider.confirmTool("sesn_1", "e2", { allow: false, message: "Denied by Ana." });
    expect(requests[0]!.body).toMatchObject({ events: [{ type: "user.tool_confirmation", tool_use_id: "e2", result: "deny", deny_message: "Denied by Ana." }] });

    const auth = await provider.verifyKey().catch((error: unknown) => error);
    expect(auth).toBeInstanceOf(CloudProviderError);
    expect(auth).toMatchObject({ kind: "auth", status: 401, message: "invalid x-api-key" });
    const limited = await provider.sendMessage("sesn_2", "secret prompt text").catch((error: unknown) => error);
    expect(limited).toMatchObject({ kind: "rate_limited", status: 429 });
    expect((limited as Error).message).not.toContain("secret prompt text");
  });
});
