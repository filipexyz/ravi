import { describe, expect, it } from "bun:test";

import { ConsoleApiClient } from "../cloud-auth/client.js";
import { CloudAuthError } from "../cloud-auth/errors.js";
import type { CloudCredentials } from "../cloud-auth/types.js";
import type { AccessActorDecision } from "./actor.js";
import {
  AccessActorRefusedError,
  accessDryRunPlan,
  buildAccessRequestBody,
  buildShareBody,
  createAccessRequest,
  createInvite,
  describeAccessFailure,
  getAccessRequest,
  listInvites,
  listPageAccess,
  normalizeAccessEmail,
  normalizeAccessExpiry,
  normalizeAccessUrl,
  normalizeOrganizationRole,
  revokeInvite,
  sharePageAccess,
  unsharePageAccess,
  type AccessDeps,
  type AccessGrant,
} from "./client.js";

const OPERATOR: AccessActorDecision = { kind: "operator", agent: { id: "main", name: "Main" } };
const CONTACT: AccessActorDecision = { kind: "contact", contactId: "c_ana", agent: { id: "main" } };
const NOW = new Date("2026-10-13T12:00:00.000Z");

interface Call {
  method: string;
  path: string;
  body: unknown;
  authorization: string | null;
}

function consoleFetch(routes: Record<string, (body: unknown) => { status?: number; json: unknown }>) {
  const calls: Call[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    if (url.pathname === "/api/cli/me") {
      return Response.json({ user: { id: "user_1", email: "alice@example.com" }, organization: { id: "org_1" } });
    }
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({
      method: init?.method ?? "GET",
      path: url.pathname,
      body,
      authorization: headers.get("authorization"),
    });
    const route = routes[`${init?.method ?? "GET"} ${url.pathname}`];
    if (!route) return Response.json({ error: { code: "NOT_FOUND", message: "no", requestId: "r" } }, { status: 404 });
    const answer = route(body);
    return Response.json(answer.json, { status: answer.status ?? 200 });
  };
  const client = new ConsoleApiClient({
    consoleUrl: "https://console.example",
    fetch: fetch as typeof globalThis.fetch,
  });
  return { calls, client };
}

function deps(client: ConsoleApiClient, actor: AccessActorDecision = OPERATOR): AccessDeps {
  return { client, readCredentials: () => makeCredentials(), actor, now: () => NOW };
}

function grantJson(overrides: Record<string, unknown> = {}): AccessGrant {
  return {
    id: "grant_1",
    email: "ana@example.com",
    name: "Ana",
    userId: "user_ana",
    scope: "route",
    routeId: "route_1",
    routePath: "/report",
    url: "https://acme.ravi.page/report",
    expiresAt: "2026-11-12T12:00:00.000Z",
    createdAt: "2026-10-13T12:00:00.000Z",
    createdBy: "Alice",
    ...overrides,
  } as AccessGrant;
}

describe("input normalization", () => {
  it("normalizes page URLs, emails and roles", () => {
    expect(normalizeAccessUrl("acme.ravi.page/report#x")).toBe("https://acme.ravi.page/report");
    expect(normalizeAccessUrl("https://docs.acme.com/a?b=1")).toBe("https://docs.acme.com/a?b=1");
    expect(() => normalizeAccessUrl("ftp://acme.ravi.page/")).toThrow(CloudAuthError);
    expect(() => normalizeAccessUrl("https://u:p@acme.ravi.page/")).toThrow(/Invalid <url>/);
    expect(() => normalizeAccessUrl(" ")).toThrow(/Missing <url>/);
    expect(normalizeAccessEmail(" Ana@Example.COM ")).toBe("ana@example.com");
    expect(() => normalizeAccessEmail("ana")).toThrow(/--with must be an email/);
    expect(normalizeOrganizationRole(undefined)).toBeUndefined();
    expect(normalizeOrganizationRole("Developer")).toBe("developer");
    expect(() => normalizeOrganizationRole("member")).toThrow(/viewer, developer, admin, billing, owner/);
  });

  it("turns --expires durations and dates into an ISO date within 365 days", () => {
    expect(normalizeAccessExpiry("30d", NOW)).toBe("2026-11-12T12:00:00.000Z");
    expect(normalizeAccessExpiry("12h", NOW)).toBe("2026-10-14T00:00:00.000Z");
    expect(normalizeAccessExpiry("2w", NOW)).toBe("2026-10-27T12:00:00.000Z");
    expect(normalizeAccessExpiry("2026-12-31", NOW)).toBe("2026-12-31T23:59:59.000Z");
    expect(normalizeAccessExpiry("2027-01-01T10:00:00-03:00", NOW)).toBe("2027-01-01T13:00:00.000Z");
    expect(normalizeAccessExpiry(undefined, NOW)).toBeUndefined();
    expect(() => normalizeAccessExpiry("366d", NOW)).toThrow(/at most 365 days/);
    expect(() => normalizeAccessExpiry("2026-01-01", NOW)).toThrow(/in the future/);
    expect(() => normalizeAccessExpiry("next week", NOW)).toThrow(/--expires must be a duration/);
  });
});

