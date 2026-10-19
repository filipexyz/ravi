import { describe, expect, it } from "bun:test";
import type { ChannelConfig } from "../../router/router-db.js";
import {
  lookupSlackUserEmail,
  resolveSlackNativeChannel,
  sendSlackPrivateCards,
  sendSlackText,
  updateSlackText,
} from "./text-send.js";

function slackChannel(overrides: Partial<ChannelConfig> = {}): ChannelConfig {
  return {
    name: "hana-slack",
    provider: "slack",
    enabled: true,
    credentialConnection: "hana-slack-credentials",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe("sendSlackText", () => {
  it("matches native Slack accounts by channel name or credential connection", () => {
    const channels = { hana: slackChannel() };

    expect(resolveSlackNativeChannel(channels, "HANA-SLACK")?.name).toBe("hana-slack");
    expect(resolveSlackNativeChannel(channels, "hana-slack-credentials")?.name).toBe("hana-slack");
    expect(resolveSlackNativeChannel(channels, "missing")).toBeUndefined();
  });

  it("posts chat.postMessage for a native Slack account", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return Response.json({ ok: true, channel: "C123", ts: "1784000000.000100" });
    }) as typeof fetch;

    const result = await sendSlackText(
      {
        accountId: "hana-slack",
        chatId: "C123",
        threadId: "1783999999.000099",
        text: "hello native",
      },
      {
        channels: { hana: slackChannel() },
        resolveSecret: async () => ({
          secret: JSON.stringify({ appToken: "xapp-test", botToken: "xoxb-test" }),
        }),
        fetchImpl,
        apiBaseUrl: "https://slack.test/api/",
      },
    );

    expect(result).toMatchObject({
      transport: "slack-native",
      provider: "slack",
      success: true,
      status: "sent",
      messageId: "1784000000.000100",
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://slack.test/api/chat.postMessage");
    const body = new URLSearchParams(String(requests[0]?.init?.body));
    expect(body.get("channel")).toBe("C123");
    expect(body.get("text")).toBe("hello native");
    expect(body.get("thread_ts")).toBe("1783999999.000099");
  });

  it("converts CommonMark agent text to mrkdwn before chat.postMessage", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return Response.json({ ok: true, channel: "C123", ts: "1784000000.000150" });
    }) as typeof fetch;

    await sendSlackText(
      {
        accountId: "hana-slack",
        chatId: "C123",
        text: "# Status\nUse **bold** and [docs](https://example.com).",
      },
      {
        channels: { hana: slackChannel() },
        resolveSecret: async () => ({
          secret: JSON.stringify({ appToken: "xapp-test", botToken: "xoxb-test" }),
        }),
        fetchImpl,
        apiBaseUrl: "https://slack.test/api/",
      },
    );

    const body = new URLSearchParams(String(requests[0]?.init?.body));
    expect(body.get("text")).toBe("*Status*\nUse *bold* and <https://example.com|docs>.");
  });

  it("posts Block Kit blocks on chat.postMessage", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return Response.json({ ok: true, channel: "C123", ts: "1784000000.000200" });
    }) as typeof fetch;

    await sendSlackText(
      {
        accountId: "hana-slack",
        chatId: "C123",
        text: "Permission requested",
        blocks: [{ type: "section", text: { type: "mrkdwn", text: "Approve?" } }],
      },
      {
        channels: { hana: slackChannel() },
        resolveSecret: async () => ({
          secret: JSON.stringify({ appToken: "xapp-test", botToken: "xoxb-test" }),
        }),
        fetchImpl,
        apiBaseUrl: "https://slack.test/api/",
      },
    );

    const body = new URLSearchParams(String(requests[0]?.init?.body));
    expect(body.get("blocks")).toContain("Approve?");
  });

  it("updates a Slack message through chat.update", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return Response.json({ ok: true, channel: "C123", ts: "1784000000.000100" });
    }) as typeof fetch;

    const result = await updateSlackText(
      {
        accountId: "hana-slack",
        chatId: "C123",
        messageId: "1784000000.000100",
        text: "Permission requested: Approved",
        blocks: [{ type: "section", text: { type: "mrkdwn", text: "*Approved*" } }],
      },
      {
        channels: { hana: slackChannel() },
        resolveSecret: async () => ({
          secret: JSON.stringify({ appToken: "xapp-test", botToken: "xoxb-test" }),
        }),
        fetchImpl,
        apiBaseUrl: "https://slack.test/api/",
      },
    );

    expect(result.status).toBe("updated");
    expect(requests[0]?.url).toBe("https://slack.test/api/chat.update");
    const body = new URLSearchParams(String(requests[0]?.init?.body));
    expect(body.get("ts")).toBe("1784000000.000100");
    expect(body.get("text")).toContain("Approved");
  });

  it("converts CommonMark on chat.update text without rewriting Block Kit blocks", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return Response.json({ ok: true, channel: "C123", ts: "1784000000.000100" });
    }) as typeof fetch;

    await updateSlackText(
      {
        accountId: "hana-slack",
        chatId: "C123",
        messageId: "1784000000.000100",
        text: "Result: **approved**",
        blocks: [{ type: "section", text: { type: "mrkdwn", text: "*Approved*" } }],
      },
      {
        channels: { hana: slackChannel() },
        resolveSecret: async () => ({
          secret: JSON.stringify({ appToken: "xapp-test", botToken: "xoxb-test" }),
        }),
        fetchImpl,
        apiBaseUrl: "https://slack.test/api/",
      },
    );

    const body = new URLSearchParams(String(requests[0]?.init?.body));
    expect(body.get("text")).toBe("Result: *approved*");
    expect(body.get("blocks")).toContain("*Approved*");
  });

  it("surfaces Slack API errors without falling back to Omni", async () => {
    await expect(
      sendSlackText(
        {
          accountId: "hana-slack",
          chatId: "C123",
          text: "hello",
        },
        {
          channels: { hana: slackChannel() },
          resolveSecret: async () => ({
            secret: JSON.stringify({ appToken: "xapp-test", botToken: "xoxb-test" }),
          }),
          fetchImpl: (async () => Response.json({ ok: false, error: "missing_scope" })) as unknown as typeof fetch,
        },
      ),
    ).rejects.toThrow("Slack chat.postMessage failed: missing_scope");
  });

  it("turns off link and media unfurls when asked", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return Response.json({ ok: true, channel: "D123", ts: "1784000000.000300" });
    }) as typeof fetch;

    const result = await sendSlackText(
      { accountId: "hana-slack", chatId: "U123", text: "open https://console.example/link/x", unfurlLinks: false },
      {
        channels: { hana: slackChannel() },
        resolveSecret: async () => ({
          secret: JSON.stringify({ appToken: "xapp-test", botToken: "xoxb-test" }),
        }),
        fetchImpl,
        apiBaseUrl: "https://slack.test/api/",
      },
    );

    const body = new URLSearchParams(String(requests[0]?.init?.body));
    expect(body.get("channel")).toBe("U123");
    expect(body.get("unfurl_links")).toBe("false");
    expect(body.get("unfurl_media")).toBe("false");
    expect(result.raw.channel).toBe("D123");
  });
});

