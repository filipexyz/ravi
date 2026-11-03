import { describe, expect, test } from "bun:test";

import { CLI_ACTOR_CONTACT_HEADER, resolveCliActor, type CliActorDeps } from "@/server/cli/actor";
import type { CliAuthContext } from "@/server/cli/auth";
import { CliApiError } from "@/server/cli/errors";
import type { CliAuthRecords } from "@/server/cli/state";
import { ConsoleApiError } from "@/server/console/api-error";
import type { getConsoleFeatureAccessForOrganizationRole } from "@/server/console/feature-access";

import { basesCliAccess, basesCliActorOptions, basesCliError, basesCliScopeFor, handleBasesCliRequest, BASES_CLI_READ_SCOPE, BASES_CLI_WRITE_SCOPE } from "./cli";
import type { BasesHttpRequest } from "./http";

const ORG = "0d0d0d0d-0000-4000-8000-000000000001";
const USER = "0d0d0d0d-0000-4000-8000-000000000002";
const INSTALLATION = "0d0d0d0d-0000-4000-8000-000000000003";
const VIEW = "0d0d0d0d-0000-4000-8000-000000000004";

function auth(scopes: string[], role = "developer") {
  return {
    user: { id: USER, primaryEmail: "dev@example.com" },
    organization: { id: ORG, slug: "acme" },
    membership: { role },
    localInstallation: { id: INSTALLATION },
    // authenticateCliRequest always carries the verified session and token id.
    cliSession: { id: "cli-session-1" },
    accessTokenJti: "jti-1",
    scopes,
  } as unknown as CliAuthContext;
}

function featureAccess(state: { available: boolean; authorized: boolean }) {
  return async () =>
    ({ byKey: { "console.bases": { ...state, enabled: state.available && state.authorized } } }) as unknown as Awaited<ReturnType<typeof getConsoleFeatureAccessForOrganizationRole>>;
}

async function cliErrorOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CliApiError) return error;
    throw error;
  }
  throw new Error("expected a CliApiError");
}

function request(overrides: Partial<Parameters<typeof handleBasesCliRequest>[0]> = {}) {
  return {
    auth: auth([BASES_CLI_READ_SCOPE, BASES_CLI_WRITE_SCOPE]),
    requestId: "req-1",
    method: "POST",
    projectRef: "web",
    segments: ["crm", "rows"],
    body: { values: {}, clientHint: { agentId: "main", secret: "x" } },
    searchParams: new URLSearchParams(),
    idempotencyKey: "row-create-1",
    ...overrides,
  };
}

describe("scopes", () => {
  test("reads: GET plus query, aggregate, and chart data POSTs", () => {
    expect(basesCliScopeFor("GET", [])).toBe(BASES_CLI_READ_SCOPE);
    expect(basesCliScopeFor("GET", ["crm", "rows", "r", "history"])).toBe(BASES_CLI_READ_SCOPE);
    expect(basesCliScopeFor("POST", ["crm", "rows", "query"])).toBe(BASES_CLI_READ_SCOPE);
    expect(basesCliScopeFor("POST", ["crm", "rows", "aggregate"])).toBe(BASES_CLI_READ_SCOPE);
    expect(basesCliScopeFor("POST", ["crm", "views", "v", "query"])).toBe(BASES_CLI_READ_SCOPE);
    expect(basesCliScopeFor("POST", ["crm", "charts", "c", "data"])).toBe(BASES_CLI_READ_SCOPE);
  });

  test("everything else writes", () => {
    expect(basesCliScopeFor("POST", [])).toBe(BASES_CLI_WRITE_SCOPE);
    expect(basesCliScopeFor("POST", ["query"])).toBe(BASES_CLI_WRITE_SCOPE);
    expect(basesCliScopeFor("POST", ["crm", "rows"])).toBe(BASES_CLI_WRITE_SCOPE);
    expect(basesCliScopeFor("PATCH", ["crm", "rows", "r"])).toBe(BASES_CLI_WRITE_SCOPE);
    expect(basesCliScopeFor("POST", ["crm", "subscriptions"])).toBe(BASES_CLI_WRITE_SCOPE);
  });

  test("view version reads", () => {
    expect(basesCliScopeFor("POST", ["crm", "views", "v", "version"])).toBe(BASES_CLI_READ_SCOPE);
  });
});