describe("request building and actor", () => {
  it("adds actor only for a contact, and the agent only to access requests", () => {
    const options = { url: "acme.ravi.page/report", email: "Ana@example.com", site: true, reason: "Board" };
    expect(buildShareBody(options, OPERATOR)).toEqual({
      url: "https://acme.ravi.page/report",
      email: "ana@example.com",
      site: true,
      reason: "Board",
    });
    expect(buildShareBody(options, CONTACT)).toMatchObject({ actor: { contactId: "c_ana" } });
    expect(buildAccessRequestBody({ url: "https://other.ravi.page/x", message: "Q3" }, OPERATOR)).toEqual({
      url: "https://other.ravi.page/x",
      message: "Q3",
      agent: { id: "main", name: "Main" },
    });
    expect(buildAccessRequestBody({ url: "https://other.ravi.page/x" }, CONTACT)).toEqual({
      url: "https://other.ravi.page/x",
      agent: { id: "main" },
      actor: { contactId: "c_ana" },
    });
  });

  it("shows the page and who acts in the dry-run plan, never the raw actor", () => {
    const plan = accessDryRunPlan(
      buildShareBody({ url: "https://acme.ravi.page/r", email: "a@b.co" }, CONTACT),
      CONTACT,
    );
    expect(plan).toEqual({
      page: "https://acme.ravi.page/r",
      email: "a@b.co",
      actingAs: expect.stringContaining("contact c_ana"),
    });
  });

  it("refuses an unattributable turn before any Console call", async () => {
    const { calls, client } = consoleFetch({});
    const refused: AccessActorDecision = { kind: "refused", message: "who?", actorPrincipal: "unknown" };
    await expect(
      sharePageAccess({ url: "https://acme.ravi.page/r", email: "a@b.co" }, deps(client, refused)),
    ).rejects.toBeInstanceOf(AccessActorRefusedError);
    await expect(
      createAccessRequest({ url: "https://acme.ravi.page/r" }, deps(client, refused)),
    ).rejects.toBeInstanceOf(AccessActorRefusedError);
    expect(calls).toEqual([]);
  });

  it("lists invites only for the operator: the GET route carries no actor", async () => {
    const { calls, client } = consoleFetch({ "GET /api/cli/access/invites": () => ({ json: { invites: [] } }) });
    await expect(listInvites({}, deps(client, CONTACT))).rejects.toThrow(/Only the operator can list/);
    expect(calls).toEqual([]);
    const result = await listInvites({}, deps(client));
    expect(result).toMatchObject({ success: true, total: 0, invites: [] });
    expect(calls).toEqual([
      { method: "GET", path: "/api/cli/access/invites", body: undefined, authorization: "Bearer access-secret" },
    ]);
  });
});

