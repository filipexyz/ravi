import { describe, expect, it } from "bun:test";
import {
  asUuid,
  bugCommentIdempotencyKey,
  bugReportCommentApiPath,
  bugReportSubscribeApiPath,
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
    expect(bugReportSubscribeApiPath("bug_1")).toBe("/api/cli/bugs/bug_1/subscribe");
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
    expect(bugReportCommentApiPath("bug_1")).toBe("/api/cli/bugs/bug_1/comments");
    expect(bugReportCommentApiPath("bug/with spaces")).toBe("/api/cli/bugs/bug%2Fwith%20spaces/comments");
  });
});

describe("bugCommentIdempotencyKey", () => {
  const comment: BugCommentDossier = {
    schemaVersion: BUG_COMMENT_SCHEMA_ID,
    text: "Same follow-up",
    evidence: { notes: ["one"] },
  };

  it("is stable for the same sanitized payload and bug id", () => {
    expect(bugCommentIdempotencyKey("bug_1", comment)).toBe(bugCommentIdempotencyKey("bug_1", comment));
    expect(bugCommentIdempotencyKey("bug_1", comment)).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("changes when the bug id or sanitized text changes", () => {
    expect(bugCommentIdempotencyKey("bug_1", comment)).not.toBe(bugCommentIdempotencyKey("bug_2", comment));
    expect(bugCommentIdempotencyKey("bug_1", comment)).not.toBe(
      bugCommentIdempotencyKey("bug_1", { ...comment, text: "Different follow-up" }),
    );
  });

  it("ignores redaction metadata so retries of the same body keep the key", () => {
    const first = bugCommentIdempotencyKey("bug_1", comment);
    const retry = bugCommentIdempotencyKey("bug_1", {
      ...comment,
      sanitization: { rulesApplied: ["redact-bearer-tokens"] },
      evidence: { notes: ["one"], redactions: ["Bearer token"] },
    });
    expect(retry).toBe(first);
  });

  it("uses an explicit key when provided", () => {
    expect(bugCommentIdempotencyKey("bug_1", comment, " idem_custom ")).toBe("idem_custom");
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
