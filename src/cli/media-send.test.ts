import { afterEach, describe, expect, it, mock } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

mock.module("../config-store.js", () => ({
  configStore: {
    resolveInstanceId: (accountId: string) => accountId,
  },
}));

const { sendMediaWithOmniCli } = await import("./media-send.js");

const ORIGINAL_PATH = process.env.PATH ?? "";
const tempDirs: string[] = [];

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
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
});