describe("Console calls", () => {
  it("shares a page and normalizes the grant", async () => {
    const { calls, client } = consoleFetch({
      "POST /api/cli/access/pages/share": () => ({
        status: 201,
        json: { created: true, userCreated: true, grant: grantJson() },
      }),
    });
    const result = await sharePageAccess(
      { url: "https://acme.ravi.page/report", email: "ana@example.com", expiresAt: "2026-11-12T12:00:00.000Z" },
      deps(client, CONTACT),
    );
    expect(calls[0]).toEqual({
      method: "POST",
      path: "/api/cli/access/pages/share",
      body: {
        url: "https://acme.ravi.page/report",
        email: "ana@example.com",
        expiresAt: "2026-11-12T12:00:00.000Z",
        actor: { contactId: "c_ana" },
      },
      authorization: "Bearer access-secret",
    });
    expect(result).toEqual({
      success: true,
      consoleUrl: "https://console.example",
      actedBy: { kind: "contact", contactId: "c_ana" },
      created: true,
      userCreated: true,
      grant: grantJson(),
    });
  });

  it("unshares by URL and email or by grant id", async () => {
    const { calls, client } = consoleFetch({
      "POST /api/cli/access/pages/unshare": () => ({ json: { revoked: true } }),
    });
    expect(
      await unsharePageAccess({ url: "https://acme.ravi.page/", email: "ana@example.com", site: true }, deps(client)),
    ).toMatchObject({ revoked: true, actedBy: { kind: "operator" } });
    await unsharePageAccess({ grantId: "grant_1" }, deps(client, CONTACT));
    expect(calls.map((call) => call.body)).toEqual([
      { url: "https://acme.ravi.page/", email: "ana@example.com", site: true },
      { grantId: "grant_1", actor: { contactId: "c_ana" } },
    ]);
  });

  it("lists who has access on the page's site", async () => {
    const { calls, client } = consoleFetch({
      "POST /api/cli/access/pages/access": () => ({
        json: {
          site: { id: "site_1", host: "acme.ravi.page" },
          grants: [grantJson(), grantJson({ id: "grant_2", scope: "site", routeId: null, routePath: null })],
        },
      }),
    });
    const result = await listPageAccess({ url: "https://acme.ravi.page/report" }, deps(client));
    expect(calls[0]?.body).toEqual({ url: "https://acme.ravi.page/report" });
    expect(result.site).toEqual({ id: "site_1", host: "acme.ravi.page" });
    expect(result.total).toBe(2);
    expect(result.grants[1]).toMatchObject({ scope: "site", routeId: null, routePath: null });
  });

  it("creates and revokes invites", async () => {
    const invite = {
      id: "inv_1",
      email: "bia@example.com",
      role: "developer",
      createdAt: "2026-10-13T12:00:00.000Z",
      expiresAt: "2026-10-20T12:00:00.000Z",
      invitedBy: "Alice",
    };
    const { calls, client } = consoleFetch({
      "POST /api/cli/access/invites/create": () => ({
        status: 201,
        json: { invite, url: "https://console.example/invite/rvinv_secret" },
      }),
      "POST /api/cli/access/invites/revoke": () => ({ json: { revoked: true } }),
    });
    const created = await createInvite(
      { email: "Bia@example.com", role: "developer", reason: "Data team" },
      deps(client, CONTACT),
    );
    expect(created).toMatchObject({ invite, url: "https://console.example/invite/rvinv_secret" });
    await revokeInvite({ inviteId: "inv_1" }, deps(client));
    expect(calls.map((call) => [call.path, call.body])).toEqual([
      [
        "/api/cli/access/invites/create",
        { email: "bia@example.com", role: "developer", reason: "Data team", actor: { contactId: "c_ana" } },
      ],
      ["/api/cli/access/invites/revoke", { inviteId: "inv_1" }],
    ]);
  });

  it("asks for access and builds the forwardable approval link", async () => {
    const request = {
      id: "req_1",
      status: "pending",
      url: "https://console.example/access/requests/req_1",
      path: "/x",
      host: "other.ravi.page",
      createdAt: "2026-10-13T12:00:00.000Z",
      expiresAt: "2026-11-12T12:00:00.000Z",
      decidedAt: null,
    };
    const { calls, client } = consoleFetch({
      "POST /api/cli/access/requests/create": () => ({ status: 201, json: { request } }),
      "GET /api/cli/access/requests/req_1": () => ({ json: { request } }),
    });
    const created = await createAccessRequest({ url: "https://other.ravi.page/x", message: "Q3" }, deps(client));
    expect(created).toMatchObject({
      status: "requested",
      request,
      approvalUrl: "https://console.example/access/requests/req_1",
      approvalNote: expect.stringContaining("only the page's managers can approve"),
    });
    expect(calls[0]?.body).toEqual({
      url: "https://other.ravi.page/x",
      message: "Q3",
      agent: { id: "main", name: "Main" },
    });
    const status = await getAccessRequest({ requestId: "req_1" }, deps(client, CONTACT));
    expect(status).toMatchObject({ request, approvalUrl: "https://console.example/access/requests/req_1" });
  });

  it("reports already_allowed without a request", async () => {
    const { client } = consoleFetch({
      "POST /api/cli/access/requests/create": () => ({
        json: { status: "already_allowed", url: "https://other.ravi.page/x" },
      }),
    });
    expect(await createAccessRequest({ url: "https://other.ravi.page/x" }, deps(client))).toEqual({
      success: true,
      consoleUrl: "https://console.example",
      actedBy: { kind: "operator" },
      status: "already_allowed",
      url: "https://other.ravi.page/x",
    });
  });
});

