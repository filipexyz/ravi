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
import { buildRuntimeRequestEnv } from "./runtime-request-context.js";
import { materializeRuntimeModelBroker } from "./model-broker-materializer.js";
import type { RuntimeModelBrokerBinding, RuntimeModelBrokerProtocol } from "./model-broker.js";
import type { RuntimeCapabilities, RuntimeProviderId } from "./types.js";

let stateDir: string | undefined;
let outsideDir: string | undefined;

afterEach(() => {
  if (stateDir) rmSync(stateDir, { recursive: true, force: true });
  if (outsideDir) rmSync(outsideDir, { recursive: true, force: true });
  stateDir = undefined;
  outsideDir = undefined;
});

describe("model-broker provider materialization", () => {
  test("fails closed without real provider-principal isolation", () => {
    expect(() =>
      materializeRuntimeModelBroker(
        { ...binding("codex", "openai-responses"), principalIsolation: "none" as never },
        env(),
      ),
    ).toThrow("isolated provider principal");
  });

  test("materializes Codex Responses through the loopback forwarder", () => {
    const result = materializeRuntimeModelBroker(binding("codex", "openai-responses"), env());
    const config = readFileSync(join(result.configDir, "config.toml"), "utf8");
    expect(result.env.CODEX_HOME).toBe(result.configDir);
    expect(config).toContain('wire_api = "responses"');
    expect(config).toContain('base_url = "http://127.0.0.1:43123/v1"');
    expect(config).toContain('"x-public-route" = "binding_codex_1"');
    expect(config).toContain("requires_openai_auth = false");
    assertPrivate(result.configDir, join(result.configDir, "config.toml"));
    assertNoUpstreamSecret(config, result.env);
  });

  test("materializes Claude dummy auth and strict sandbox without upstream tokens", () => {
    const result = materializeRuntimeModelBroker(binding("claude", "anthropic-messages"), env());
    const config = readFileSync(join(result.configDir, "settings.json"), "utf8");
    expect(result.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:43123");
    expect(result.env.ANTHROPIC_CUSTOM_HEADERS).toBe("x-public-route: binding_claude_1");
    expect(config).toContain("printf ravi-local-forwarder");
    expect(config).toContain('"failIfUnavailable": true');
    expect(config).toContain('"allowUnsandboxedCommands": false');
    assertNoUpstreamSecret(config, result.env);
  });

  test("materializes Pi generic completions with dummy auth and public headers", () => {
    const result = materializeRuntimeModelBroker(binding("pi", "openai-completions"), env());
    const config = readFileSync(join(result.configDir, "models.json"), "utf8");
    expect(result.env.PI_CODING_AGENT_DIR).toBe(result.configDir);
    expect(config).toContain('"apiKey": "ravi-local-forwarder"');
    expect(config).toContain('"x-public-route": "binding_pi_1"');
    expect(config).toContain('"api": "openai-completions"');
    assertNoUpstreamSecret(config, result.env);
  });

  test("strips daemon and provider upstream credentials from broker runtime env", () => {
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "daemon-secret";
    try {
      const runtimeEnv = buildRuntimeRequestEnv({
        raviEnv: { RAVI_CONTEXT_KEY: "rctx_test" },
        providerEnv: { OPENAI_API_KEY: "provider-secret", PATH: "/usr/bin" },
        runtimeCapabilities: {} as RuntimeCapabilities,
        forceSanitizeSecrets: true,
      });
      expect(runtimeEnv.OPENAI_API_KEY).toBeUndefined();
      expect(runtimeEnv.PATH).toEndWith(":/usr/bin");
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
  });

  test("rejects a pre-existing symlink in the materialization ancestry", () => {
    stateDir = realpathSync(mkdtempSync(join(tmpdir(), "ravi-model-broker-state-")));
    outsideDir = realpathSync(mkdtempSync(join(tmpdir(), "ravi-model-broker-outside-")));
    mkdirSync(join(stateDir, "model-broker"));
    symlinkSync(outsideDir, join(stateDir, "model-broker", "bindings"), "dir");

    expect(() => materializeRuntimeModelBroker(binding("codex", "openai-responses"), envForState(stateDir!))).toThrow(
      "unsafe model-broker materialization directory",
    );
    expect(readdirSync(outsideDir)).toEqual([]);
  });
});

function env(): NodeJS.ProcessEnv {
  stateDir = realpathSync(mkdtempSync(join(tmpdir(), "ravi-model-broker-materializer-")));
  return envForState(stateDir);
}

function envForState(path: string): NodeJS.ProcessEnv {
  return { RAVI_STATE_DIR: path };
}

function binding(runtimeProvider: RuntimeProviderId, protocol: RuntimeModelBrokerProtocol): RuntimeModelBrokerBinding {
  const suffix =
    protocol === "anthropic-messages"
      ? "/v1/messages"
      : protocol === "openai-responses"
        ? "/v1/responses"
        : "/v1/chat/completions";
  return {
    version: 1,
    brokerId: "hub",
    leaseId: `lease_${runtimeProvider}_1`,
    attemptId: `attempt_${runtimeProvider}_1`,
    turnId: `turn_${runtimeProvider}_1`,
    runtimeId: "runtime_a",
    runtimeProvider,
    model: runtimeProvider === "pi" ? "moonshotai/kimi-k2.5" : "model-1",
    routeRevision: `route_${runtimeProvider}_1`,
    compatibilityRevision: `compat_${runtimeProvider}_1`,
    expiresAt: Date.now() + 60_000,
    transport: {
      scheme: "local-http-forwarder-v1",
      protocol,
      origin: "http://127.0.0.1:43123",
      path: suffix,
      publicHeaders: { "x-public-route": `binding_${runtimeProvider}_1` },
    },
    profileRef: "profile_main",
    selectionCompatibilityKey: "selection_main",
    principalIsolation: "cgroup",
  };
}

function assertPrivate(dir: string, file: string): void {
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  expect(statSync(file).mode & 0o777).toBe(0o600);
}

function assertNoUpstreamSecret(config: string, materializedEnv: Record<string, string>): void {
  expect(config).not.toContain("daemon-secret");
  expect(Object.keys(materializedEnv)).not.toContain("OPENAI_API_KEY");
  expect(Object.keys(materializedEnv)).not.toContain("ANTHROPIC_API_KEY");
  expect(config).not.toContain("Bearer");
}
