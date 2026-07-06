import { describe, expect, it, mock } from "bun:test";
import { SlackWebApiClient } from "./client.js";

describe("Slack Web API client", () => {
  it("reads token scopes from auth.test response headers", async () => {
    const fetchImpl = mock(async () =>
      jsonResponse(
        {
          ok: true,
          team: "RBBT",
          user: "Ravi",
          team_id: "T123",
          user_id: "U123",
          bot_id: "B123",
        },
        {
          "x-oauth-scopes": "channels:read,channels:manage,chat:write",
          "x-accepted-oauth-scopes": "identity.basic",
        },
      ),
    ) as unknown as typeof fetch;
    const client = new SlackWebApiClient({
      appToken: "xapp-secret",
      botToken: "xoxb-secret",
      fetchImpl,
    });

    await expect(client.authTest()).resolves.toMatchObject({
      team: "RBBT",
      scopes: ["channels:read", "channels:manage", "chat:write"],
      acceptedScopes: ["identity.basic"],
    });
  });

  it("lists conversations with cursor pagination", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = mock(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return jsonResponse({
        ok: true,
        channels: [{ id: "C123", name: "ravi" }],
        response_metadata: { next_cursor: "next-1" },
      });
    }) as unknown as typeof fetch;
    const client = new SlackWebApiClient({
      appToken: "xapp-secret",
      botToken: "xoxb-secret",
      fetchImpl,
    });

    const result = await client.conversationsList({ types: "public_channel", limit: 10, cursor: "cursor-1" });

    expect(result.channels).toEqual([{ id: "C123", name: "ravi" }]);
    expect(result.response_metadata?.next_cursor).toBe("next-1");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://slack.com/api/conversations.list");
    expect(calls[0]?.init.headers).toMatchObject({
      authorization: "Bearer xoxb-secret",
      "content-type": "application/x-www-form-urlencoded",
    });
    expect(formBody(calls[0]?.init.body)).toEqual({
      types: "public_channel",
      limit: "10",
      cursor: "cursor-1",
    });
  });

  it("creates, renames and invites to conversations through explicit methods", async () => {
    const methods: string[] = [];
    const requests: Array<{ method: string; body: Record<string, unknown> }> = [];
    const fetchImpl = mock(async (url: string | URL | Request, init?: RequestInit) => {
      const method = String(url).split("/").pop() ?? "";
      methods.push(method);
      const body = formBody(init?.body);
      requests.push({ method, body });
      if (method === "conversations.create") {
        return jsonResponse({ ok: true, channel: { id: "C999", name: body.name } });
      }
      if (method === "conversations.rename") {
        return jsonResponse({ ok: true, channel: { id: body.channel, name: body.name } });
      }
      if (method === "conversations.invite") {
        return jsonResponse({ ok: true, channel: { id: body.channel, members: String(body.users).split(",") } });
      }
      return jsonResponse({ ok: false, error: "unexpected_method" });
    }) as unknown as typeof fetch;
    const client = new SlackWebApiClient({
      appToken: "xapp-secret",
      botToken: "xoxb-secret",
      fetchImpl,
    });

    await expect(client.conversationsCreate({ name: "ravi-test", isPrivate: true })).resolves.toMatchObject({
      channel: { id: "C999", name: "ravi-test" },
    });
    await expect(client.conversationsRename({ channel: "C999", name: "ravi-renamed" })).resolves.toMatchObject({
      channel: { id: "C999", name: "ravi-renamed" },
    });
    await expect(client.conversationsInvite({ channel: "C999", userIds: ["U1", "U2"] })).resolves.toMatchObject({
      channel: { id: "C999", members: ["U1", "U2"] },
    });
    expect(methods).toEqual(["conversations.create", "conversations.rename", "conversations.invite"]);
    expect(requests[2]?.body).toEqual({ channel: "C999", users: "U1,U2" });
  });

  it("sets native assistant thread status through Slack Web API", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = mock(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return jsonResponse({ ok: true });
    }) as unknown as typeof fetch;
    const client = new SlackWebApiClient({
      appToken: "xapp-secret",
      botToken: "xoxb-secret",
      fetchImpl,
    });

    await expect(
      client.setAssistantThreadStatus({
        channelId: "C123",
        threadTs: "1783267470.885739",
        status: "is working...",
        loadingMessages: ["checking tools"],
      }),
    ).resolves.toMatchObject({ ok: true });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://slack.com/api/assistant.threads.setStatus");
    expect(calls[0]?.init.headers).toMatchObject({
      authorization: "Bearer xoxb-secret",
      "content-type": "application/x-www-form-urlencoded",
    });
    expect(formBody(calls[0]?.init.body)).toEqual({
      channel_id: "C123",
      thread_ts: "1783267470.885739",
      status: "is working...",
      loading_messages: JSON.stringify(["checking tools"]),
    });
  });

  it("sends an empty assistant thread status to clear native Slack presence", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = mock(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return jsonResponse({ ok: true });
    }) as unknown as typeof fetch;
    const client = new SlackWebApiClient({
      appToken: "xapp-secret",
      botToken: "xoxb-secret",
      fetchImpl,
    });

    await expect(
      client.setAssistantThreadStatus({
        channelId: "C123",
        threadTs: "1783267470.885739",
        status: "",
      }),
    ).resolves.toMatchObject({ ok: true });

    expect(formBody(calls[0]?.init.body)).toEqual({
      channel_id: "C123",
      thread_ts: "1783267470.885739",
      status: "",
    });
  });

  it("calls Slack Canvas methods with JSON payloads", async () => {
    const calls: Array<{ method: string; init: RequestInit }> = [];
    const fetchImpl = mock(async (url: string | URL | Request, init?: RequestInit) => {
      const method = String(url).split("/").pop() ?? "";
      calls.push({ method, init: init ?? {} });
      if (method === "canvases.sections.lookup") {
        return jsonResponse({ ok: true, sections: [{ id: "temp:C:1" }] });
      }
      if (method === "canvases.create" || method === "conversations.canvases.create") {
        return jsonResponse({ ok: true, canvas_id: "F123" });
      }
      return jsonResponse({ ok: true });
    }) as unknown as typeof fetch;
    const client = new SlackWebApiClient({
      appToken: "xapp-secret",
      botToken: "xoxb-secret",
      fetchImpl,
    });

    await expect(client.canvasesCreate({ title: "Ravi", markdown: "# Ravi", channelId: "C123" })).resolves.toEqual({
      ok: true,
      canvas_id: "F123",
    });
    await expect(
      client.conversationsCanvasesCreate({ channelId: "C123", title: "Hub", markdown: "## Status" }),
    ).resolves.toEqual({
      ok: true,
      canvas_id: "F123",
    });
    await expect(
      client.canvasesEdit({
        canvasId: "F123",
        changes: [
          { operation: "replace", sectionId: "temp:C:1", markdown: "- [x] done" },
          { operation: "rename", title: "New title" },
        ],
      }),
    ).resolves.toEqual({ ok: true });
    await expect(
      client.canvasesSectionsLookup({
        canvasId: "F123",
        sectionTypes: ["h1", "h2"],
        containsText: "Status",
      }),
    ).resolves.toEqual({ ok: true, sections: [{ id: "temp:C:1" }] });
    await expect(
      client.canvasesAccessSet({ canvasId: "F123", accessLevel: "write", channelIds: ["C123"] }),
    ).resolves.toEqual({ ok: true });
    await expect(client.canvasesAccessDelete({ canvasId: "F123", userIds: ["U123"] })).resolves.toEqual({
      ok: true,
    });
    await expect(client.canvasesDelete({ canvasId: "F123" })).resolves.toEqual({ ok: true });

    expect(calls.map((call) => call.method)).toEqual([
      "canvases.create",
      "conversations.canvases.create",
      "canvases.edit",
      "canvases.sections.lookup",
      "canvases.access.set",
      "canvases.access.delete",
      "canvases.delete",
    ]);
    for (const call of calls) {
      expect(call.init.headers).toMatchObject({
        authorization: "Bearer xoxb-secret",
        "content-type": "application/json; charset=utf-8",
      });
    }
    expect(jsonBody(calls[0]?.init.body)).toEqual({
      title: "Ravi",
      document_content: { type: "markdown", markdown: "# Ravi" },
      channel_id: "C123",
    });
    expect(jsonBody(calls[2]?.init.body)).toEqual({
      canvas_id: "F123",
      changes: [
        {
          operation: "replace",
          section_id: "temp:C:1",
          document_content: { type: "markdown", markdown: "- [x] done" },
        },
        {
          operation: "rename",
          title_content: { type: "markdown", markdown: "New title" },
        },
      ],
    });
    expect(jsonBody(calls[3]?.init.body)).toEqual({
      canvas_id: "F123",
      criteria: {
        section_types: ["h1", "h2"],
        contains_text: "Status",
      },
    });
    expect(jsonBody(calls[4]?.init.body)).toEqual({
      canvas_id: "F123",
      access_level: "write",
      channel_ids: ["C123"],
    });
    expect(jsonBody(calls[5]?.init.body)).toEqual({
      canvas_id: "F123",
      user_ids: ["U123"],
    });
  });
});

function jsonResponse(payload: Record<string, unknown>, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

function formBody(value: RequestInit["body"] | null | undefined): Record<string, string> {
  const params = new URLSearchParams(String(value ?? ""));
  return Object.fromEntries(params.entries());
}

function jsonBody(value: RequestInit["body"] | null | undefined): unknown {
  return JSON.parse(String(value ?? "{}"));
}
