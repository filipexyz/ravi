import { describe, expect, it } from "bun:test";
import { isCloudAuthError } from "../cloud-auth/errors.js";
import type { CloudCredentials } from "../cloud-auth/types.js";
import { decodeExecContextHeader, EXEC_CONTEXT_HEADER } from "../link/connector-turn.js";
import {
  DAEMON_KNOWLEDGE_TURN,
  isConsoleUnavailable,
  knowledgeExecContextHeader,
  openKnowledgeClient,
} from "./client.js";
import type { KnowledgeTurn } from "./types.js";

const CONSOLE = "https://console.test";

function credentials(overrides: Partial<CloudCredentials> = {}): CloudCredentials {
  return {
    version: 1,
    consoleUrl: CONSOLE,
    installationId: "inst-1",
    accessToken: "access-1",
    refreshToken: "refresh-1",
    accessTokenExpiresAt: null,
    scopes: ["knowledge.read"],
    user: { id: "user-1", email: "op@example.com", name: "Op" },
    organization: { id: "org-1", slug: "acme", name: "Acme" },
    createdAt: "2026-10-13T00:00:00.000Z",
    updatedAt: "2026-10-13T00:00:00.000Z",
    ...overrides,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const OPERATOR_TURN: KnowledgeTurn = {
  audience: "operator",
  turnKey: "turn-1",
  sessionName: "dev-main",
  agentId: "dev",
  execContext: {
    v: 1,
    agentId: "dev",
    sessionName: "dev-main",
    turnKey: "turn-1",
    speaker: { kind: "owner", contactId: "contact_op", consoleUserId: "cu_123" },
    conversation: "dm",
  } as KnowledgeTurn["execContext"],
};

type Call = { path: string; method: string; headers: Headers; body: string | null };

function fakeConsole(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      path: new URL(String(url instanceof Request ? url.url : url)).pathname,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : null,
    };
    calls.push(call);
    return handler(call);
  };
  return { calls, fetch: fetch as typeof globalThis.fetch };
}

async function capture(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

describe("knowledge client", () => {
  it("is null without a login", async () => {
    expect(await openKnowledgeClient({ readCredentials: () => null })).toBeNull();
    expect(
      await openKnowledgeClient({
        readCredentials: () => {
          throw new Error("broken store");
        },
      }),
    ).toBeNull();
  });

  it("sends the exec context as v1 without consoleUserId", async () => {
    const console = fakeConsole(() =>
      json({
        runId: "r1",
        audience: "operator",
        query: { normalized: "x", mode: "and" },
        results: [],
        withheld: { count: 0, reasons: {} },
        issues: [],
      }),
    );
    const client = await openKnowledgeClient({ readCredentials: () => credentials(), fetch: console.fetch });
    expect(client?.orgId).toBe("org-1");
    await client?.search({ query: "x" }, OPERATOR_TURN);
    const call = console.calls[0];
    expect(call?.path).toBe("/api/cli/knowledge/search");
    expect(call?.method).toBe("POST");
    expect(call?.headers.get("authorization")).toBe("Bearer access-1");
    const header = call?.headers.get(EXEC_CONTEXT_HEADER);
    expect(header).toBeTruthy();
    const decoded = decodeExecContextHeader(header ?? "") as Record<string, unknown> & {
      speaker: Record<string, unknown>;
    };
    expect(decoded.v).toBe(1);
    expect(decoded.speaker.kind).toBe("owner");
    expect(decoded.speaker.contactId).toBe("contact_op");
    expect("consoleUserId" in decoded.speaker).toBe(false);
    expect(JSON.stringify(decoded)).not.toContain("cu_123");
    expect(decodeExecContextHeader(knowledgeExecContextHeader(DAEMON_KNOWLEDGE_TURN.execContext))).toEqual({
      v: 1,
      speaker: { kind: "terminal" },
      conversation: "terminal",
    });
  });

  it("a 404 with no CLI error body is KNOWLEDGE_UNAVAILABLE", async () => {
    const console = fakeConsole(() => new Response("Not Found", { status: 404 }));
    const client = await openKnowledgeClient({ readCredentials: () => credentials(), fetch: console.fetch });
    const error = await capture(client!.search({ query: "x" }, OPERATOR_TURN));
    expect(isCloudAuthError(error) && error.code).toBe("KNOWLEDGE_UNAVAILABLE");
    expect(isConsoleUnavailable(error)).toBe(true);
  });

  it("a 404 carrying NOT_FOUND stays NOT_FOUND (not unavailable)", async () => {
    const console = fakeConsole(() => json({ error: { code: "NOT_FOUND", message: "no such ref" } }, 404));
    const client = await openKnowledgeClient({ readCredentials: () => credentials(), fetch: console.fetch });
    const error = await capture(client!.read({ ref: "kc:missing" }, OPERATOR_TURN));
    expect(isCloudAuthError(error) && error.code).toBe("NOT_FOUND");
    expect(isConsoleUnavailable(error)).toBe(false);
  });

  it("a 403 KNOWLEDGE_DISABLED keeps its code", async () => {
    const console = fakeConsole(() => json({ error: { code: "KNOWLEDGE_DISABLED", message: "off" } }, 403));
    const client = await openKnowledgeClient({ readCredentials: () => credentials(), fetch: console.fetch });
    const error = await capture(client!.sources({}, OPERATOR_TURN));
    expect(isCloudAuthError(error) && error.code).toBe("KNOWLEDGE_DISABLED");
    expect(isConsoleUnavailable(error)).toBe(false);
  });

  it("refreshes once on AUTH_EXPIRED and retries with the new token", async () => {
    let refreshes = 0;
    const console = fakeConsole((call) => {
      if (call.path === "/api/cli/auth/refresh") {
        refreshes += 1;
        return json({ accessToken: "access-2", refreshToken: "refresh-2" });
      }
      if (call.headers.get("authorization") !== "Bearer access-2") {
        return json({ error: { code: "AUTH_EXPIRED", message: "expired" } }, 401);
      }
      return json({ marks: [], card: null });
    });
    let stored: CloudCredentials | null = credentials();
    const client = await openKnowledgeClient({
      readCredentials: () => stored,
      writeCredentials: (next) => {
        stored = next;
      },
      deleteCredentials: () => {
        stored = null;
      },
      fetch: console.fetch,
    });
    expect(await client?.marks({ url: "https://acme.ravi.page/faq" }, OPERATOR_TURN)).toEqual({
      marks: [],
      card: null,
    });
    expect(refreshes).toBe(1);
    expect(stored?.refreshToken).toBe("refresh-2");
    expect(console.calls.map((call) => call.path)).toEqual([
      "/api/cli/knowledge/marks",
      "/api/cli/auth/refresh",
      "/api/cli/knowledge/marks",
    ]);
  });

  it("does not refresh twice when the retry is still expired", async () => {
    let refreshes = 0;
    const console = fakeConsole((call) => {
      if (call.path === "/api/cli/auth/refresh") {
        refreshes += 1;
        return json({ accessToken: "access-2", refreshToken: "refresh-2" });
      }
      return json({ error: { code: "AUTH_EXPIRED", message: "expired" } }, 401);
    });
    let stored: CloudCredentials | null = credentials();
    const client = await openKnowledgeClient({
      readCredentials: () => stored,
      writeCredentials: (next) => {
        stored = next;
      },
      deleteCredentials: () => {
        stored = null;
      },
      fetch: console.fetch,
    });
    const error = await capture(client!.digest({}, OPERATOR_TURN));
    expect(isCloudAuthError(error) && error.code).toBe("AUTH_EXPIRED");
    expect(refreshes).toBe(1);
  });
});
