import { describe, expect, test } from "bun:test";
import {
  TEST_ACCESS_AUD,
  TEST_ACCESS_CLIENT_ID,
  TEST_ACCESS_TEAM_DOMAIN,
  TEST_INSTALLATION_A,
} from "../test/sandbox-grant-tokens.js";
import {
  normalizeConsoleIssuer,
  readSandboxListenerConfig,
  SANDBOX_LISTENER_SETTINGS,
  type SandboxListenerConfig,
  sameSandboxListenerConfig,
} from "./config.js";

const settings: Record<string, string> = {
  [SANDBOX_LISTENER_SETTINGS.port]: "47231",
  [SANDBOX_LISTENER_SETTINGS.accessTeamDomain]: TEST_ACCESS_TEAM_DOMAIN,
  [SANDBOX_LISTENER_SETTINGS.accessAud]: TEST_ACCESS_AUD,
  [SANDBOX_LISTENER_SETTINGS.accessClientId]: TEST_ACCESS_CLIENT_ID,
  [SANDBOX_LISTENER_SETTINGS.installationId]: TEST_INSTALLATION_A,
  [SANDBOX_LISTENER_SETTINGS.consoleUrl]: "https://console.ravi.bot/",
  [SANDBOX_LISTENER_SETTINGS.tunnelHostname]: `${TEST_INSTALLATION_A}.tun.ravi.bot`,
};
const read = (patch: Record<string, string | null> = {}) =>
  readSandboxListenerConfig((key) => (key in patch ? patch[key]! : (settings[key] ?? null)));

describe("readSandboxListenerConfig", () => {
  test("is disabled without a port and enabled with every key well-formed", () => {
    expect(read({ [SANDBOX_LISTENER_SETTINGS.port]: null })).toEqual({ enabled: false, reason: "not_configured" });
    expect(read()).toEqual({
      enabled: true,
      config: {
        port: 47231,
        accessTeamDomain: TEST_ACCESS_TEAM_DOMAIN,
        accessAud: TEST_ACCESS_AUD,
        accessClientId: TEST_ACCESS_CLIENT_ID,
        installationId: TEST_INSTALLATION_A,
        consoleIssuer: "https://console.ravi.bot",
        tunnelHostname: `${TEST_INSTALLATION_A}.tun.ravi.bot`,
      },
    });
    // The drift latch is not a setting (it lives in sandbox_listener_state, see tunnel-state.ts).
    expect(Object.values(SANDBOX_LISTENER_SETTINGS)).not.toContain("gateway.tunnel.driftLatched");
  });

  test("sameSandboxListenerConfig compares every field", () => {
    const a = (read() as { config: SandboxListenerConfig }).config;
    expect(sameSandboxListenerConfig(a, { ...a })).toBe(true);
    expect(sameSandboxListenerConfig(a, { ...a, port: a.port + 1 })).toBe(false);
    expect(sameSandboxListenerConfig(a, { ...a, accessAud: `${a.accessAud}x` })).toBe(false);
  });

  test("names every malformed key and never starts without the common_name pin", () => {
    expect(read({ [SANDBOX_LISTENER_SETTINGS.accessClientId]: null })).toEqual({
      enabled: false,
      reason: "config_invalid",
      invalid: ["accessClientId"],
    });
    expect(
      read({
        [SANDBOX_LISTENER_SETTINGS.port]: "0",
        [SANDBOX_LISTENER_SETTINGS.accessTeamDomain]: "acme.example.com",
        [SANDBOX_LISTENER_SETTINGS.accessAud]: "short",
        [SANDBOX_LISTENER_SETTINGS.installationId]: "not-a-uuid",
        [SANDBOX_LISTENER_SETTINGS.consoleUrl]: "http://console.ravi.bot",
        [SANDBOX_LISTENER_SETTINGS.tunnelHostname]: "other.tun.ravi.bot",
      }),
    ).toEqual({
      enabled: false,
      reason: "config_invalid",
      invalid: ["port", "accessTeamDomain", "accessAud", "installationId", "consoleUrl", "tunnelHostname"],
    });
    // The hostname must be this installation's.
    expect(
      read({ [SANDBOX_LISTENER_SETTINGS.tunnelHostname]: `${TEST_INSTALLATION_A}.tun.ravi.bot:8443` }),
    ).toMatchObject({ invalid: ["tunnelHostname"] });
  });

  test("normalizeConsoleIssuer keeps an https origin only", () => {
    expect(normalizeConsoleIssuer("https://console.ravi.bot")).toBe("https://console.ravi.bot");
    expect(normalizeConsoleIssuer("https://console.ravi.bot/")).toBe("https://console.ravi.bot");
    expect(normalizeConsoleIssuer("https://console.example.com:8443")).toBe("https://console.example.com:8443");
    for (const bad of [
      "",
      "console.ravi.bot",
      "http://console.ravi.bot",
      "https://console.ravi.bot/api",
      "https://console.ravi.bot/?x=1",
      "https://console.ravi.bot/#f",
      "https://user:pw@console.ravi.bot",
    ]) {
      expect(normalizeConsoleIssuer(bad), bad).toBeNull();
    }
  });
});
