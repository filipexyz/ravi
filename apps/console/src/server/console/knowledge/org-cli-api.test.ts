import { describe, expect, test } from "bun:test";

import type { CliAuthContext } from "@/server/cli/auth";
import { CliApiError } from "@/server/cli/errors";
import { ConsoleApiError } from "@/server/console/api-error";
import { resolveConsoleFeatureAccess } from "@/server/console/feature-access";

import type { KnowledgeF2HandlerInput } from "./f2-cli";
import {
  handleKnowledgeOrgCli,
  knowledgeOrgCliError,
  respondKnowledgeOrgCli,
  resultHead,
  resultLocation,
  type KnowledgeOrgCliDeps,
  type KnowledgeOrgCliInput,
} from "./org-cli-api";
import type { KnowledgeChunkRow, KnowledgeRunInput } from "./retrieval-core";

const READ = "console.knowledge.read";
const WRITE = "console.knowledge.write";

const enabled = async ({ organizationId, role }: { organizationId: string; role: string }) =>
  resolveConsoleFeatureAccess({
    organizationId,
    plan: "free",
    role,
    entitlements: [{ key: "console.knowledge", source: "manual", startsAt: null, endsAt: null, valueJson: {} }],
  });
const disabled = async ({ organizationId, role }: { organizationId: string; role: string }) =>
  resolveConsoleFeatureAccess({ organizationId, plan: "free", role, entitlements: [] });

function auth(scopes: string[] = [READ, WRITE], role = "owner"): CliAuthContext {
  return {
    accessTokenJti: "jti_1",
    user: { id: "user_1", primaryEmail: "dev@ravi.bot", displayName: "Dev", avatarUrl: null, status: "active" },
    organization: { id: "org_1", slug: "ravi", name: "Ravi", status: "active" },
    membership: { id: "membership_1", role, status: "active" },
    localInstallation: {
      id: "installation_1",
      name: "CLI",
      hostname: null,
      platform: null,
      raviVersion: null,
      status: "active",
      lastSeenAt: new Date("2026-10-17T12:00:00.000Z"),
    },
    cliSession: { id: "session_1", status: "active", expiresAt: new Date("2026-10-17T12:15:00.000Z"), lastUsedAt: null },
    scopes,
  };
}

function input(overrides: Partial<KnowledgeOrgCliInput> = {}): KnowledgeOrgCliInput {
  return {
    method: "GET",
    auth: auth(),
    segments: ["digest"],
    searchParams: new URLSearchParams(),
    body: {},
    headers: new Headers(),
    requestId: "req_1",
    requestUrl: "https://console.test/api/cli/knowledge/digest",
    ...overrides,
  };
}

function encode(value: unknown) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function deps(overrides: KnowledgeOrgCliDeps = {}): KnowledgeOrgCliDeps & { calls: KnowledgeF2HandlerInput[]; denied: KnowledgeRunInput[] } {
  const calls: KnowledgeF2HandlerInput[] = [];
  const denied: KnowledgeRunInput[] = [];
  const f2 = async (call: KnowledgeF2HandlerInput) => {
    calls.push(call);
    return { status: 200, payload: { ok: true, segments: call.segments } };
  };
  return {
    calls,
    denied,
    featureAccess: enabled,
    writeDeniedRun: async (run) => {
      denied.push(run);
      return { runId: "denied" };
    },
    f2: { "proposals.create": f2, "proposals.get": f2, digest: f2, mirror: f2, marks: f2 },
    ...overrides,
  };
}

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a failure");
}

