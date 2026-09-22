import { describe, expect, it } from "bun:test";
import { BUG_COMMENT_SCHEMA_ID } from "./schema.js";
import { BUG_SANITIZE_RULES, sanitizeBugCommentDossier, sanitizeBugReportText } from "./sanitize.js";

describe("sanitizeBugReportText", () => {
  it("redacts bearer tokens, API keys, rctx tokens, and assignments", () => {
    const input =
      "Authorization: Bearer supersecrettokenvalue OPENAI_API_KEY=sk-ant-not-a-real-key rctx_abcDEF123 leftover sk-ant-standalonekey99";
    const result = sanitizeBugReportText(input);
    expect(result.redacted).toBe(true);
    expect(result.value).not.toContain("supersecrettokenvalue");
    expect(result.value).not.toContain("sk-ant-not-a-real-key");
    expect(result.value).not.toContain("rctx_abcDEF123");
    expect(result.value).not.toContain("sk-ant-standalonekey99");
    expect(result.value).toContain("[REDACTED]");
    expect(result.value).toContain("OPENAI_API_KEY=[REDACTED]");
    expect(result.rulesApplied).toEqual(
      expect.arrayContaining([
        BUG_SANITIZE_RULES.bearer,
        BUG_SANITIZE_RULES.assignment,
        BUG_SANITIZE_RULES.apiToken,
        BUG_SANITIZE_RULES.rctx,
      ]),
    );
  });

  it("is stable when run twice on the same sanitized text", () => {
    const first = sanitizeBugReportText("Bearer abcdefghijklmnop");
    const second = sanitizeBugReportText(first.value);
    expect(second.value).toBe(first.value);
  });
});

describe("sanitizeBugCommentDossier", () => {
  it("redacts secrets in text and evidence and records the rules", () => {
    const sanitized = sanitizeBugCommentDossier({
      schemaVersion: BUG_COMMENT_SCHEMA_ID,
      text: "Found the path. Cookie: session=sekrit",
      evidence: {
        logs: ["Authorization: Bearer abcdefghijklmnop"],
        notes: ["OPENAI_API_KEY=sk-ant-abcdefghij"],
      },
    });
    expect(sanitized.text).not.toContain("sekrit");
    expect(sanitized.evidence?.logs?.[0]).toContain("[REDACTED]");
    expect(sanitized.evidence?.notes?.[0]).not.toContain("sk-ant-abcdefghij");
    expect(sanitized.evidence?.redactions).toEqual(
      expect.arrayContaining(["secret material in evidence", "secret material in comment text"]),
    );
    expect(sanitized.sanitization?.rulesApplied?.length).toBeGreaterThan(0);
  });
});
