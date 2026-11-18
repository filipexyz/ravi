import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  AGENT_ENV_PASSTHROUGH_VAR,
  filterAgentRuntimeBaseEnv,
  isAgentRuntimeEnvNameAllowed,
  resolveProviderLoginEnvKeys,
} from "./agent-env-policy.js";
import { buildRuntimeEnv } from "./host-env.js";
import { buildRuntimeRequestEnv } from "./runtime-request-context.js";
import type { RuntimeCapabilities } from "./types.js";

const capabilities = { supportsToolHooks: true } as RuntimeCapabilities;

/** Names and values a daemon really carries in `~/.ravi/.env`; values are fake. */
const DAEMON_SECRETS: Record<string, string> = {
  RAVI_ADMIN_TOKEN: "canary-admin-token",
  RAVI_GITHUB_WEBHOOK_SECRET: "canary-webhook-secret",
  RAVI_AGORA_TOOL_SECRET: "canary-agora-tool",
  PROXMOX_TOKEN_SECRET: "canary-proxmox",
  AGORA_CUSTOMER_SECRET: "canary-agora-customer",
  AGORA_APP_CERTIFICATE: "canary-agora-certificate",
  WORKOS_COOKIE_PASSWORD: "canary-workos-cookie",
  WORKOS_API_KEY: "canary-workos-key",
  ELEVENLABS_API_KEY: "canary-elevenlabs",
  DEVIN_API_KEY: "canary-devin",
  OPENAI_API_KEY: "canary-openai",
  GEMINI_API_KEY: "canary-gemini",
  DEEPSEEK_API_KEY: "canary-deepseek",
  CLAUDE_CODE_OAUTH_TOKEN: "canary-claude-oauth",
  GH_TOKEN: "canary-gh",
  DATABASE_URL: "postgres://user:canary-db@db.internal/app",
  SENTRY_DSN: "https://canary-dsn@sentry.example/1",
};

const DAEMON_CONFIG: Record<string, string> = {
  PATH: "/usr/bin:/bin",
  HOME: "/Users/operator",
  LANG: "en_US.UTF-8",
  SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
  RAVI_STATE_DIR: "/Users/operator/.ravi",
  RAVI_HTTP_PORT: "4211",
  NATS_URL: "nats://127.0.0.1:4222",
  CLAUDE_CODE_MAX_OUTPUT_TOKENS: "64000",
  HTTPS_PROXY: "http://proxy.internal:3128",
};

describe("agent runtime env policy", () => {
  it("drops every daemon secret and keeps runtime and toolchain config", () => {
    const env = filterAgentRuntimeBaseEnv({ ...DAEMON_SECRETS, ...DAEMON_CONFIG });

    for (const name of Object.keys(DAEMON_SECRETS)) {
      expect(env[name]).toBeUndefined();
    }
    expect(env).toEqual(DAEMON_CONFIG);
  });

  it("drops an allowlisted name whose value is a URL with a password", () => {
    const env = filterAgentRuntimeBaseEnv({
      NATS_URL: "nats://ravi:canary-nats@127.0.0.1:4222",
      HTTPS_PROXY: "http://user:canary-proxy@proxy.internal:3128",
      PATH: "/usr/bin",
    });

    expect(env).toEqual({ PATH: "/usr/bin" });
  });

  it("never lets a Ravi- or tool-prefixed secret through its prefix", () => {
    for (const name of [
      "RAVI_ADMIN_TOKEN",
      "RAVI_CONTEXT_KEY",
      "GH_TOKEN",
      "GIT_ASKPASS_PASSWORD",
      "NODE_AUTH_TOKEN",
    ]) {
      expect(isAgentRuntimeEnvNameAllowed(name)).toBe(false);
    }
    for (const name of ["RAVI_STATE_DIR", "GH_PAGER", "GIT_EDITOR", "NODE_OPTIONS", "SSH_AUTH_SOCK"]) {
      expect(isAgentRuntimeEnvNameAllowed(name)).toBe(true);
    }
  });

  it("passes names the operator lists in RAVI_AGENT_ENV_PASSTHROUGH", () => {
    const env = filterAgentRuntimeBaseEnv({
      ...DAEMON_SECRETS,
      [AGENT_ENV_PASSTHROUGH_VAR]: "DEVIN_API_KEY, ELEVENLABS_API_KEY",
    });

    expect(env.DEVIN_API_KEY).toBe("canary-devin");
    expect(env.ELEVENLABS_API_KEY).toBe("canary-elevenlabs");
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.RAVI_ADMIN_TOKEN).toBeUndefined();
  });

  it("gives each provider only its own login variables", () => {
    expect(resolveProviderLoginEnvKeys("claude")).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(resolveProviderLoginEnvKeys("claude")).not.toContain("OPENAI_API_KEY");
    expect(resolveProviderLoginEnvKeys("codex")).toContain("OPENAI_API_KEY");
    expect(resolveProviderLoginEnvKeys("pi")).toEqual([]);
    expect(resolveProviderLoginEnvKeys(undefined)).toEqual([]);
  });
});

