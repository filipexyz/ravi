import { describe, expect, it } from "bun:test";
import { ConsoleApiClient } from "./client.js";
import { CloudAuthError, isCloudAuthError } from "./errors.js";

function client(status: number, body: string | null) {
  return new ConsoleApiClient({
    consoleUrl: "https://console.test",
    fetch: (async () =>
      new Response(body, {
        status,
        headers: body?.startsWith("{") ? { "content-type": "application/json" } : {},
      })) as unknown as (url: string, init?: RequestInit) => Promise<Response>,
  });
}

async function codeOf(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    return isCloudAuthError(error) ? error.code : `not-cloud: ${String(error)}`;
  }
}

describe("knowledge error codes", () => {
  it("policy codes exit 3 by default; unavailable exits 1", () => {
    expect(new CloudAuthError("KNOWLEDGE_TURN_NOT_OPERATOR", "x").exitCode).toBe(3);
    expect(new CloudAuthError("KNOWLEDGE_DISABLED", "x").exitCode).toBe(3);
    expect(new CloudAuthError("KNOWLEDGE_UNAVAILABLE", "x").exitCode).toBe(1);
  });

  it("a bare 404 on a knowledge path is KNOWLEDGE_UNAVAILABLE", async () => {
    expect(await codeOf(client(404, null).requestJson("POST", "/api/cli/knowledge/search", {}, "t"))).toBe(
      "KNOWLEDGE_UNAVAILABLE",
    );
    expect(
      await codeOf(client(404, "<html>nope</html>").requestJson("GET", "/api/cli/knowledge/marks", undefined, "t")),
    ).toBe("KNOWLEDGE_UNAVAILABLE");
  });

  it("a 404 with a CLI error code keeps that code", async () => {
    const body = JSON.stringify({ error: { code: "NOT_FOUND", message: "no ref" } });
    expect(await codeOf(client(404, body).requestJson("POST", "/api/cli/knowledge/read", {}, "t"))).toBe("NOT_FOUND");
  });

  it("a 403 KNOWLEDGE_DISABLED keeps its code", async () => {
    const body = JSON.stringify({ error: { code: "KNOWLEDGE_DISABLED", message: "off" } });
    expect(await codeOf(client(403, body).requestJson("POST", "/api/cli/knowledge/search", {}, "t"))).toBe(
      "KNOWLEDGE_DISABLED",
    );
  });

  it("a bare 404 elsewhere is not KNOWLEDGE_UNAVAILABLE", async () => {
    expect(await codeOf(client(404, null).requestJson("GET", "/api/cli/library/items", undefined, "t"))).not.toBe(
      "KNOWLEDGE_UNAVAILABLE",
    );
  });
});
