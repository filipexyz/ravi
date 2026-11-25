import { describe, expect, it } from "bun:test";

import { canWithCapabilities } from "../permissions/capability-snapshot.js";
import { HOST_MCP_SERVER_NAMES } from "../runtime/runtime-host-attachments.js";
import {
  assertMcpServerName,
  checkMcpServerName,
  exposedToolName,
  mcpDisplayUrl,
  mcpInlineSecretArgIndex,
  McpServerNameError,
  McpServerUrlError,
  mcpUrlCarriesSecret,
  parseMcpServerUrl,
  reservedMcpServerNames,
} from "./names.js";

describe("MCP server name grammar", () => {
  it("accepts lowercase names with digits and hyphens, up to 24 characters", () => {
    for (const name of ["a", "github", "ravi-console", "s3", "a-b-c", "x".repeat(24)]) {
      expect(assertMcpServerName(name)).toBe(name);
    }
  });

  it.each([
    ["an underscore", "a__b"],
    ["a single underscore", "my_server"],
    ["upper case", "GitHub"],
    ["a leading digit", "1server"],
    ["a leading hyphen", "-server"],
    ["more than 24 characters", "x".repeat(25)],
    ["an empty name", ""],
    ["a dot", "a.b"],
    ["a space", "a b"],
  ])("refuses %s", (_label, name) => {
    const result = checkMcpServerName(name);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(McpServerNameError);
    expect(result.error.code).toBe("invalid_name");
  });

  it("refuses non-string input", () => {
    expect(checkMcpServerName(undefined).ok).toBe(false);
    expect(checkMcpServerName(42).ok).toBe(false);
  });

  it("reserves ravi and every host server name from the host export", () => {
    expect(reservedMcpServerNames()).toEqual(["ravi", ...HOST_MCP_SERVER_NAMES]);
    expect(HOST_MCP_SERVER_NAMES).toContain("spec");
    for (const name of reservedMcpServerNames()) {
      expect(() => assertMcpServerName(name)).toThrow(McpServerNameError);
      const result = checkMcpServerName(name);
      expect(result.ok ? null : result.error.code).toBe("reserved_name");
    }
  });

  it("keeps a grant on mcp__a__* away from server a-b", () => {
    const grant = [{ permission: "use", objectType: "tool", objectId: "mcp__a__*" }];
    const own = exposedToolName("a", "search");
    const other = exposedToolName("a-b", "search");
    expect(own.ok && other.ok).toBe(true);
    if (!own.ok || !other.ok) return;
    expect(canWithCapabilities(grant, "use", "tool", own.name)).toBe(true);
    expect(canWithCapabilities(grant, "use", "tool", other.name)).toBe(false);
    // The only server a prefix could reach otherwise is one with an underscore, which no name may hold.
    expect(checkMcpServerName("a__b").ok).toBe(false);
  });
});

describe("exposed tool names", () => {
  it("exposes a safe tool as mcp__<server>__<tool>", () => {
    expect(exposedToolName("github", "create_issue")).toEqual({ ok: true, name: "mcp__github__create_issue" });
    expect(exposedToolName("ravi-console", "ravi_pages_ship")).toEqual({
      ok: true,
      name: "mcp__ravi-console__ravi_pages_ship",
    });
  });

  it.each([
    ["a dot", "files.read"],
    ["a space", "read file"],
    ["a slash", "a/b"],
    ["a colon", "a:b"],
    ["more than 64 characters", "t".repeat(65)],
    ["no name", ""],
  ])("drops a tool with %s and says why", (_label, tool) => {
    const result = exposedToolName("github", tool);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason.length).toBeGreaterThan(0);
  });

  it("drops a tool whose full exposed name exceeds 64 characters, without truncating it", () => {
    const tool = "t".repeat(64 - "mcp__github__".length + 1);
    const result = exposedToolName("github", tool);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain(`mcp__github__${tool}`);

    const fits = "t".repeat(64 - "mcp__github__".length);
    expect(exposedToolName("github", fits)).toEqual({ ok: true, name: `mcp__github__${fits}` });
  });
});

describe("server URL display form", () => {
  it("drops the query, fragment and user info, and elides token-like path segments", () => {
    const url = "https://user:pw@mcp.example.com:8443/bridge/AbCdEf0123456789_-xyz/mcp?token=secret#frag";
    const display = mcpDisplayUrl(url);
    expect(display).toBe("https://mcp.example.com:8443/bridge/…/mcp");
    for (const leak of ["AbCdEf0123456789", "secret", "user", "pw", "frag"]) expect(display).not.toContain(leak);
  });

  it("elides a segment that holds a token-like run beside other characters, raw or percent-encoded", () => {
    expect(mcpDisplayUrl("https://h.example/v1/tok.AAAAAAAAAAAAAAAAAAAA/x")).toBe("https://h.example/v1/…/x");
    const encoded = encodeURIComponent("AAAA~BBBBBBBBBBBBBBBBB");
    expect(mcpDisplayUrl(`https://h.example/${encoded}`)).toBe("https://h.example/…");
  });

  it("keeps short segments and the bare origin", () => {
    expect(mcpDisplayUrl("https://mcp.ravi.so/mcp")).toBe("https://mcp.ravi.so/mcp");
    expect(mcpDisplayUrl("https://mcp.ravi.so/")).toBe("https://mcp.ravi.so");
  });

  it("requires https, except plain http on a loopback host", () => {
    expect(parseMcpServerUrl("http://127.0.0.1:9000/mcp").host).toBe("127.0.0.1:9000");
    expect(parseMcpServerUrl("http://localhost/mcp").hostname).toBe("localhost");
    for (const bad of ["http://mcp.example.com/x", "ftp://h/x", "file:///etc/passwd", "not a url"]) {
      expect(() => parseMcpServerUrl(bad)).toThrow(McpServerUrlError);
    }
  });

  it("never repeats the URL in its error", () => {
    try {
      parseMcpServerUrl("http://example.com/SECRETSECRETSECRETSECRET");
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(McpServerUrlError);
      expect((error as Error).message).not.toContain("SECRET");
    }
  });
});

describe("secrets on a command line", () => {
  it("knows when a URL carries more than its display form shows", () => {
    expect(mcpUrlCarriesSecret(new URL("https://mcp.example.com/mcp"))).toBe(false);
    expect(mcpUrlCarriesSecret(new URL("https://mcp.example.com/b/abcdefghijklmnopqrstuvwxyz/mcp"))).toBe(true);
    expect(mcpUrlCarriesSecret(new URL("https://mcp.example.com/mcp?key=x"))).toBe(true);
    expect(mcpUrlCarriesSecret(new URL("https://user:pw@mcp.example.com/mcp"))).toBe(true);
    expect(mcpUrlCarriesSecret(new URL("https://mcp.example.com/mcp#frag"))).toBe(true);
  });

  it("finds a secret-looking argument and leaves ordinary ones alone", () => {
    expect(mcpInlineSecretArgIndex(["-y", "@scope/server", "--readonly"])).toBeNull();
    expect(mcpInlineSecretArgIndex(["-y", "--api-key=abc"])).toBe(1);
    expect(mcpInlineSecretArgIndex(["--token", "abc"])).toBe(0);
    expect(mcpInlineSecretArgIndex(["--token", "--next"])).toBeNull();
    expect(mcpInlineSecretArgIndex(["GITHUB_TOKEN=abc"])).toBe(0);
    expect(mcpInlineSecretArgIndex(["x", "https://h.example.com/mcp?key=abc"])).toBe(1);
    expect(mcpInlineSecretArgIndex(["https://h.example.com/mcp"])).toBeNull();
  });
});