describe("basesCliAccess", () => {
  test("reads: GET and the read-only POST paths", () => {
    expect(basesCliAccess("GET", [])).toBe("read");
    expect(basesCliAccess("get", ["crm", "activity"])).toBe("read");
    expect(basesCliAccess("POST", ["crm", "rows", "query"])).toBe("read");
    expect(basesCliAccess("POST", ["crm", "rows", "aggregate"])).toBe("read");
    expect(basesCliAccess("POST", ["crm", "views", "v", "query"])).toBe("read");
    expect(basesCliAccess("POST", ["crm", "views", "v", "version"])).toBe("read");
    expect(basesCliAccess("POST", ["crm", "charts", "c", "data"])).toBe("read");
  });

  test("writes: every other POST and PATCH, matched on the exact path shape", () => {
    expect(basesCliAccess("POST", ["crm", "rows"])).toBe("write");
    expect(basesCliAccess("POST", ["crm", "rows", "r", "archive"])).toBe("write");
    expect(basesCliAccess("POST", ["crm", "rows", "r", "agent", "score"])).toBe("write");
    expect(basesCliAccess("POST", ["crm", "views", "v", "rows"])).toBe("write");
    expect(basesCliAccess("POST", ["crm", "subscriptions"])).toBe("write");
    expect(basesCliAccess("PATCH", ["crm", "rows", "query"])).toBe("write");
    // A row or property literally named like a read action is still a write path.
    expect(basesCliAccess("POST", ["crm", "rows", "r", "query"])).toBe("write");
    expect(basesCliAccess("POST", ["crm", "properties", "query"])).toBe("write");
    expect(basesCliAccess("POST", ["crm", "views", "v", "rows", "r", "query"])).toBe("write");
    expect(basesCliAccess("POST", ["query"])).toBe("write");
    expect(basesCliAccess("DELETE", ["crm"])).toBe("write");
  });
});

describe("CLI requests", () => {
  test("a missing scope is PROJECT_ACCESS_DENIED", async () => {
    const error = await cliErrorOf(
      handleBasesCliRequest(request({ auth: auth([BASES_CLI_READ_SCOPE]) }), {
        featureAccess: featureAccess({ available: true, authorized: true }),
        handle: async () => ({ status: 200, payload: {} }),
      }),
    );
    expect(error.status).toBe(403);
    expect(error.code).toBe("PROJECT_ACCESS_DENIED");
  });

  test("the console.bases feature gates the CLI", async () => {
    const unavailable = await cliErrorOf(
      handleBasesCliRequest(request(), { featureAccess: featureAccess({ available: false, authorized: true }) }),
    );
    expect(unavailable.code).toBe("ORG_ACCESS_DENIED");
    expect(unavailable.details).toEqual({ error: "feature_unavailable" });
    const forbidden = await cliErrorOf(
      handleBasesCliRequest(request(), { featureAccess: featureAccess({ available: true, authorized: false }) }),
    );
    expect(forbidden.details).toEqual({ error: "feature_forbidden" });
  });

  test("builds the CLI caller and the project-access workspace", async () => {
    let seen: BasesHttpRequest | null = null;
    const result = await handleBasesCliRequest(request(), {
      featureAccess: featureAccess({ available: true, authorized: true }),
      handle: async (input) => {
        seen = input;
        return { status: 201, payload: { ok: true } };
      },
    });
    expect(result).toEqual({ status: 201, payload: { ok: true } });
    const captured = seen as BasesHttpRequest | null;
    expect(captured?.caller).toMatchObject({
      actorType: "cli",
      surface: "cli",
      localInstallationId: INSTALLATION,
      clientHint: { agentId: "main" },
      source: { kind: "local_installation", id: INSTALLATION },
    });
    // Project access for the workspace is decided for the installation, never the person alone.
    expect(captured?.workspace).toEqual({ user: { id: USER }, organization: { id: ORG }, membership: { role: "developer" },
      authorization: { installationId: INSTALLATION, sessionId: "cli-session-1", bindingId: null, accessTokenJti: "jti-1" } });
    expect(captured?.idempotencyKey).toBe("row-create-1");
  });
});