describe("describeAccessFailure", () => {
  async function consoleError(status: number, code: string, details?: Record<string, unknown>) {
    const { client } = consoleFetch({
      "POST /api/cli/access/pages/share": () => ({
        status,
        json: { error: { code, message: "remote text", requestId: "req", ...(details ? { details } : {}) } },
      }),
    });
    try {
      await sharePageAccess({ url: "https://acme.ravi.page/r", email: "a@b.co" }, deps(client, CONTACT));
    } catch (error) {
      return error;
    }
    throw new Error("expected a Console error");
  }

  it("maps ACTOR_NOT_LINKED to a policy block that says to send ravi link", async () => {
    const error = await consoleError(403, "ACTOR_NOT_LINKED");
    expect(error).toBeInstanceOf(CloudAuthError);
    expect((error as CloudAuthError).code).toBe("ACTOR_NOT_LINKED");
    const failure = describeAccessFailure(error, "pages share");
    expect(failure).toMatchObject({ code: "ACTOR_NOT_LINKED", exitCode: 3 });
    expect(failure?.message).toContain("ravi link");
  });

  it("maps role, organization, not-found and conflict refusals", async () => {
    expect(describeAccessFailure(await consoleError(403, "PROJECT_ACCESS_DENIED"), "pages share")).toMatchObject({
      code: "PROJECT_ACCESS_DENIED",
      exitCode: 1,
    });
    const org = describeAccessFailure(await consoleError(403, "ORG_ACCESS_DENIED"), "pages share");
    expect(org?.details.suggestedAction).toContain("ravi access request");
    const route = describeAccessFailure(
      await consoleError(404, "NOT_FOUND", { reason: "route_not_found" }),
      "pages share",
    );
    expect(route?.message).toContain("--site");
    expect(
      describeAccessFailure(new CloudAuthError("CONFLICT", "already_member", { status: 409 }), "invites create"),
    ).toMatchObject({ code: "CONFLICT", message: expect.stringContaining("already belongs") });
    expect(describeAccessFailure(new CloudAuthError("RATE_LIMITED", "slow"), "access request")).toBeNull();
    expect(describeAccessFailure(new AccessActorRefusedError("who?", "unknown"), "invites list")).toMatchObject({
      code: "ACTOR_UNKNOWN",
      exitCode: 3,
    });
  });
});

function makeCredentials(): CloudCredentials {
  return {
    version: 1,
    consoleUrl: "https://console.example",
    installationId: "ins_123",
    accessToken: "access-secret",
    refreshToken: "refresh-secret",
    accessTokenExpiresAt: "2099-05-10T00:00:00.000Z",
    refreshTokenExpiresAt: "2099-06-10T00:00:00.000Z",
    scopes: ["console.projects.read", "artifacts.publish"],
    user: { id: "user_1", email: "alice@example.com" },
    organization: { id: "org_1", name: "Acme" },
    createdAt: "2026-05-09T00:00:00.000Z",
    updatedAt: "2026-05-09T00:00:00.000Z",
  };
}
