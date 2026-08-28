import { afterEach, describe, expect, it, mock } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

mock.module("../config-store.js", () => ({
  configStore: {
    resolveInstanceId: (accountId: string) => (accountId === "hana-slack" ? undefined : accountId),
  },
}));

import { runWithContext } from "./context.js";

const { sendMediaWithOmniCli, resolveMediaSendTarget } = await import("./media-send.js");

const ORIGINAL_PATH = process.env.PATH ?? "";
const tempDirs: string[] = [];

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveMediaSendTarget", () => {
  it("resolves account and chat from tool context source without --account/--to", () => {
    const target = runWithContext(
      {
        source: {
          channel: "whatsapp-baileys",
          accountId: "acct-media",
          chatId: "group:120363425628305127",
          threadId: "thread-1",
        },
      },
      () => resolveMediaSendTarget(),
    );

    expect(target).toEqual({
      channel: "whatsapp-baileys",
      accountId: "acct-media",
      instanceId: "acct-media",
      chatId: "120363425628305127@g.us",
      threadId: "thread-1",
    });
  });
});

describe("sendMediaWithOmniCli", () => {
  it("uses omni send directly and preserves thread-aware arguments", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ravi-media-send-"));
    tempDirs.push(dir);

    const argsFile = join(dir, "args.txt");
    const omniPath = join(dir, "omni");
    writeFileSync(
      omniPath,
      `#!/bin/sh
printf '%s\n' "$@" > "${argsFile}"
printf '{"success":true,"message":"Media sent","data":{"messageId":"msg-test","status":"sent"}}\n'
`,
    );
    chmodSync(omniPath, 0o755);

    const mediaPath = join(dir, "sample.ogg");
    writeFileSync(mediaPath, "audio");

    process.env.PATH = `${dir}:${ORIGINAL_PATH}`;

    const result = await sendMediaWithOmniCli({
      filePath: mediaPath,
      voiceNote: true,
      target: {
        channel: "whatsapp-baileys",
        accountId: "bdd3db21-63ef-41b1-a48c-2fdf86df238c",
        chatId: "group:120363425628305127",
        threadId: "thread-1",
      },
    });

    const args = readFileSync(argsFile, "utf-8").trim().split("\n");
    expect(args).toEqual([
      "send",
      "--instance",
      "bdd3db21-63ef-41b1-a48c-2fdf86df238c",
      "--to",
      "120363425628305127@g.us",
      "--media",
      mediaPath,
      "--voice",
      "--thread-id",
      "thread-1",
    ]);
    expect(result.target).toEqual({
      channel: "whatsapp-baileys",
      accountId: "bdd3db21-63ef-41b1-a48c-2fdf86df238c",
      instanceId: "bdd3db21-63ef-41b1-a48c-2fdf86df238c",
      chatId: "120363425628305127@g.us",
      threadId: "thread-1",
    });
    expect(result.delivery).toMatchObject({
      transport: "omni-send",
      message: "Media sent",
      messageId: "msg-test",
      status: "sent",
    });
  });

  it("uses native Slack delivery when the source channel is Slack", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ravi-media-send-"));
    tempDirs.push(dir);
    const mediaPath = join(dir, "sample.png");
    writeFileSync(mediaPath, "image");
    const slackCalls: unknown[] = [];

    const result = await sendMediaWithOmniCli(
      {
        filePath: mediaPath,
        caption: "native upload",
        target: {
          channel: "slack",
          accountId: "hana-slack",
          chatId: "C123",
          threadId: "1783999999.000099",
        },
      },
      {
        sendSlackMedia: async (input) => {
          slackCalls.push(input);
          return {
            transport: "slack-native",
            provider: "slack",
            success: true,
            status: "sent",
            fileId: "F123",
            messageId: "1784000000.000100",
            raw: { ok: true },
          };
        },
      },
    );

    expect(slackCalls).toEqual([
      {
        accountId: "hana-slack",
        chatId: "C123",
        filePath: mediaPath,
        filename: "sample.png",
        caption: "native upload",
        threadId: "1783999999.000099",
      },
    ]);
    expect(result.target).toEqual({
      channel: "slack",
      accountId: "hana-slack",
      instanceId: "hana-slack",
      chatId: "C123",
      threadId: "1783999999.000099",
    });
    expect(result.delivery).toMatchObject({
      transport: "slack-native",
      provider: "slack",
      fileId: "F123",
      messageId: "1784000000.000100",
    });
  });
});