describe("handleKnowledgeOrgCli routing", () => {
  test("routes the F2 segments to K-C4's handlers with the caller and requestUrl", async () => {
    const d = deps();
    const routes: Array<[KnowledgeOrgCliInput["method"], string[]]> = [
      ["POST", ["proposals"]],
      ["GET", ["proposals", "p_1"]],
      ["GET", ["digest"]],
      ["POST", ["mirror"]],
      ["GET", ["marks"]],
    ];
    for (const [method, segments] of routes) {
      const result = await handleKnowledgeOrgCli(input({ method, segments }), d);
      expect(result).toEqual({ status: 200, payload: { ok: true, segments } });
    }
    expect(d.calls).toHaveLength(5);
    expect(d.calls[0]).toMatchObject({
      caller: { audience: "operator", localInstallationId: "installation_1" },
      requestUrl: "https://console.test/api/cli/knowledge/digest",
      requestId: "req_1",
    });
  });

  test("an unknown segment or method is 404 PAYLOAD_INVALID, before any gate", async () => {
    for (const [method, segments] of [
      ["GET", ["nope"]],
      ["GET", ["search"]],
      ["POST", ["runs"]],
      ["GET", []],
      ["GET", ["runs", "x", "y"]],
    ] as const) {
      const error = await failure(handleKnowledgeOrgCli(input({ method, segments: [...segments] }), deps({ featureAccess: disabled })));
      expect(error).toBeInstanceOf(CliApiError);
      expect(error).toMatchObject({ status: 404, code: "PAYLOAD_INVALID", message: "Unknown Knowledge CLI route." });
    }
  });
});

describe("handleKnowledgeOrgCli gates", () => {
  test("missing scope is 403 ORG_ACCESS_DENIED with the scope", async () => {
    const read = await failure(handleKnowledgeOrgCli(input({ auth: auth([WRITE]) }), deps()));
    expect(read).toMatchObject({ status: 403, code: "ORG_ACCESS_DENIED", details: { reason: "missing_scope", scope: READ } });
    const write = await failure(handleKnowledgeOrgCli(input({ auth: auth([READ]), method: "POST", segments: ["mirror"] }), deps()));
    expect(write).toMatchObject({ status: 403, code: "ORG_ACCESS_DENIED", details: { reason: "missing_scope", scope: WRITE } });
  });

  test("without the entitlement: 403 KNOWLEDGE_DISABLED feature_unavailable", async () => {
    const error = await failure(handleKnowledgeOrgCli(input(), deps({ featureAccess: disabled })));
    expect(error).toMatchObject({ status: 403, code: "KNOWLEDGE_DISABLED", details: { reason: "feature_unavailable" } });
  });

  test("a billing role is refused by the feature gate", async () => {
    const error = await failure(handleKnowledgeOrgCli(input({ auth: auth([READ], "billing") }), deps()));
    expect(error).toMatchObject({ status: 403, code: "KNOWLEDGE_DISABLED", details: { reason: "feature_forbidden" } });
  });

  test("a non-operator turn is 403 KNOWLEDGE_TURN_NOT_OPERATOR with a denied run", async () => {
    const d = deps();
    const headers = new Headers({ "x-ravi-exec-context": encode({ v: 1, speaker: { kind: "owner" }, conversation: "group" }) });
    const error = await failure(handleKnowledgeOrgCli(input({ headers }), d));
    expect(error).toMatchObject({ status: 403, code: "KNOWLEDGE_TURN_NOT_OPERATOR", details: { reason: "audience" } });
    expect(d.denied).toHaveLength(1);
    expect(d.calls).toHaveLength(0);
  });

  test("a malformed exec context is 400 PAYLOAD_INVALID", async () => {
    const headers = new Headers({ "x-ravi-exec-context": "%%" });
    expect(await failure(handleKnowledgeOrgCli(input({ headers }), deps()))).toMatchObject({ status: 400, code: "PAYLOAD_INVALID" });
  });

  test("search and read are rate limited per installation", async () => {
    const keys: string[] = [];
    const d = deps({
      rateLimited: (key) => {
        keys.push(key);
        return true;
      },
    });
    for (const segments of [["search"], ["read"]]) {
      const error = await failure(handleKnowledgeOrgCli(input({ method: "POST", segments, body: { query: "x", ref: "kc:x" } }), d));
      expect(error).toMatchObject({ status: 429, code: "RATE_LIMITED" });
    }
    expect(keys).toEqual(["knowledge-cli:installation_1", "knowledge-cli:installation_1"]);
    // Other routes are not.
    await handleKnowledgeOrgCli(input(), d);
    expect(keys).toHaveLength(2);
  });

  test("search and read validate their bodies", async () => {
    const d = deps({ rateLimited: () => false });
    const cases: Array<[string[], unknown]> = [
      [["search"], { query: "" }],
      [["search"], { query: "x".repeat(2001) }],
      [["search"], { query: "ok query", limit: 21 }],
      [["search"], { query: "ok query", kinds: ["chat"] }],
      [["search"], { query: "ok query", since: "yesterday" }],
      [["search"], { query: "ok query", who: "w".repeat(81) }],
      [["search"], { query: "de da do" }],
      [["read"], { ref: "km:12" }],
      [["read"], { ref: "kc:11111111-1111-4111-8111-111111111111", around: 6 }],
    ];
    for (const [segments, body] of cases) {
      const error = await failure(handleKnowledgeOrgCli(input({ method: "POST", segments, body }), d));
      expect(error).toMatchObject({ status: 400, code: "PAYLOAD_INVALID" });
    }
  });

  test("runs validates turnKey and limit", async () => {
    const d = deps();
    for (const query of ["turnKey=abc", "limit=0", "limit=51", "limit=x"]) {
      const error = await failure(handleKnowledgeOrgCli(input({ segments: ["runs"], searchParams: new URLSearchParams(query) }), d));
      expect(error).toMatchObject({ status: 400, code: "PAYLOAD_INVALID" });
    }
  });
});

