import { describe, expect, test } from "bun:test";

import { ConsoleApiError } from "@/server/console/api-error";
import { CliApiError } from "@/server/cli/errors";
import {
  commentBodySchema,
  createBugReportComment,
  createMemoryBugReportCommentStore,
  parseBugReportCommentBody,
  toBugReportComment,
  type BugReportCommentVisibleBug,
} from "./bug-report-comments";
import { BUG_COMMENT_SCHEMA_VERSION, mapBugReportCliError } from "./bug-reports";

const BUG_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_BUG_ID = "22222222-2222-4222-8222-222222222222";
const REPORTER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_USER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function sampleBug(overrides: Partial<BugReportCommentVisibleBug> = {}): BugReportCommentVisibleBug {
  return {
    id: BUG_ID,
    reporterUserId: REPORTER_ID,
    title: "Idle stdin wedge",
    summary: "Daemon wedges after first prompt.",
    severity: "high",
    status: "submitted",
    priority: null,
    organizationId: null,
    projectId: null,
    createdAt: new Date("2026-09-22T00:00:00.000Z"),
    updatedAt: new Date("2026-09-22T00:00:00.000Z"),
    ...overrides,
  };
}

function cliCommentBody(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: BUG_COMMENT_SCHEMA_VERSION,
    text: "Root cause is idle stdin.",
    payload: {
      schemaVersion: BUG_COMMENT_SCHEMA_VERSION,
      text: "Root cause is idle stdin.",
      source: "cli",
      evidence: { notes: ["stdin is not a TTY after exec"] },
    },
    idempotencyKey: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    ...overrides,
  };
}

describe("commentBodySchema", () => {
  test("accepts the CLI comment body shape", () => {
    const parsed = commentBodySchema.safeParse(cliCommentBody());
    expect(parsed.success).toBe(true);
  });
});

