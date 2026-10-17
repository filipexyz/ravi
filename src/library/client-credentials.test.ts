import { describe, expect, it } from "bun:test";

import { ConsoleApiClient } from "../cloud-auth/client.js";
import type { CloudCredentials } from "../cloud-auth/types.js";
import { LibraryClient } from "./client.js";
import { FAKE_CONSOLE_URL, fakeCredentials } from "./test-fixtures.js";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/**
 * A Console whose refresh rotates the refresh token: each one works once, and
 * using a spent one fails like a revoked login (the client then deletes it).
 */
function rotatingConsole() {
  let generation = 1;
  const spent = new Set<string>();
  const paths: string[] = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url instanceof Request ? url.url : url)).pathname;
    paths.push(path);
    if (path === "/api/cli/auth/refresh") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { refreshToken?: string };
      if (body.refreshToken !== `refresh-${generation}` || spent.has(body.refreshToken)) {
        return json({ error: { code: "AUTH_REQUIRED", message: "refresh token already used" } }, 401);
      }
      spent.add(body.refreshToken);
      generation += 1;
      return json({ accessToken: `access-${generation}`, refreshToken: `refresh-${generation}` });
    }
    const auth = new Headers(init?.headers).get("authorization");
    if (auth !== `Bearer access-${generation}`) {
      return json({ error: { code: "AUTH_EXPIRED", message: "expired" } }, 401);
    }
    return json({ items: [], agents: [] });
  };
  return {
    fetch: fetch as typeof globalThis.fetch,
    paths,
    rotateElsewhere: () => {
      spent.add(`refresh-${generation}`);
      generation += 1;
      return { accessToken: `access-${generation}`, refreshToken: `refresh-${generation}` };
    },
  };
}

function libraryClient(console: ReturnType<typeof rotatingConsole>, stored: { current: CloudCredentials | null }) {
  let deleted = false;
  const client = new LibraryClient({
    client: new ConsoleApiClient({ consoleUrl: FAKE_CONSOLE_URL, fetch: console.fetch }),
    credentials: stored.current!,
    write: (credentials) => {
      stored.current = credentials;
    },
    delete: () => {
      deleted = true;
      stored.current = null;
    },
    read: () => stored.current,
  });
  return { client, deleted: () => deleted };
}

describe("library client credentials", () => {
  it("shares one login between a client and its agent-routes client", async () => {
    const console = rotatingConsole();
    const stored = {
      current: fakeCredentials({ accessToken: "stale", refreshToken: "refresh-1" }) as CloudCredentials | null,
    };
    const { client, deleted } = libraryClient(console, stored);
    const agents = client.forAgents();

    // The child refreshes (rotating refresh-1 to refresh-2)...
    await agents.search({ query: "x" });
    // ...and the parent sees it: no second refresh with the spent token.
    await client.search({ query: "x" });
    expect(console.paths.filter((path) => path === "/api/cli/auth/refresh")).toHaveLength(1);
    expect(deleted()).toBe(false);
    expect(stored.current?.refreshToken).toBe("refresh-2");
  });

  it("uses a login refreshed by another process instead of refreshing with a spent token", async () => {
    const console = rotatingConsole();
    const stored = {
      current: fakeCredentials({ accessToken: "access-1", refreshToken: "refresh-1" }) as CloudCredentials | null,
    };
    const { client, deleted } = libraryClient(console, stored);
    await client.search({ query: "x" });

    // Another process refreshes and stores the rotated login.
    stored.current = { ...stored.current!, ...console.rotateElsewhere() };
    await client.search({ query: "x" });

    expect(console.paths.filter((path) => path === "/api/cli/auth/refresh")).toHaveLength(0);
    expect(deleted()).toBe(false);
    expect(stored.current?.refreshToken).toBe("refresh-2");
  });
});