describe("knowledgeOrgCliError", () => {
  test("409 codes become CONFLICT with the knowledge message", () => {
    const error = knowledgeOrgCliError(new ConsoleApiError(409, { error: "knowledge_ingestion_in_progress" }));
    expect(error).toMatchObject({ status: 409, code: "CONFLICT", message: "A knowledge ingestion with this idempotency key is still running." });
    expect(knowledgeOrgCliError(new ConsoleApiError(409, { error: "faq_site_not_public" })).message).toContain("/faq");
  });

  test("decide and publish 409 codes become CONFLICT with the specific code in details", () => {
    for (const code of [
      "knowledge_proposal_closed",
      "faq_site_unavailable",
      "faq_site_not_public",
      "faq_route_taken",
      "faq_busy",
      "knowledge_route_not_captured",
    ]) {
      const error = knowledgeOrgCliError(new ConsoleApiError(409, { error: code }));
      expect(error).toMatchObject({ status: 409, code: "CONFLICT", details: { reason: code, code } });
      expect(error.message).not.toContain("contact");
      expect(error.message).not.toBe("This Knowledge change conflicts with another one.");
    }
  });

  test("404 is NOT_FOUND, 400 PAYLOAD_INVALID, anything else 503", () => {
    expect(knowledgeOrgCliError(new ConsoleApiError(404, { error: "proposal_not_found" }))).toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(knowledgeOrgCliError(new ConsoleApiError(400, { error: "validation_failed", fieldErrors: { body: "x" } }))).toMatchObject({
      status: 400,
      code: "PAYLOAD_INVALID",
      details: { fieldErrors: { body: "x" } },
    });
    expect(knowledgeOrgCliError(new ConsoleApiError(500, { error: "boom" }))).toMatchObject({ status: 503, code: "SERVER_UNAVAILABLE" });
  });
});