describe("error mapping", () => {
  const map = (status: number, error: string, extra: Record<string, unknown> = {}) =>
    basesCliError(new ConsoleApiError(status, { error, ...extra } as ConsoleApiError["payload"]));

  test("maps Bases errors to CLI codes and keeps the body as details", () => {
    expect(map(404, "not_found").code).toBe("NOT_FOUND");
    expect(map(409, "version_conflict").code).toBe("VERSION_CONFLICT");
    expect(map(409, "schema_version_conflict").code).toBe("VERSION_CONFLICT");
    expect(map(409, "write_escapes_view").code).toBe("CONFLICT");
    expect(map(409, "idempotency_conflict").code).toBe("CONFLICT");
    expect(map(403, "feature_unavailable").code).toBe("ORG_ACCESS_DENIED");
    expect(map(403, "base_forbidden").code).toBe("PROJECT_ACCESS_DENIED");
    expect(map(400, "validation_failed").code).toBe("PAYLOAD_INVALID");
    expect(map(413, "payload_too_large").code).toBe("PAYLOAD_INVALID");
    expect(map(422, "unprocessable").code).toBe("PAYLOAD_INVALID");
    expect(map(503, "query_timeout").code).toBe("SERVER_UNAVAILABLE");
    const conflict = map(409, "version_conflict", { reason: "The row changed.", current: { rowId: "r", version: 3, values: {} } });
    expect(conflict.status).toBe(409);
    expect(conflict.message).toBe("The row changed.");
    expect(conflict.details).toEqual({ error: "version_conflict", reason: "The row changed.", current: { rowId: "r", version: 3, values: {} } });
  });
});

describe("delegated unlinked contacts on the Bases CLI route", () => {
  const NOW = new Date("2026-10-18T12:00:00.000Z");
  const records = {
    user: { id: "user-owner", primaryEmail: "owner@ravi.bot", displayName: "Owner", avatarUrl: null, status: "active" },
    organization: { id: "org-1", slug: "ravi", name: "Ravi", status: "active" },
    membership: { id: "membership-owner", role: "owner", status: "active" },
    localInstallation: { id: "installation-1", name: "Mac", hostname: null, platform: null, raviVersion: null, status: "active", lastSeenAt: NOW },
    cliSession: { id: "session-1", status: "active", expiresAt: NOW, lastUsedAt: null },
    scopes: [BASES_CLI_READ_SCOPE, BASES_CLI_WRITE_SCOPE],
  } as unknown as CliAuthRecords;
  const unlinked: CliActorDeps = { findBinding: async () => null, findMember: async () => null, audit: async () => {} };

  const linked: CliActorDeps = {
    findBinding: async () => ({ id: "binding-ana", consoleUserId: "user-ana", linkedBy: "user-ana" }),
    findMember: async () => ({
      user: { id: "user-ana", primaryEmail: "ana@ravi.bot", displayName: "Ana", avatarUrl: null, status: "active" },
      membership: { id: "membership-ana", role: "developer", status: "active" },
    }),
    audit: async () => {},
  };

  async function resolve(method: string, segments: string[], contact: string | null = "c_bob", deps = unlinked) {
    const headers: Record<string, string> = contact ? { [CLI_ACTOR_CONTACT_HEADER]: contact } : {};
    const request = new Request("https://console.ravi.bot/api/cli/projects/p/bases/x", { method, headers });
    try {
      const actor = await resolveCliActor(records, request, "req-1", deps, basesCliActorOptions(method, segments));
      return { ok: true as const, userId: actor.user.id };
    } catch (error) {
      return { ok: false as const, code: (error as CliApiError).code };
    }
  }

  test("reads and writes alike refuse an unlinked person: nothing runs as the executor", async () => {
    for (const [method, segments] of [
      ["POST", ["crm", "rows", "query"]],
      ["POST", ["crm", "rows", "aggregate"]],
      ["POST", ["crm", "views", VIEW, "query"]],
      ["POST", ["crm", "views", VIEW, "version"]],
      ["POST", ["crm", "charts", VIEW, "data"]],
      ["GET", ["crm", "views", VIEW]],
      ["GET", []],
      ["POST", ["crm", "rows"]],
      ["PATCH", ["crm", "rows", VIEW]],
      ["POST", ["crm", "views", VIEW, "rows"]],
      ["POST", ["crm", "rows", VIEW, "agent", "summary"]],
      ["POST", ["crm", "subscriptions"]],
    ] as const) {
      expect(await resolve(method, [...segments])).toEqual({ ok: false, code: "ACTOR_NOT_LINKED" });
    }
  });

  test("a linked member reads as themselves; the operator's own turn reads as the operator", async () => {
    expect(await resolve("POST", ["crm", "rows", "query"], "c_ana", linked)).toEqual({ ok: true, userId: "user-ana" });
    expect(await resolve("GET", ["crm", "views", VIEW], "c_ana", linked)).toEqual({ ok: true, userId: "user-ana" });
    expect(await resolve("POST", ["crm", "rows", "query"], null)).toEqual({ ok: true, userId: "user-owner" });
    expect(await resolve("GET", [], null)).toEqual({ ok: true, userId: "user-owner" });
  });
});
