import { describe, expect, it } from "bun:test";
import { ConsoleApiClient } from "../cloud-auth/client.js";
import { CloudAuthError } from "../cloud-auth/errors.js";
import {
  asUuid,
  bugCommentIdempotencyKey,
  bugReportCommentApiPath,
  bugReportSubscribeApiPath,
  RaviBugReportClient,
  requireBugId,
  toConsoleBugCommentBody,
  toConsoleBugCreateBody,
} from "./client.js";
import {
  BUG_COMMENT_SCHEMA_ID,
  BUG_REPORT_SCHEMA_ID,
  type BugCommentDossier,
  type BugReportDossier,
} from "./schema.js";

const ORG_UUID = "11111111-1111-4111-8111-111111111111";
const PROJECT_UUID = "22222222-2222-4222-8222-222222222222";

const dossier: BugReportDossier = {
  schemaVersion: BUG_REPORT_SCHEMA_ID,
  title: "Crash on report",
  summary: "Submit fails without payload.",
  severity: "high",
  surface: "cli",
  context: {
    organizationRef: "acme",
    projectRef: "rbbt",
    sessionHints: "agent:main:main",
  },
  evidence: { notes: ["slug refs must stay inside payload"] },
};

describe("toConsoleBugCreateBody", () => {
  it("maps the dossier onto createBodySchema and keeps the full dossier in payload", () => {
    const body = toConsoleBugCreateBody(dossier, "cli");
    expect(body).toEqual({
      schemaVersion: BUG_REPORT_SCHEMA_ID,
      title: dossier.title,
      summary: dossier.summary,
      severity: "high",
      surface: "cli",
      payload: { ...dossier, source: "cli" },
    });
    expect(body).not.toHaveProperty("source");
    expect(body).not.toHaveProperty("organizationId");
    expect(body).not.toHaveProperty("projectId");
    expect(body).not.toHaveProperty("reproduction");
    expect(body).not.toHaveProperty("context");
  });

  it("omits blank surface and defaults source inside payload", () => {
    const body = toConsoleBugCreateBody({ ...dossier, surface: "   " });
    expect(body).not.toHaveProperty("surface");
    expect((body.payload as { source?: string }).source).toBe("cli");
  });

  it("promotes UUID organization/project refs and omits slugs", () => {
    const body = toConsoleBugCreateBody({
      ...dossier,
      context: {
        organizationRef: ORG_UUID,
        projectRef: PROJECT_UUID,
      },
    });
    expect(body.organizationId).toBe(ORG_UUID);
    expect(body.projectId).toBe(PROJECT_UUID);
    expect((body.payload as BugReportDossier).context).toEqual({
      organizationRef: ORG_UUID,
      projectRef: PROJECT_UUID,
    });
  });
});

describe("bugReportSubscribeApiPath", () => {
  it("keeps the Console follow contract on /api/cli/bugs/:id/subscribe", () => {
    expect(bugReportSubscribeApiPath("b1b1b1b1-1111-4111-8111-111111111111")).toBe(
      "/api/cli/bugs/b1b1b1b1-1111-4111-8111-111111111111/subscribe",
    );
  });
});

describe("toConsoleBugCommentBody", () => {
  const comment: BugCommentDossier = {
    schemaVersion: BUG_COMMENT_SCHEMA_ID,
    text: "Root cause is idle stdin.",
    evidence: { notes: ["reproduced on the second attach"] },
  };

  it("maps the sanitized comment onto commentBodySchema with payload + idempotencyKey", () => {
    const body = toConsoleBugCommentBody(comment, "cli", "sha256:abc");
    expect(body).toEqual({
      schemaVersion: BUG_COMMENT_SCHEMA_ID,
      text: comment.text,
      payload: { ...comment, source: "cli" },
      idempotencyKey: "sha256:abc",
    });
    expect(body).not.toHaveProperty("source");
  });

  it("redacts secrets before they enter the Console body", () => {
    const body = toConsoleBugCommentBody(
      {
        schemaVersion: BUG_COMMENT_SCHEMA_ID,
        text: "token=supersecretvalue",
        evidence: { logs: ["Bearer abcdefghijklmnop"] },
      },
      "cli",
      "idem_1",
    );
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("supersecretvalue");
    expect(serialized).not.toContain("abcdefghijklmnop");
    expect(body.text).toContain("[REDACTED]");
  });
});

describe("bugReportCommentApiPath", () => {
  it("keeps the Console append contract on /api/cli/bugs/:id/comments", () => {
    expect(bugReportCommentApiPath("b1b1b1b1-1111-4111-8111-111111111111")).toBe(
      "/api/cli/bugs/b1b1b1b1-1111-4111-8111-111111111111/comments",
    );
  });
});

