import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import {
  buildRaviAppProcessEnv,
  parseRaviAppCapability,
  parseRaviAppCommand,
  RAVI_APP_GATEWAY_ENV_KEYS,
  resolveRaviAppCommand,
  tokenizeRaviAppCommand,
} from "./command.js";

describe("Ravi App CLI command contract", () => {
  it("tokenizes quoted and escaped argv without invoking a shell", () => {
    expect(tokenizeRaviAppCommand(`tool "two words" 'three words' escaped\\ value`)).toEqual([
      "tool",
      "two words",
      "three words",
      "escaped value",
    ]);
  });

  it("preserves Windows absolute paths with or without quotes", () => {
    const unquotedPath = String.raw`C:\ravi\permission-provider.mjs`;
    const quotedPath = String.raw`C:\Program Files\Ravi\permission-provider.mjs`;

    expect(tokenizeRaviAppCommand(`bun ${unquotedPath} --json`)).toEqual(["bun", unquotedPath, "--json"]);
    expect(tokenizeRaviAppCommand(`bun "${quotedPath}" --json`)).toEqual(["bun", quotedPath, "--json"]);
  });

  it("inserts dynamic args only at the complete {args} token", () => {
    expect(resolveRaviAppCommand("tool before {args} after", ["one", "two words"])).toMatchObject({
      executable: "tool",
      argv: ["before", "one", "two words", "after"],
    });
    expect(resolveRaviAppCommand("tool fixed", ["one"])).toMatchObject({
      executable: "tool",
      argv: ["fixed", "one"],
    });
  });

  it("rejects named placeholders instead of maintaining a second interpolation contract", () => {
    expect(() => resolveRaviAppCommand("tool get {id} --json", ["record-1", "--verbose"])).toThrow(
      'Unsupported CLI command placeholder in token "{id}"; only a complete {args} token is allowed',
    );
  });

  it("rewrites the ravi executable to the current runtime entrypoint", () => {
    const entrypoint = resolve("src", "cli", "index.ts");
    expect(
      resolveRaviAppCommand("ravi contacts list {args} --json", ["--limit", "2"], {
        execPath: "/runtime/bun",
        entrypoint,
      }),
    ).toMatchObject({
      executable: "/runtime/bun",
      argv: [entrypoint, "contacts", "list", "--limit", "2", "--json"],
    });
  });

  it("rejects shell syntax, substitution, malformed quoting, and unsafe placeholders", () => {
    const unsafe = [
      "tool a | other",
      "tool a && other",
      "tool a; other",
      "tool > output",
      "tool $(other)",
      "tool `other`",
      "tool\nother",
      "tool {}",
      "tool prefix-{args}",
      "tool {args} {id}",
      "tool 'unterminated",
      "tool dangling\\",
    ];

    for (const command of unsafe) {
      expect(() => parseRaviAppCommand(command)).toThrow();
    }
  });

  it("builds a strict process environment and injects only the child context key", () => {
    const env = buildRaviAppProcessEnv(
      {
        PATH: "/bin",
        HOME: "/home/test",
        RAVI_STATE_DIR: "/state",
        RAVI_CONTEXT_KEY: "parent-secret",
        RAVI_SESSION_KEY: "legacy-session",
        RAVI_AGENT_ID: "legacy-agent",
        API_TOKEN: "provider-secret",
      },
      {
        appId: "probe",
        operationId: "probe.inspect",
        appRoot: "/apps/probe",
        contextKey: "child-secret",
      },
    );

    expect(env).toEqual({
      PATH: "/bin",
      HOME: "/home/test",
      RAVI_STATE_DIR: "/state",
      RAVI_APP_ID: "probe",
      RAVI_APP_OPERATION_ID: "probe.inspect",
      RAVI_APP_ROOT: "/apps/probe",
      RAVI_CONTEXT_KEY: "child-secret",
    });
    expect(env.RAVI_SESSION_KEY).toBeUndefined();
    expect(env.RAVI_AGENT_ID).toBeUndefined();
    expect(env.API_TOKEN).toBeUndefined();
  });

  it("forwards the non-secret Ravi gateway endpoint so the child key can reach Ravi", () => {
    const source = {
      PATH: "/bin",
      RAVI_BASE_URL: "http://127.0.0.1:7777",
      RAVI_HTTP_BASE_URL: "http://127.0.0.1:7778",
      RAVI_GATEWAY_URL: "unix:///state/cli-gateway.sock",
      RAVI_HTTP_HOST: "0.0.0.0",
      RAVI_HTTP_PORT: "7777",
      RAVI_WEBHOOK_HOST: "127.0.0.1",
      RAVI_WEBHOOK_PORT: "7779",
      RAVI_CONTEXT_KEY: "parent-secret",
      RAVI_GATEWAY_NETWORK_AUTHORIZED: "1",
      RAVI_SDK_GATEWAY_DISABLE: "1",
      RAVI_CORS_ORIGINS: "http://127.0.0.1:8088",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-secret",
      ANTHROPIC_API_KEY: "anthropic-secret",
    };

    const env = buildRaviAppProcessEnv(source, { contextKey: "child-secret" });

    for (const key of RAVI_APP_GATEWAY_ENV_KEYS) {
      expect(env[key]).toBe(source[key]);
    }
    expect(env).toEqual({
      PATH: "/bin",
      RAVI_BASE_URL: "http://127.0.0.1:7777",
      RAVI_HTTP_BASE_URL: "http://127.0.0.1:7778",
      RAVI_GATEWAY_URL: "unix:///state/cli-gateway.sock",
      RAVI_HTTP_HOST: "0.0.0.0",
      RAVI_HTTP_PORT: "7777",
      RAVI_WEBHOOK_HOST: "127.0.0.1",
      RAVI_WEBHOOK_PORT: "7779",
      RAVI_CONTEXT_KEY: "child-secret",
    });
    expect(JSON.stringify(env)).not.toContain("parent-secret");
    expect(JSON.stringify(env)).not.toContain("oauth-secret");
    expect(JSON.stringify(env)).not.toContain("anthropic-secret");
  });

  it("does not synthesize a Ravi gateway endpoint when the parent has none", () => {
    const env = buildRaviAppProcessEnv({ PATH: "/bin", RAVI_HTTP_PORT: undefined }, { contextKey: "child-secret" });

    expect(env).toEqual({ PATH: "/bin", RAVI_CONTEXT_KEY: "child-secret" });
    for (const key of RAVI_APP_GATEWAY_ENV_KEYS) {
      expect(key in env).toBe(false);
    }
  });

  it("parses explicit manifest capabilities", () => {
    expect(parseRaviAppCapability("execute:group:contacts")).toEqual({
      permission: "execute",
      objectType: "group",
      objectId: "contacts",
      source: "app-manifest",
    });
    expect(parseRaviAppCapability("read:resource:org:123")).toMatchObject({
      permission: "read",
      objectType: "resource",
      objectId: "org:123",
    });
    expect(() => parseRaviAppCapability("execute:group")).toThrow(/expected permission:objectType:objectId/);
  });
});
