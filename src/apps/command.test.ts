import { describe, expect, it } from "bun:test";
import {
  buildRaviAppProcessEnv,
  parseRaviAppCapability,
  parseRaviAppCommand,
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
    expect(
      resolveRaviAppCommand("ravi contacts list {args} --json", ["--limit", "2"], {
        execPath: "/runtime/bun",
        entrypoint: "/repo/src/cli/index.ts",
      }),
    ).toMatchObject({
      executable: "/runtime/bun",
      argv: ["/repo/src/cli/index.ts", "contacts", "list", "--limit", "2", "--json"],
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
