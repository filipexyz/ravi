import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materializeRuntimeIntelligenceProxy } from "./intelligence-materializer.js";
import type { RuntimeIntelligenceProxyBinding, RuntimeIntelligenceProtocol } from "./intelligence-proxy.js";
import type { RuntimeProviderId } from "./types.js";

let stateDir: string | undefined;
let outsideDir: string | undefined;

afterEach(() => {
  if (stateDir) rmSync(stateDir, { recursive: true, force: true });
  if (outsideDir) rmSync(outsideDir, { recursive: true, force: true });
  stateDir = undefined;
  outsideDir = undefined;
});

describe("intelligence provider materialization", () => {
  test("fails closed without real provider-principal isolation", () => {
    expect(() =>
      materializeRuntimeIntelligenceProxy(
        { ...binding("codex", "openai-responses"), providerPrincipalIsolation: "none" as never },
        env(),
      ),
    ).toThrow("isolated provider principal");
  });

  test("materializes Codex Responses through the local signing forwarder", () => {
    const result = materializeRuntimeIntelligenceProxy(binding("codex", "openai-responses"), env());
    const config = readFileSync(join(result.configDir, "config.toml"), "utf8");
    expect(result.env.CODEX_HOME).toBe(result.configDir);
    expect(config).toContain('wire_api = "responses"');
    expect(config).toContain('base_url = "http://127.0.0.1:43123/v1"');
    expect(config).toContain('"x-ravi-binding" = "binding_codex_1"');
    expect(config).toContain("requires_openai_auth = false");
    expect(config).not.toContain("token --raw");
    assertPrivate(result.configDir, join(result.configDir, "config.toml"));
    assertNoUpstreamSecret(config, result.env);
  });

  test("materializes Claude dummy auth, strict sandbox, and local forwarder without upstream tokens", () => {
    const result = materializeRuntimeIntelligenceProxy(binding("claude", "anthropic-messages"), env());
    const config = readFileSync(join(result.configDir, "settings.json"), "utf8");
    expect(result.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:43123");
    expect(result.env.ANTHROPIC_CUSTOM_HEADERS).toBe("x-ravi-binding: binding_claude_1");
    expect(config).toContain("printf ravi-local-forwarder");
    expect(config).toContain('"failIfUnavailable": true');
    expect(config).toContain('"allowUnsandboxedCommands": false');
    expect(config).toContain('"allowAllUnixSockets": false');
    assertNoUpstreamSecret(config, result.env);
  });

  test("materializes Pi OpenRouter/Kimi models with dummy auth and a public binding header", () => {
    const result = materializeRuntimeIntelligenceProxy(binding("pi", "openai-completions"), env());
    const config = readFileSync(join(result.configDir, "models.json"), "utf8");
    expect(result.env.PI_CODING_AGENT_DIR).toBe(result.configDir);
    expect(config).toContain('"apiKey": "ravi-local-forwarder"');
    expect(config).toContain('"x-ravi-binding": "binding_pi_1"');
    expect(config).toContain('"api": "openai-completions"');
    assertNoUpstreamSecret(config, result.env);
  });

  test("isolates materialization by runtime, connection, provider, and model", () => {
    const base = binding("codex", "openai-responses");
    const first = materializeRuntimeIntelligenceProxy(base, env());
    const otherRuntime = materializeRuntimeIntelligenceProxy(
      { ...base, runtimeId: "runtime_b" },
      {
        RAVI_STATE_DIR: stateDir,
      },
    );
    const otherModel = materializeRuntimeIntelligenceProxy(
      { ...base, model: "model-2" },
      {
        RAVI_STATE_DIR: stateDir,
      },
    );
    const otherConnection = materializeRuntimeIntelligenceProxy(
      { ...base, connectionId: "conn_other" },
      { RAVI_STATE_DIR: stateDir },
    );
    const otherProvider = materializeRuntimeIntelligenceProxy(
      {
        ...base,
        runtimeProvider: "claude",
        protocol: "anthropic-messages",
        upstreamProvider: "anthropic",
        providerRuntimeId: "ravi-hub-claude",
      },
      { RAVI_STATE_DIR: stateDir },
    );

    const directories = [
      first.configDir,
      otherRuntime.configDir,
      otherModel.configDir,
      otherConnection.configDir,
      otherProvider.configDir,
    ];
    expect(new Set(directories).size).toBe(5);
    for (const directory of directories) {
      expect(readdirSync(directory).some((name) => name.endsWith(".tmp"))).toBe(false);
    }
  });

  test("rejects a pre-existing symlink in the materialization ancestry", () => {
    stateDir = realpathSync(mkdtempSync(join(tmpdir(), "ravi-intelligence-state-")));
    outsideDir = realpathSync(mkdtempSync(join(tmpdir(), "ravi-intelligence-outside-")));
    mkdirSync(join(stateDir, "intelligence"));
    symlinkSync(outsideDir, join(stateDir, "intelligence", "bindings"), "dir");

    expect(() =>
      materializeRuntimeIntelligenceProxy(binding("codex", "openai-responses"), {
        RAVI_STATE_DIR: stateDir,
      }),
    ).toThrow("unsafe intelligence materialization directory");
    expect(readdirSync(outsideDir)).toEqual([]);
  });

  test("rejects a symlink used as the materialization root", () => {
    const parent = realpathSync(mkdtempSync(join(tmpdir(), "ravi-intelligence-root-parent-")));
    outsideDir = realpathSync(mkdtempSync(join(tmpdir(), "ravi-intelligence-root-outside-")));
    stateDir = join(parent, "state-link");
    symlinkSync(outsideDir, stateDir, "dir");

    expect(() =>
      materializeRuntimeIntelligenceProxy(binding("codex", "openai-responses"), envForState(stateDir!)),
    ).toThrow(/unsafe intelligence materialization directory|non-canonical intelligence materialization root/);
    rmSync(parent, { recursive: true, force: true });
  });
});

function env(): NodeJS.ProcessEnv {
  stateDir = realpathSync(mkdtempSync(join(tmpdir(), "ravi-intelligence-materializer-")));
  return { RAVI_STATE_DIR: stateDir };
}

function envForState(path: string): NodeJS.ProcessEnv {
  return { RAVI_STATE_DIR: path };
}

function binding(
  runtimeProvider: RuntimeProviderId,
  protocol: RuntimeIntelligenceProtocol,
): RuntimeIntelligenceProxyBinding {
  return {
    version: 1,
    grantId: `grant_${runtimeProvider}_1`,
    attemptId: `attempt_${runtimeProvider}_1`,
    grantExpiresAt: Date.now() + 60_000,
    runtimeId: "runtime_a",
    profileId: "profile_main",
    connectionId: `conn_${runtimeProvider}_primary`,
    connectionRevision: "revision_1",
    sessionCompatibilityKey: `compat_${runtimeProvider}_1`,
    policyCompatibilityKey: "policy_main_required",
    runtimeProvider,
    upstreamProvider: runtimeProvider === "pi" ? "openrouter" : runtimeProvider === "claude" ? "anthropic" : "openai",
    model: runtimeProvider === "pi" ? "moonshotai/kimi-k2.5" : "model-1",
    protocol,
    localSigningForwarderBaseUrl: `http://127.0.0.1:43123${protocol === "anthropic-messages" ? "" : "/v1"}`,
    localSigningForwarderRequestPath:
      protocol === "anthropic-messages"
        ? "/v1/messages"
        : protocol === "openai-responses"
          ? "/v1/responses"
          : "/v1/chat/completions",
    bindingHandle: `binding_${runtimeProvider}_1`,
    audience: "ravi-hub-intelligence",
    providerRuntimeId: `ravi-hub-${runtimeProvider}`,
    providerPrincipalIsolation: "cgroup",
  };
}

function assertPrivate(dir: string, file: string): void {
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  expect(statSync(file).mode & 0o777).toBe(0o600);
}

function assertNoUpstreamSecret(config: string, materializedEnv: Record<string, string>): void {
  expect(config).not.toContain("sk-test-secret");
  expect(Object.keys(materializedEnv)).not.toContain("OPENAI_API_KEY");
  expect(Object.keys(materializedEnv)).not.toContain("ANTHROPIC_API_KEY");
  expect(config).not.toContain("https://hub.example.com");
  expect(config).not.toContain("Bearer");
}
