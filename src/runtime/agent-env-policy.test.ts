import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
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
  HTTPS_PROXY: "http://proxy.internal:3128",
};

/** Provider configuration: each name belongs to one provider. */
const PROVIDER_CONFIG: Record<string, string> = {
  CLAUDE_CODE_MAX_OUTPUT_TOKENS: "64000",
  ANTHROPIC_BASE_URL: "https://api.anthropic.example",
  CODEX_HOME: "/Users/operator/.codex",
  PI_CODING_AGENT_DIR: "/Users/operator/.pi/agent",
  GROK_HOME: "/Users/operator/.grok",
};

describe("agent runtime env policy", () => {
  it("drops every daemon secret and keeps shared runtime and toolchain config", () => {
    const env = filterAgentRuntimeBaseEnv({ ...DAEMON_SECRETS, ...DAEMON_CONFIG }, { runtimeProviderId: "pi" });

    for (const name of Object.keys(DAEMON_SECRETS)) {
      expect(env[name]).toBeUndefined();
    }
    expect(env).toEqual(DAEMON_CONFIG);
  });

  it("drops an allowlisted name whose value carries URL userinfo", () => {
    const env = filterAgentRuntimeBaseEnv({
      NATS_URL: "nats://ravi:canary-nats@127.0.0.1:4222",
      HTTPS_PROXY: "http://user:canary-proxy@proxy.internal:3128",
      // Empty user name with a password (Devin, PR #871).
      HTTP_PROXY: "http://:canary-empty-user@proxy.internal:3128",
      // A token used as the user name.
      ALL_PROXY: "https://canary-token@proxy.internal",
      // A URL with credentials inside a longer value.
      NODE_OPTIONS: "--use-env-proxy --proxy=http://u:canary-inline@proxy.internal",
      PATH: "/usr/bin",
      NO_PROXY: "localhost,127.0.0.1",
    });

    expect(env).toEqual({ PATH: "/usr/bin", NO_PROXY: "localhost,127.0.0.1" });
  });

  it("gives provider config only to the provider that owns it", () => {
    const base = { ...DAEMON_CONFIG, ...PROVIDER_CONFIG };

    const claude = filterAgentRuntimeBaseEnv(base, { runtimeProviderId: "claude" });
    expect(claude.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe("64000");
    expect(claude.ANTHROPIC_BASE_URL).toBe("https://api.anthropic.example");
    expect(claude.CODEX_HOME).toBeUndefined();
    expect(claude.GROK_HOME).toBeUndefined();

    const codex = filterAgentRuntimeBaseEnv(base, { runtimeProviderId: "codex" });
    expect(codex.CODEX_HOME).toBe("/Users/operator/.codex");
    expect(codex.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(codex.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBeUndefined();

    const unknown = filterAgentRuntimeBaseEnv(base);
    for (const name of Object.keys(PROVIDER_CONFIG)) {
      expect(unknown[name]).toBeUndefined();
    }
  });

  it("keeps ANTHROPIC_CUSTOM_HEADERS out unless passed through, and then only for Claude", () => {
    const base = { ...DAEMON_CONFIG, ANTHROPIC_CUSTOM_HEADERS: "Authorization: Bearer canary-header" };
    expect(filterAgentRuntimeBaseEnv(base, { runtimeProviderId: "claude" }).ANTHROPIC_CUSTOM_HEADERS).toBeUndefined();

    const passed = { ...base, [AGENT_ENV_PASSTHROUGH_VAR]: "ANTHROPIC_CUSTOM_HEADERS" };
    expect(filterAgentRuntimeBaseEnv(passed, { runtimeProviderId: "claude" }).ANTHROPIC_CUSTOM_HEADERS).toBe(
      "Authorization: Bearer canary-header",
    );
    for (const provider of ["codex", "pi", "grok", undefined]) {
      expect(
        filterAgentRuntimeBaseEnv(passed, { runtimeProviderId: provider }).ANTHROPIC_CUSTOM_HEADERS,
      ).toBeUndefined();
    }
  });

  it("passes git's env config trio whole or not at all", () => {
    const gitConfig = {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.extraHeader",
      GIT_CONFIG_VALUE_0: "Authorization: Bearer canary-git",
    };

    const dropped = filterAgentRuntimeBaseEnv({ ...DAEMON_CONFIG, ...gitConfig, GIT_EDITOR: "vi" });
    expect(dropped.GIT_CONFIG_COUNT).toBeUndefined();
    expect(dropped.GIT_CONFIG_KEY_0).toBeUndefined();
    expect(dropped.GIT_CONFIG_VALUE_0).toBeUndefined();
    expect(dropped.GIT_EDITOR).toBe("vi");

    const passed = filterAgentRuntimeBaseEnv({
      ...DAEMON_CONFIG,
      ...gitConfig,
      [AGENT_ENV_PASSTHROUGH_VAR]: "GIT_CONFIG_COUNT",
    });
    expect(passed.GIT_CONFIG_COUNT).toBe("1");
    expect(passed.GIT_CONFIG_KEY_0).toBe("http.extraHeader");
    expect(passed.GIT_CONFIG_VALUE_0).toBe("Authorization: Bearer canary-git");
  });

  it("never lets a Ravi- or tool-prefixed secret through its prefix", () => {
    for (const name of [
      "RAVI_ADMIN_TOKEN",
      "RAVI_CONTEXT_KEY",
      "GH_TOKEN",
      "GIT_ASKPASS_PASSWORD",
      "NODE_AUTH_TOKEN",
      "GIT_CONFIG_PARAMETERS",
      "GIT_CONFIG_KEY_0",
      "OTEL_EXPORTER_OTLP_HEADERS",
    ]) {
      expect(isAgentRuntimeEnvNameAllowed(name)).toBe(false);
      expect(isAgentRuntimeEnvNameAllowed(name, "claude")).toBe(false);
    }
    expect(isAgentRuntimeEnvNameAllowed("ANTHROPIC_CUSTOM_HEADERS", "claude")).toBe(false);
    for (const name of ["RAVI_STATE_DIR", "GH_PAGER", "GIT_EDITOR", "NODE_OPTIONS", "SSH_AUTH_SOCK"]) {
      expect(isAgentRuntimeEnvNameAllowed(name)).toBe(true);
    }
  });

  it("passes Ravi and Omni names only from the explicit list", () => {
    const env = filterAgentRuntimeBaseEnv({
      RAVI_STATE_DIR: "/Users/operator/.ravi",
      RAVI_GATEWAY_URL: "http://127.0.0.1:4211",
      RAVI_PM2_EXECUTABLE: "/opt/homebrew/bin/pm2",
      OMNI_API_URL: "http://127.0.0.1:8882",
      // Not listed: daemon-only config, internal markers, and names that do not look secret.
      RAVI_WEBHOOK_PUBLIC_BASE_URL: "https://hooks.example",
      RAVI_GATEWAY_INTERNAL: "1",
      RAVI_IDENTITYD_RUNTIME_SOCKET: "/run/ravi/identityd.sock",
      RAVI_SIGNING_SALT: "canary-salt",
      OMNI_SIGNING_SALT: "canary-omni-salt",
    });

    expect(env).toEqual({
      RAVI_STATE_DIR: "/Users/operator/.ravi",
      RAVI_GATEWAY_URL: "http://127.0.0.1:4211",
      RAVI_PM2_EXECUTABLE: "/opt/homebrew/bin/pm2",
      OMNI_API_URL: "http://127.0.0.1:8882",
    });
  });

  it("drops personal access tokens and token-shaped values under allowed names", () => {
    expect(isAgentRuntimeEnvNameAllowed("GITHUB_PAT")).toBe(false);
    expect(isAgentRuntimeEnvNameAllowed("GH_PAT")).toBe(false);
    expect(isAgentRuntimeEnvNameAllowed("COLOSSEUM_COPILOT_PAT")).toBe(false);

    const tokenShaped = {
      NODE_OPTIONS: "--header=sk-ant-api03-canaryCanaryCanary1234",
      GIT_TRACE: "ghp_canaryCanaryCanaryCanary1234",
      GH_PAGER: "github_pat_canaryCanaryCanary_1234567890",
      PAGER: "xoxb-1234567890-canary-token",
      LANG: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjYW5hcnkifQ.signature",
      EDITOR: "-----BEGIN OPENSSH PRIVATE KEY-----",
      VISUAL: "AKIACANARYCANARY1234",
    };
    const benign = {
      PATH: "/opt/task-runner-sk-tools/bin:/usr/bin",
      XDG_DATA_HOME: "/Users/operator/.local/share",
      GIT_EDITOR: "vi",
    };

    expect(filterAgentRuntimeBaseEnv({ ...tokenShaped, ...benign })).toEqual(benign);
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

  it("git still runs in an agent shell when the daemon env carries a git config trio", () => {
    const runtimeEnv = buildRuntimeEnv(
      {
        ...DAEMON_CONFIG,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.extraHeader",
        GIT_CONFIG_VALUE_0: "Authorization: Bearer canary-git",
      },
      { RAVI_CONTEXT_KEY: "rctx_turn" },
      undefined,
      capabilities,
    );

    // A partial trio (count and value without the key) makes git refuse every command.
    const git = spawnSync("git", ["config", "--list"], { env: runtimeEnv, encoding: "utf8", cwd: tmpdir() });
    expect(git.status).toBe(0);
    expect(git.stdout).not.toContain("canary-git");
  });
});