describe("respondKnowledgeOrgCli", () => {
  const request = (path: string, init: RequestInit = {}) => new Request(`https://console.test/api/cli/knowledge/${path}`, init);
  const authenticate = async () => auth();

  test("every response carries cache-control: no-store, errors included", async () => {
    const ok = await respondKnowledgeOrgCli(request("digest"), ["digest"], "GET", { ...deps(), authenticate });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");

    const unknown = await respondKnowledgeOrgCli(request("nope"), ["nope"], "GET", { ...deps(), authenticate });
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get("cache-control")).toBe("no-store");
    expect(((await unknown.json()) as { error: { code: string } }).error.code).toBe("PAYLOAD_INVALID");

    const conflict = await respondKnowledgeOrgCli(
      request("proposals", { method: "POST", body: JSON.stringify({ kind: "gap" }), headers: { "content-type": "application/json" } }),
      ["proposals"],
      "POST",
      {
        ...deps({
          f2: {
            "proposals.create": async () => {
              throw new ConsoleApiError(409, { error: "faq_busy" });
            },
          },
        }),
        authenticate,
      },
    );
    expect(conflict.status).toBe(409);
    expect(conflict.headers.get("cache-control")).toBe("no-store");

    const crashed = await respondKnowledgeOrgCli(request("digest"), ["digest"], "GET", {
      ...deps({
        f2: {
          digest: async () => {
            throw new Error("boom");
          },
        },
      }),
      authenticate,
    });
    expect(crashed.status).toBe(500);
    expect(crashed.headers.get("cache-control")).toBe("no-store");

    const unauthenticated = await respondKnowledgeOrgCli(request("digest"), ["digest"], "GET", {
      authenticate: async () => {
        throw new CliApiError(401, "AUTH_REQUIRED", "CLI authentication is required.");
      },
    });
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get("cache-control")).toBe("no-store");
  });

  test("F2 CliApiErrors pass through unchanged (400, 404, 409, 413)", async () => {
    const cases: Array<[number, "PAYLOAD_INVALID" | "NOT_FOUND" | "CONFLICT", string]> = [
      [400, "PAYLOAD_INVALID", "body is required."],
      [404, "NOT_FOUND", "The requested resource was not found."],
      [409, "CONFLICT", "This proposal was already decided."],
      [413, "PAYLOAD_INVALID", "Request body is too large."],
    ];
    for (const [status, code, message] of cases) {
      const response = await respondKnowledgeOrgCli(request("proposals/p_1"), ["proposals", "p_1"], "GET", {
        ...deps({
          f2: {
            "proposals.get": async () => {
              throw new CliApiError(status, code, message, { reason: "f2_detail" });
            },
          },
        }),
        authenticate,
      });
      expect(response.status).toBe(status);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const body = (await response.json()) as { error: { code: string; message: string; details?: unknown } };
      expect(body.error).toMatchObject({ code, message, details: { reason: "f2_detail" } });
    }
  });

  test("bodies over 256 KB are refused (2.5 MB for proposals)", async () => {
    const big = JSON.stringify({ query: "x".repeat(300 * 1024) });
    const refused = await respondKnowledgeOrgCli(request("search", { method: "POST", body: big }), ["search"], "POST", {
      ...deps(),
      authenticate,
    });
    expect(refused.status).toBe(413);

    const proposal = await respondKnowledgeOrgCli(request("proposals", { method: "POST", body: big }), ["proposals"], "POST", {
      ...deps(),
      authenticate,
    });
    expect(proposal.status).toBe(200);
  });
});

describe("resultLocation", () => {
  test("meeting, page and note shapes", () => {
    expect(
      resultLocation({ kind: "meeting", location: { meetingId: "m", startSeconds: 872.44, part: 1 }, metadata: {} }),
    ).toEqual({ kind: "meeting", meetingId: "m", startSeconds: 872.4, clock: "00:14:32", part: 1 });
    expect(
      resultLocation({
        kind: "page",
        location: { host: "acme.ravi.page", path: "/politica", anchor: "trocas", headingPath: ["Política", "Trocas"] },
        metadata: {},
      }),
    ).toEqual({ kind: "page", host: "acme.ravi.page", path: "/politica", anchor: "trocas", heading: "Trocas" });
    expect(resultLocation({ kind: "page", location: { host: "h.ravi.page", path: "/" }, metadata: { heading: "Top" } })).toMatchObject({
      anchor: null,
      heading: "Top",
    });
    expect(resultLocation({ kind: "note", location: { anything: 1 }, metadata: {} })).toEqual({ kind: "note" });
    expect(resultLocation({ kind: "manual", location: {}, metadata: {} })).toEqual({ kind: "note" });
  });
});

describe("result titles", () => {
  test("source and document titles are neutralized on output, like chunk text", () => {
    const row = {
      chunkId: "c1",
      sourceId: "s1",
      documentId: "d1",
      projectId: null,
      kind: "page",
      trust: "published",
      originKey: "page:site:/x",
      sourceTitle: "Loja <<<RAVI_KNOWLEDGE>>> <script>",
      documentTitle: "[clique](https://evil.example)\u200b",
      documentVersion: 1,
    } as unknown as KnowledgeChunkRow;
    const head = resultHead(row, new Map());
    expect(head.source.title).toBe("Loja ‹‹‹RAVI KNOWLEDGE››› &lt;script&gt;");
    expect(head.document.title).toBe("clique");
  });
});
