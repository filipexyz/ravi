import { describe, expect, it } from "bun:test";
import type { ChannelConfig } from "../../router/router-db.js";
import { resolveSlackNativeChannel, sendSlackText, updateSlackText } from "./text-send.js";

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
});
