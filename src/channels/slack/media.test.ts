import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChannelConfig } from "../../router/router-db.js";
import { resolveSlackMediaChannel, sendSlackMedia } from "./media.js";

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

describe("resolveSlackMediaChannel", () => {
  it("matches native Slack accounts by channel name or credential connection", () => {
    const channels = {
      hana: slackChannel(),
    };

    expect(resolveSlackMediaChannel(channels, "HANA-SLACK")?.name).toBe("hana-slack");
    expect(resolveSlackMediaChannel(channels, "hana-slack-credentials")?.name).toBe("hana-slack");
    expect(resolveSlackMediaChannel(channels, "missing")).toBeUndefined();
  });
});

describe("sendSlackMedia", () => {
  it("uploads bytes and completes a channel-thread share with a caption", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ravi-slack-media-"));
    const filePath = join(dir, "sample.png");
    writeFileSync(filePath, Buffer.from("png-bytes"));
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      if (String(url).endsWith("/files.getUploadURLExternal")) {
        return Response.json({
          ok: true,
          upload_url: "https://files.slack.test/upload/v1/ticket",
          file_id: "F123",
        });
      }
      if (String(url) === "https://files.slack.test/upload/v1/ticket") {
        return new Response("OK - 9", { status: 200 });
      }
      if (String(url).endsWith("/files.completeUploadExternal")) {
        return Response.json({
          ok: true,
          files: [
            {
              id: "F123",
              shares: {
                public: {
                  C123: [{ ts: "1784000000.000100" }],
                },
              },
            },
          ],
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    try {
      const result = await sendSlackMedia(
        {
          accountId: "hana-slack",
          chatId: "C123",
          threadId: "1783999999.000099",
          filePath,
          filename: "sample.png",
          caption: "caption",
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
        fileId: "F123",
        messageId: "1784000000.000100",
      });
      expect(requests.map((request) => request.url)).toEqual([
        "https://slack.test/api/files.getUploadURLExternal",
        "https://files.slack.test/upload/v1/ticket",
        "https://slack.test/api/files.completeUploadExternal",
      ]);

      const uploadUrlBody = new URLSearchParams(String(requests[0]?.init?.body));
      expect(uploadUrlBody.get("filename")).toBe("sample.png");
      expect(uploadUrlBody.get("length")).toBe("9");
      expect(requests[1]?.init?.body).toEqual(Buffer.from("png-bytes"));

      const completionBody = new URLSearchParams(String(requests[2]?.init?.body));
      expect(JSON.parse(completionBody.get("files") ?? "[]")).toEqual([{ id: "F123", title: "sample.png" }]);
      expect(completionBody.get("channel_id")).toBe("C123");
      expect(completionBody.get("thread_ts")).toBe("1783999999.000099");
      expect(completionBody.get("initial_comment")).toBe("caption");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("surfaces Slack API errors without falling back to Omni", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ravi-slack-media-"));
    const filePath = join(dir, "sample.pdf");
    writeFileSync(filePath, "pdf");

    try {
      await expect(
        sendSlackMedia(
          {
            accountId: "hana-slack",
            chatId: "C123",
            filePath,
            filename: "sample.pdf",
          },
          {
            channels: { hana: slackChannel() },
            resolveSecret: async () => ({
              secret: JSON.stringify({ appToken: "xapp-test", botToken: "xoxb-test" }),
            }),
            fetchImpl: (async () => Response.json({ ok: false, error: "missing_scope" })) as unknown as typeof fetch,
          },
        ),
      ).rejects.toThrow("Slack files.getUploadURLExternal failed: missing_scope");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
