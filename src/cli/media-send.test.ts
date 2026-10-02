import { afterEach, describe, expect, it, mock } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

mock.module("../config-store.js", () => ({
  configStore: {
    resolveInstanceId: (accountId: string) => (accountId === "hana-slack" ? undefined : accountId),
    // Routing config is injected per test through `getRoutingConfig`.
    getConfig: () => ({ instances: {}, channels: {}, instanceToAccount: {} }),
  },
}));

import { runWithContext } from "./context.js";
import { MediaSendAuthError } from "./media-send-auth.js";
import { CHANNEL_TRANSPORT_ERROR_CODES, ChannelTransportError } from "../channels/outbound/errors.js";
import type { SenderRoutingConfig } from "../channels/outbound/router.js";
import { createWhatsAppClient } from "../channels/whatsapp/client.js";
import {
  WHATSAPP_RPC_ERROR_CODES,
  WhatsAppRpcRequestSchema,
  type WhatsAppRpcRequest,
} from "../channels/whatsapp/contract.js";
import type { ChannelConfig, InstanceConfig } from "../router/router-db.js";

const { mapChannelMediaFailure, sendChannelMedia, resolveMediaSendTarget } = await import("./media-send.js");
const { WhatsAppRpcError } = await import("../channels/whatsapp/errors.js");

const BRIDGE_ID = "bdd3db21-63ef-41b1-a48c-2fdf86df238c";

/** A Telegram instance: media goes through the legacy bridge (`omni send`). */
function bridgeConfig(): SenderRoutingConfig {
  const instance = { name: "tg", instanceId: BRIDGE_ID, channel: "telegram" } as InstanceConfig;
  return { instances: { tg: instance }, channels: {}, instanceToAccount: { [BRIDGE_ID]: "tg" } };
}

const bridgeRouting = { getRoutingConfig: bridgeConfig };

const ORIGINAL_OMNI_API_URL = process.env.OMNI_API_URL;
const ORIGINAL_OMNI_API_KEY = process.env.OMNI_API_KEY;

function restoreOmniEnv(): void {
  if (ORIGINAL_OMNI_API_URL === undefined) delete process.env.OMNI_API_URL;
  else process.env.OMNI_API_URL = ORIGINAL_OMNI_API_URL;
  if (ORIGINAL_OMNI_API_KEY === undefined) delete process.env.OMNI_API_KEY;
  else process.env.OMNI_API_KEY = ORIGINAL_OMNI_API_KEY;
}

const ORIGINAL_PATH = process.env.PATH ?? "";
const tempDirs: string[] = [];

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  restoreOmniEnv();
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