describe("lookupSlackUserEmail", () => {
  const deps = (user: unknown) => ({
    channels: { hana: slackChannel() },
    resolveSecret: async () => ({
      secret: JSON.stringify({ appToken: "xapp-test", botToken: "xoxb-test" }),
    }),
    fetchImpl: (async () => Response.json({ ok: true, user })) as unknown as typeof fetch,
    apiBaseUrl: "https://slack.test/api/",
  });

  it("returns the profile email of a person", async () => {
    await expect(
      lookupSlackUserEmail(
        { accountId: "hana-slack", userId: "U123" },
        deps({ id: "U123", profile: { email: " ana@example.com " } }),
      ),
    ).resolves.toBe("ana@example.com");
  });

  it("returns null for bots and hidden emails", async () => {
    await expect(
      lookupSlackUserEmail(
        { accountId: "hana-slack", userId: "U123" },
        deps({ id: "U123", is_bot: true, profile: { email: "bot@example.com" } }),
      ),
    ).resolves.toBeNull();
    await expect(
      lookupSlackUserEmail({ accountId: "hana-slack", userId: "U123" }, deps({ id: "U123", profile: {} })),
    ).resolves.toBeNull();
  });
});

describe("sendSlackPrivateCards", () => {
  const dependencies = (fetchImpl: typeof fetch) => ({
    channels: { hana: slackChannel() },
    resolveSecret: async () => ({
      secret: JSON.stringify({ appToken: "xapp-test", botToken: "xoxb-test" }),
    }),
    fetchImpl,
    apiBaseUrl: "https://slack.test/api/",
  });

  it("sends an ephemeral card in the thread to each person, and a DM to whoever is not in the chat", async () => {
    const requests: Array<{ method: string; body: URLSearchParams }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const method = String(url).split("/").pop() ?? "";
      const body = new URLSearchParams(String(init?.body));
      requests.push({ method, body });
      if (method === "chat.postEphemeral" && body.get("user") === "UOUT") {
        return Response.json({ ok: false, error: "user_not_in_channel" });
      }
      if (method === "chat.postEphemeral") {
        return Response.json({ ok: true, message_ts: "1784000000.000200" });
      }
      return Response.json({ ok: true, channel: "D777", ts: "1784000000.000300" });
    }) as typeof fetch;

    const result = await sendSlackPrivateCards(
      {
        accountId: "hana-slack",
        chatId: "C123",
        threadId: "1783999999.000099",
        userIds: ["UIN", "UOUT"],
        text: "Permission requested",
        blocks: [{ type: "section", text: { type: "mrkdwn", text: "x" } }],
      },
      dependencies(fetchImpl),
    );

    expect(result.failures).toEqual([]);
    expect(result.deliveries).toEqual([
      { userId: "UIN", kind: "ephemeral", chatId: "C123", messageId: "1784000000.000200" },
      { userId: "UOUT", kind: "dm", chatId: "D777", messageId: "1784000000.000300" },
    ]);
    expect(requests.map((request) => request.method)).toEqual([
      "chat.postEphemeral",
      "chat.postEphemeral",
      "chat.postMessage",
    ]);
    expect(requests[0]?.body.get("channel")).toBe("C123");
    expect(requests[0]?.body.get("thread_ts")).toBe("1783999999.000099");
    expect(requests[0]?.body.get("blocks")).toContain("section");
    // The DM goes to the person, never to the shared chat.
    expect(requests[2]?.body.get("channel")).toBe("UOUT");
  });

  it("reports a person as failed only when neither the ephemeral card nor the DM went through", async () => {
    const requests: Array<{ method: string; channel: string | null }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const method = String(url).split("/").pop() ?? "";
      requests.push({ method, channel: new URLSearchParams(String(init?.body)).get("channel") });
      return Response.json({ ok: false, error: "invalid_blocks" });
    }) as typeof fetch;

    const result = await sendSlackPrivateCards(
      {
        accountId: "hana-slack",
        chatId: "C123",
        userIds: ["UIN"],
        text: "Permission requested",
        blocks: [],
      },
      dependencies(fetchImpl),
    );

    expect(result.deliveries).toEqual([]);
    expect(result.failures).toHaveLength(1);
    // Never a public post in the shared chat: the fallback is the person's DM.
    expect(requests).toEqual([
      { method: "chat.postEphemeral", channel: "C123" },
      { method: "chat.postMessage", channel: "UIN" },
    ]);
  });
});