describe("bugCommentIdempotencyKey", () => {
  const comment: BugCommentDossier = {
    schemaVersion: BUG_COMMENT_SCHEMA_ID,
    text: "Same follow-up",
    evidence: { notes: ["one"] },
  };

  it("is stable for the same sanitized payload and bug id", () => {
    expect(bugCommentIdempotencyKey("b1b1b1b1-1111-4111-8111-111111111111", comment)).toBe(
      bugCommentIdempotencyKey("b1b1b1b1-1111-4111-8111-111111111111", comment),
    );
    expect(bugCommentIdempotencyKey("b1b1b1b1-1111-4111-8111-111111111111", comment)).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("changes when the bug id or sanitized text changes", () => {
    expect(bugCommentIdempotencyKey("b1b1b1b1-1111-4111-8111-111111111111", comment)).not.toBe(
      bugCommentIdempotencyKey("b2b2b2b2-2222-4222-8222-222222222222", comment),
    );
    expect(bugCommentIdempotencyKey("b1b1b1b1-1111-4111-8111-111111111111", comment)).not.toBe(
      bugCommentIdempotencyKey("b1b1b1b1-1111-4111-8111-111111111111", { ...comment, text: "Different follow-up" }),
    );
  });

  it("ignores redaction metadata so retries of the same body keep the key", () => {
    const first = bugCommentIdempotencyKey("b1b1b1b1-1111-4111-8111-111111111111", comment);
    const retry = bugCommentIdempotencyKey("b1b1b1b1-1111-4111-8111-111111111111", {
      ...comment,
      sanitization: { rulesApplied: ["redact-bearer-tokens"] },
      evidence: { notes: ["one"], redactions: ["Bearer token"] },
    });
    expect(retry).toBe(first);
  });

  it("uses an explicit key when provided", () => {
    expect(bugCommentIdempotencyKey("b1b1b1b1-1111-4111-8111-111111111111", comment, " idem_custom ")).toBe(
      "idem_custom",
    );
  });
});

describe("asUuid", () => {
  it("accepts RFC UUID strings and rejects slugs", () => {
    expect(asUuid(ORG_UUID)).toBe(ORG_UUID);
    expect(asUuid(` ${ORG_UUID.toUpperCase()} `)).toBe(ORG_UUID);
    expect(asUuid("acme")).toBeUndefined();
    expect(asUuid("org_1")).toBeUndefined();
    expect(asUuid(undefined)).toBeUndefined();
  });
});

describe("requireBugId", () => {
  const BUG_UUID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

  it("accepts a full UUID and sends it lowercase", () => {
    expect(requireBugId(` ${BUG_UUID.toUpperCase()} `)).toBe(BUG_UUID);
  });

  it("rejects the short id prefix with a message that names the id", () => {
    let thrown: unknown;
    try {
      requireBugId("0a1b2c3d");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CloudAuthError);
    expect((thrown as CloudAuthError).code).toBe("PAYLOAD_INVALID");
    expect((thrown as CloudAuthError).message).toBe(
      'Invalid bug id "0a1b2c3d": use the full UUID shown by `ravi bug list`.',
    );
    expect(() => requireBugId("bug/with spaces")).toThrow(/Invalid bug id/);
    expect(() => requireBugId("  ")).toThrow("Missing bug id.");
  });
});

describe("RaviBugReportClient.comment errors", () => {
  const BUG_UUID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
  const comment: BugCommentDossier = { schemaVersion: BUG_COMMENT_SCHEMA_ID, text: "More logs" };

  function bugClient(status: number, body: string | null) {
    const fetched: string[] = [];
    const api = new ConsoleApiClient({
      consoleUrl: "https://console.test",
      fetch: (async (url: string) => {
        fetched.push(url);
        return new Response(body, {
          status,
          headers: body?.startsWith("{") ? { "content-type": "application/json" } : {},
        });
      }) as unknown as (url: string, init?: RequestInit) => Promise<Response>,
    });
    return { client: new RaviBugReportClient(api), fetched };
  }

  async function errorOf(promise: Promise<unknown>): Promise<CloudAuthError> {
    try {
      await promise;
    } catch (error) {
      if (error instanceof CloudAuthError) return error;
      throw error;
    }
    throw new Error("expected a CloudAuthError");
  }

  it("rejects a short id before any request", async () => {
    const { client, fetched } = bugClient(200, "{}");
    const error = await errorOf(client.comment("t", { id: "0a1b2c3d", comment }));
    expect(error.code).toBe("PAYLOAD_INVALID");
    expect(error.message).toContain("full UUID");
    expect(fetched).toHaveLength(0);
  });

  it("keeps a coded 404 (unknown bug) instead of the missing-route fallback", async () => {
    const body = JSON.stringify({ error: { code: "PAYLOAD_INVALID", message: "Bug report was not found." } });
    const error = await errorOf(bugClient(404, body).client.comment("t", { id: BUG_UUID, comment }));
    expect(error.code).toBe("PAYLOAD_INVALID");
    expect(error.message).toBe("Bug report was not found.");
  });

  it("reads a bare 404 as a Console without the comment route", async () => {
    const error = await errorOf(bugClient(404, "<html>nope</html>").client.comment("t", { id: BUG_UUID, comment }));
    expect(error.code).toBe("SERVER_UNAVAILABLE");
    expect(error.message).toContain("Console has no comment route yet");
  });
});