describe("sendChannelMedia on a legacy bridge (Telegram) instance", () => {
  it("spawns omni send and preserves thread-aware arguments", async () => {
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

    const result = await sendChannelMedia(
      {
        filePath: mediaPath,
        voiceNote: true,
        target: {
          channel: "telegram",
          accountId: BRIDGE_ID,
          chatId: "group:120363425628305127",
          threadId: "thread-1",
        },
      },
      bridgeRouting,
    );

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
      channel: "telegram",
      accountId: BRIDGE_ID,
      instanceId: BRIDGE_ID,
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

  it("injects the runtime Omni credentials so the CLI cannot prefer a stale servers.list key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ravi-media-send-"));
    tempDirs.push(dir);

    const envFile = join(dir, "env.txt");
    const configFile = join(dir, "captured-config.json");
    const omniPath = join(dir, "omni");
    writeFileSync(
      omniPath,
      `#!/bin/sh
printf 'OMNI_API_URL=%s\\nOMNI_API_KEY=%s\\nOMNI_CONFIG_DIR=%s\\n' \\
  "$OMNI_API_URL" "$OMNI_API_KEY" "$OMNI_CONFIG_DIR" > "${envFile}"
if [ -n "$OMNI_CONFIG_DIR" ] && [ -f "$OMNI_CONFIG_DIR/config.json" ]; then
  cp "$OMNI_CONFIG_DIR/config.json" "${configFile}"
fi
printf '{"success":true,"message":"Media sent","data":{"messageId":"msg-auth","status":"sent"}}\\n'
`,
    );
    chmodSync(omniPath, 0o755);

    const mediaPath = join(dir, "sample.png");
    writeFileSync(mediaPath, "image");

    process.env.PATH = `${dir}:${ORIGINAL_PATH}`;
    process.env.OMNI_API_URL = "http://omni.runtime.test:8882";
    process.env.OMNI_API_KEY = "runtime-primary-key";

    await sendChannelMedia(
      { filePath: mediaPath, target: { channel: "telegram", accountId: BRIDGE_ID, chatId: "5511999999999" } },
      bridgeRouting,
    );

    const env = readFileSync(envFile, "utf-8");
    expect(env).toContain("OMNI_API_URL=http://omni.runtime.test:8882");
    expect(env).toContain("OMNI_API_KEY=runtime-primary-key");
    expect(env).toMatch(/OMNI_CONFIG_DIR=\/.+/);

    const captured = JSON.parse(readFileSync(configFile, "utf-8")) as {
      apiKey: string;
      apiUrl: string;
      servers: { active: string; list: { default: { apiKey: string; url: string } } };
    };
    expect(captured.apiUrl).toBe("http://omni.runtime.test:8882");
    expect(captured.apiKey).toBe("runtime-primary-key");
    expect(captured.servers.active).toBe("default");
    expect(captured.servers.list.default).toEqual({
      url: "http://omni.runtime.test:8882",
      apiKey: "runtime-primary-key",
    });
  });

  it("throws MediaSendAuthError when Omni reports Invalid API key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ravi-media-send-"));
    tempDirs.push(dir);

    const omniPath = join(dir, "omni");
    writeFileSync(
      omniPath,
      `#!/bin/sh
printf '{"success":false,"error":"Invalid API key"}\\n' >&2
exit 1
`,
    );
    chmodSync(omniPath, 0o755);

    const mediaPath = join(dir, "sample.png");
    writeFileSync(mediaPath, "image");

    process.env.PATH = `${dir}:${ORIGINAL_PATH}`;
    process.env.OMNI_API_URL = "http://omni.runtime.test:8882";
    process.env.OMNI_API_KEY = "runtime-primary-key";

    await expect(
      sendChannelMedia(
        { filePath: mediaPath, target: { channel: "telegram", accountId: BRIDGE_ID, chatId: "5511999999999" } },
        bridgeRouting,
      ),
    ).rejects.toBeInstanceOf(MediaSendAuthError);
  });

  it("uses native Slack delivery when the source channel is Slack", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ravi-media-send-"));
    tempDirs.push(dir);
    const mediaPath = join(dir, "sample.png");
    writeFileSync(mediaPath, "image");
    const slackCalls: unknown[] = [];

    const result = await sendChannelMedia(
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

describe("sendChannelMedia on a WhatsApp instance", () => {
  const WA_ID = "5f0c6a8e-4d5b-4c1e-9b7a-2a6f1d3c8e90";

  function whatsappConfig(options: { bound: boolean }): SenderRoutingConfig {
    const instance = { name: "wa", instanceId: WA_ID, channel: "whatsapp" } as InstanceConfig;
    const channel = { name: "wa", provider: "whatsapp", enabled: true } as ChannelConfig;
    return {
      instances: { wa: instance },
      channels: options.bound ? { wa: channel } : {},
      instanceToAccount: { [WA_ID]: "wa" },
    };
  }

  function fakeRunner() {
    const requests: Array<{ subject: string; request: WhatsAppRpcRequest; timeout: number }> = [];
    const connection = {
      async request(subject: string, data: Uint8Array, options: { timeout: number }) {
        const request = WhatsAppRpcRequestSchema.parse(JSON.parse(new TextDecoder().decode(data)));
        requests.push({ subject, request, timeout: options.timeout });
        const response = { ok: true, requestId: request.requestId, data: { messageId: "BAE5WA", status: "sent" } };
        return { data: new TextEncoder().encode(JSON.stringify(response)) };
      },
    };
    return { connection, requests };
  }

  /** Media file plus an `omni` binary on PATH that fails loudly if it is ever spawned. */
  function mediaWithTrippedOmni(name: string): string {
    const dir = mkdtempSync(join(tmpdir(), "ravi-media-send-"));
    tempDirs.push(dir);
    const marker = join(dir, "omni-ran");
    const omniPath = join(dir, "omni");
    writeFileSync(omniPath, `#!/bin/sh\ntouch "${marker}"\necho 'omni must not run' >&2\nexit 9\n`);
    chmodSync(omniPath, 0o755);
    process.env.PATH = `${dir}:${ORIGINAL_PATH}`;
    const mediaPath = join(dir, name);
    writeFileSync(mediaPath, "bytes");
    return mediaPath;
  }

  function omniRan(mediaPath: string): boolean {
    return existsSync(join(dirname(mediaPath), "omni-ran"));
  }

  it("sends through the channel runner by absolute file path, without spawning omni", async () => {
    const mediaPath = mediaWithTrippedOmni("voice.ogg");
    const runner = fakeRunner();
    const getConfig = () => whatsappConfig({ bound: true });

    const result = await sendChannelMedia(
      {
        filePath: mediaPath,
        caption: "ouça",
        voiceNote: true,
        target: { channel: "whatsapp", accountId: WA_ID, chatId: "group:120363425628305127" },
      },
      {
        getRoutingConfig: getConfig,
        whatsappClient: createWhatsAppClient({ getConfig, connection: runner.connection }),
      },
    );

    expect(runner.requests).toHaveLength(1);
    expect(runner.requests[0]?.subject).toBe(`_RAVI.channels.whatsapp.rpc.${WA_ID}`);
    expect(runner.requests[0]?.request.method).toBe("messages.sendMedia");
    expect(runner.requests[0]?.request.params).toEqual({
      to: "120363425628305127@g.us",
      type: "audio",
      filePath: mediaPath,
      filename: "voice.ogg",
      mimeType: "audio/ogg",
      caption: "ouça",
      voiceNote: true,
    });
    expect(result.delivery).toMatchObject({
      transport: "whatsapp",
      success: true,
      messageId: "BAE5WA",
      status: "sent",
    });
    expect(result.target.instanceId).toBe(WA_ID);
    expect(omniRan(mediaPath)).toBe(false);
  });

  it("does not fall back to omni for an unbound WhatsApp instance (WHATSAPP_NOT_BOUND, no RPC)", async () => {
    const mediaPath = mediaWithTrippedOmni("photo.png");
    const runner = fakeRunner();
    const getConfig = () => whatsappConfig({ bound: false });
    let bridgeLoaded = false;

    const error = await sendChannelMedia(
      { filePath: mediaPath, target: { channel: "whatsapp-baileys", accountId: WA_ID, chatId: "5511999999999" } },
      {
        getRoutingConfig: getConfig,
        whatsappClient: createWhatsAppClient({ getConfig, connection: runner.connection }),
        loadLegacyBridge: async () => {
          bridgeLoaded = true;
          throw new Error("legacy bridge must not load");
        },
      },
    ).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ChannelTransportError);
    expect((error as ChannelTransportError).code).toBe(WHATSAPP_RPC_ERROR_CODES.notBound);
    expect(runner.requests).toHaveLength(0);
    expect(bridgeLoaded).toBe(false);
    expect(omniRan(mediaPath)).toBe(false);
  });

  it("refuses an unsupported WhatsApp-family provider with 422", async () => {
    const mediaPath = mediaWithTrippedOmni("photo.png");
    const instance = { name: "cloud", instanceId: WA_ID, channel: "whatsapp-cloud" } as InstanceConfig;

    const error = await sendChannelMedia(
      { filePath: mediaPath, target: { accountId: WA_ID, chatId: "5511999999999" } },
      {
        getRoutingConfig: () => ({
          instances: { cloud: instance },
          channels: {},
          instanceToAccount: { [WA_ID]: "cloud" },
        }),
      },
    ).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ChannelTransportError);
    expect(error).toMatchObject({ status: 422, code: CHANNEL_TRANSPORT_ERROR_CODES.providerUnsupported });
    expect(omniRan(mediaPath)).toBe(false);
  });

  it("refuses an instance the router does not know with 404", async () => {
    const mediaPath = mediaWithTrippedOmni("photo.png");

    const error = await sendChannelMedia(
      { filePath: mediaPath, target: { accountId: "ghost", chatId: "5511999999999" } },
      { getRoutingConfig: () => ({ instances: {}, channels: {}, instanceToAccount: {} }) },
    ).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ChannelTransportError);
    expect(error).toMatchObject({ status: 404, code: CHANNEL_TRANSPORT_ERROR_CODES.instanceNotFound });
    expect(omniRan(mediaPath)).toBe(false);
  });
});

describe("mapChannelMediaFailure", () => {
  it("keeps a runner error's code and retryability and points at ravi channels start", () => {
    const mapped = mapChannelMediaFailure(
      new WhatsAppRpcError("runner down", {
        status: 503,
        code: WHATSAPP_RPC_ERROR_CODES.runnerUnavailable,
        retryable: true,
      }),
    );
    expect(mapped).toMatchObject({ code: WHATSAPP_RPC_ERROR_CODES.runnerUnavailable, retryable: true });
    expect(mapped?.suggestedAction).toContain("ravi channels start");
  });

  it("maps a routing error and ignores anything that is not a ChannelTransportError", () => {
    const routing = new ChannelTransportError("missing", {
      status: 404,
      code: CHANNEL_TRANSPORT_ERROR_CODES.instanceNotFound,
      retryable: false,
    });
    expect(mapChannelMediaFailure(routing)).toMatchObject({
      code: CHANNEL_TRANSPORT_ERROR_CODES.instanceNotFound,
      retryable: false,
    });
    expect(mapChannelMediaFailure(new Error("boom"))).toBeNull();
  });
});