describe("parseBugReportCommentBody", () => {
  test("rejects a missing body", () => {
    try {
      parseBugReportCommentBody(undefined);
      throw new Error("expected validation failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ConsoleApiError);
      expect((error as ConsoleApiError).status).toBe(400);
      expect((error as ConsoleApiError).payload.error).toBe("validation_failed");
    }
  });

  test("rejects a create dossier schema version", () => {
    expect(() =>
      parseBugReportCommentBody({
        ...cliCommentBody(),
        schemaVersion: "ravi.bug_report/v1",
      }),
    ).toThrow(ConsoleApiError);
  });

  test("requires payload and source", () => {
    try {
      parseBugReportCommentBody({ idempotencyKey: "sha256:missing-payload-key" });
      throw new Error("expected validation failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ConsoleApiError);
      expect((error as ConsoleApiError).payload.error).toBe("validation_failed");
    }
  });

  test("honors Idempotency-Key when the body omits the key", () => {
    const parsed = parseBugReportCommentBody(
      {
        schemaVersion: BUG_COMMENT_SCHEMA_VERSION,
        text: "Root cause is idle stdin.",
        payload: {
          schemaVersion: BUG_COMMENT_SCHEMA_VERSION,
          text: "Root cause is idle stdin.",
          source: "cli",
        },
      },
      { idempotencyKey: "header-key-is-long-enough" },
    );
    expect(parsed.idempotencyKey).toBe("header-key-is-long-enough");
    expect(parsed.source).toBe("cli");
    expect(parsed.text).toBe("Root cause is idle stdin.");
  });

  test("reads source from payload when top-level source is omitted", () => {
    const parsed = parseBugReportCommentBody(cliCommentBody());
    expect(parsed.source).toBe("cli");
    expect(parsed.payload.source).toBe("cli");
  });

  test("sanitizes secret-like strings and does not restore them", () => {
    const parsed = parseBugReportCommentBody(
      cliCommentBody({
        text: "token sk-abcdefghijklmnopqrstuv",
        payload: {
          schemaVersion: BUG_COMMENT_SCHEMA_VERSION,
          text: "token sk-abcdefghijklmnopqrstuv",
          source: "cli",
          password: "super-secret-value",
        },
      }),
    );
    expect(String(parsed.payload.text)).toContain("sk-[REDACTED]");
    expect(parsed.payload.password).toBe("[REDACTED]");
    expect(JSON.stringify(parsed)).not.toContain("super-secret-value");
    expect(JSON.stringify(parsed)).not.toContain("sk-abcdefghijklmnopqrstuv");
  });
});

describe("createBugReportComment", () => {
  test("appends a comment without mutating title, severity, priority, or status", async () => {
    const store = createMemoryBugReportCommentStore({ bugs: [sampleBug({ priority: "p2" })] });
    const created = await createBugReportComment(
      {
        id: BUG_ID,
        body: cliCommentBody(),
        requestId: "req_comment",
        reporterUserId: REPORTER_ID,
        actorType: "cli",
      },
      store,
    );

    expect(created.reused).toBe(false);
    expect(created.bugId).toBe(BUG_ID);
    expect(created.commentId).toBe(created.id);
    expect(created.text).toBe("Root cause is idle stdin.");
    expect(created.bug).toMatchObject({
      id: BUG_ID,
      title: "Idle stdin wedge",
      severity: "high",
      status: "submitted",
      priority: "p2",
    });
    expect(store.bugs.get(BUG_ID)).toMatchObject({
      title: "Idle stdin wedge",
      severity: "high",
      status: "submitted",
      priority: "p2",
    });
    expect(store.comments).toHaveLength(1);
    expect(store.audits).toHaveLength(1);
    expect(store.audits[0]).toMatchObject({
      action: "bug_report.comment_appended",
      targetId: BUG_ID,
      metadataJson: { commentId: created.id, source: "cli", hasText: true },
    });
    expect(JSON.stringify(store.audits[0]?.metadataJson)).not.toContain("stdin is not a TTY");

    const visible = (await store.listComments(BUG_ID)).map(toBugReportComment);
    expect(visible).toHaveLength(1);
    expect(visible[0]?.id).toBe(created.id);
    expect(visible[0]?.text).toBe("Root cause is idle stdin.");
  });

  test("returns 404 for an unknown bug", async () => {
    const store = createMemoryBugReportCommentStore({ bugs: [sampleBug()] });
    try {
      await createBugReportComment(
        {
          id: OTHER_BUG_ID,
          body: cliCommentBody(),
          requestId: "req_missing",
          reporterUserId: REPORTER_ID,
        },
        store,
      );
      throw new Error("expected missing bug");
    } catch (error) {
      expect(error).toBeInstanceOf(ConsoleApiError);
      expect((error as ConsoleApiError).status).toBe(404);
      expect((error as ConsoleApiError).payload.error).toBe("not_found");
      const mapped = mapBugReportCliError(error);
      expect(mapped).toBeInstanceOf(CliApiError);
      expect(mapped).toMatchObject({ status: 404, code: "PAYLOAD_INVALID" });
    }
    expect(store.comments).toHaveLength(0);
  });

  test("returns 404 for a non-reporter", async () => {
    const store = createMemoryBugReportCommentStore({ bugs: [sampleBug()] });
    try {
      await createBugReportComment(
        {
          id: BUG_ID,
          body: cliCommentBody(),
          requestId: "req_other",
          reporterUserId: OTHER_USER_ID,
        },
        store,
      );
      throw new Error("expected hidden bug");
    } catch (error) {
      expect((error as ConsoleApiError).status).toBe(404);
    }
    expect(store.comments).toHaveLength(0);
  });

  test("replays the same idempotency key with reused: true", async () => {
    const store = createMemoryBugReportCommentStore({ bugs: [sampleBug()] });
    const first = await createBugReportComment(
      {
        id: BUG_ID,
        body: cliCommentBody(),
        requestId: "req_one",
        reporterUserId: REPORTER_ID,
        idempotencyKeyHeader: cliCommentBody().idempotencyKey as string,
      },
      store,
    );
    const replay = await createBugReportComment(
      {
        id: BUG_ID,
        body: cliCommentBody({ text: "different text that must not replace the original" }),
        requestId: "req_two",
        reporterUserId: REPORTER_ID,
      },
      store,
    );

    expect(replay.reused).toBe(true);
    expect(replay.id).toBe(first.id);
    expect(replay.text).toBe(first.text);
    expect(store.comments).toHaveLength(1);
    expect(store.audits).toHaveLength(1);
    expect(store.bugs.get(BUG_ID)?.status).toBe("submitted");
    expect(store.bugs.get(BUG_ID)?.title).toBe("Idle stdin wedge");
  });
});
