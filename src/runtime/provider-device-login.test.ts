import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import {
  cancelDeviceLogin,
  parseDeviceLoginPrompt,
  providerAuthReady,
  refreshDeviceLogin,
  startDeviceLogin,
  type DeviceLoginProcess,
} from "./provider-device-login.js";

const CODEX_PROMPT = `
Welcome to Codex [v0.1.0]
OpenAI's command-line coding agent

Follow these steps to sign in with ChatGPT using device code authorization:

1. Open this link in your browser and sign in to your account
 \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m

2. Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m
 \x1b[94mABCD-EFGH\x1b[0m
`;

const GROK_PROMPT = `Visit https://auth.x.ai/device and enter code: WXYZ-1234\n`;

function fakeProcess(prompt: string, pid = 4242): DeviceLoginProcess {
  const stdout = new EventEmitter();
  queueMicrotask(() => {
    stdout.emit("data", prompt);
  });
  return {
    pid,
    stdout: stdout as unknown as NodeJS.ReadableStream,
    stderr: new EventEmitter() as unknown as NodeJS.ReadableStream,
    unref() {},
    kill() {
      return true;
    },
  };
}

describe("provider-device-login", () => {
  beforeEach(async () => {
    await createIsolatedRaviState("ravi-provider-login-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(process.env.RAVI_STATE_DIR);
  });

  it("parses Codex and Grok device-auth prompts without treating tokens as codes", () => {
    expect(parseDeviceLoginPrompt(CODEX_PROMPT)).toEqual({
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "ABCD-EFGH",
    });
    expect(parseDeviceLoginPrompt(GROK_PROMPT)).toEqual({
      verificationUrl: "https://auth.x.ai/device",
      userCode: "WXYZ-1234",
    });
    expect(parseDeviceLoginPrompt('{"verification_uri":"https://ex/d","user_code":"AA-BB"}')).toEqual({
      verificationUrl: "https://ex/d",
      userCode: "AA-BB",
    });
    const leaked = parseDeviceLoginPrompt("https://ex/d\nsk-ant-oat01-this-is-not-a-user-code\n");
    expect(leaked.userCode).toBeUndefined();
  });

  it("starts a Codex login, returns URL+code, and cancels the pending process", async () => {
    const login = await startDeviceLogin("codex", {
      spawn: () => fakeProcess(CODEX_PROMPT),
      isPidAlive: () => true,
      sleep: async () => {},
      startTimeoutMs: 200,
    });
    expect(login.status).toBe("pending");
    expect(login.verificationUrl).toBe("https://auth.openai.com/codex/device");
    expect(login.userCode).toBe("ABCD-EFGH");
    expect(login.home).toContain("/codex");
    expect(JSON.stringify(login)).not.toContain("sk-");

    const cancelled = cancelDeviceLogin(login.id, { isPidAlive: () => false });
    expect(cancelled.status).toBe("cancelled");
  });

  it("marks a login authorized when the provider auth file appears", async () => {
    const login = await startDeviceLogin("grok", {
      spawn: () => fakeProcess(GROK_PROMPT, 99),
      isPidAlive: () => true,
      sleep: async () => {},
      startTimeoutMs: 200,
    });
    writeFileSync(join(login.home, "auth.json"), '{"ok":true}\n', { mode: 0o600 });
    expect(providerAuthReady("grok", login.home)).toBe(true);
    const refreshed = refreshDeviceLogin(login.id, { isPidAlive: () => true });
    expect(refreshed.status).toBe("authorized");
  });

  it("fails start when the helper never prints a device prompt", async () => {
    await expect(
      startDeviceLogin("codex", {
        spawn: () => fakeProcess("still starting...\n", 7),
        isPidAlive: () => true,
        sleep: async () => {},
        startTimeoutMs: 20,
      }),
    ).rejects.toMatchObject({ code: "LOGIN_PROMPT_TIMEOUT" });
  });
});