describe("agent shell env", () => {
  it("a shell spawned with the runtime env sees no daemon secret", () => {
    const runtimeEnv = buildRuntimeEnv(
      { ...DAEMON_SECRETS, ...DAEMON_CONFIG },
      { RAVI_CONTEXT_KEY: "rctx_turn", RAVI_SESSION_NAME: "main" },
      undefined,
      capabilities,
    );

    const shell = spawnSync("/bin/sh", ["-c", "env"], { env: runtimeEnv, encoding: "utf8" });
    expect(shell.status).toBe(0);
    const visibleNames = shell.stdout
      .split("\n")
      .map((line) => line.split("=", 1)[0])
      .filter(Boolean);

    for (const [name, value] of Object.entries(DAEMON_SECRETS)) {
      expect(visibleNames).not.toContain(name);
      expect(shell.stdout).not.toContain(value);
    }
    // The turn env is added on purpose after the filter.
    expect(visibleNames).toContain("RAVI_CONTEXT_KEY");
    expect(visibleNames).toContain("RAVI_STATE_DIR");
  });

  it("keeps the selected credential the request adds on purpose", () => {
    const runtimeEnv = buildRuntimeEnv(
      { ...DAEMON_SECRETS, ...DAEMON_CONFIG },
      { RAVI_CONTEXT_KEY: "rctx_turn" },
      { CLAUDE_CODE_OAUTH_TOKEN: "selected-credential" },
      capabilities,
    );

    expect(runtimeEnv.CLAUDE_CODE_OAUTH_TOKEN).toBe("selected-credential");
    expect(runtimeEnv.OPENAI_API_KEY).toBeUndefined();
  });

  it("lets a provider inherit its own login from the daemon env, and nothing else", () => {
    const saved = { claude: process.env.CLAUDE_CODE_OAUTH_TOKEN, openai: process.env.OPENAI_API_KEY };
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "daemon-claude-login";
    process.env.OPENAI_API_KEY = "daemon-openai-key";
    try {
      const claudeEnv = buildRuntimeRequestEnv({
        raviEnv: { RAVI_CONTEXT_KEY: "rctx_turn" },
        runtimeCapabilities: capabilities,
        runtimeProviderId: "claude",
      });
      expect(claudeEnv.CLAUDE_CODE_OAUTH_TOKEN).toBe("daemon-claude-login");
      expect(claudeEnv.OPENAI_API_KEY).toBeUndefined();

      const piEnv = buildRuntimeRequestEnv({
        raviEnv: { RAVI_CONTEXT_KEY: "rctx_turn" },
        runtimeCapabilities: capabilities,
        runtimeProviderId: "pi",
      });
      expect(piEnv.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      expect(piEnv.OPENAI_API_KEY).toBeUndefined();
    } finally {
      if (saved.claude === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = saved.claude;
      if (saved.openai === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = saved.openai;
    }
  });
});
