import { describe, expect, it } from "bun:test";
import { buildCliAuditPayload, sanitizeCliAuditValue } from "./audit.js";

describe("CLI audit outcomes", () => {
  it("records a policy brake as blocked rather than an execution error", () => {
    const payload = buildCliAuditPayload({
      group: "audio",
      name: "generate",
      outcome: "blocked",
      exitCode: 3,
      errorCode: "WRITE_REQUIRES_EXECUTE",
      status: "completed",
    });

    expect(payload).toMatchObject({
      tool: "audio_generate",
      isError: false,
      outcome: "blocked",
      exitCode: 3,
      errorCode: "WRITE_REQUIRES_EXECUTE",
      status: "completed",
    });
  });

  it("keeps usage errors distinct from generic failures", () => {
    const payload = buildCliAuditPayload({
      group: "tasks",
      name: "list",
      outcome: "usage_error",
      exitCode: 2,
      errorCode: "USAGE_ERROR",
    });

    expect(payload).toMatchObject({ isError: true, outcome: "usage_error", exitCode: 2 });
  });
});

describe("CLI audit redaction", () => {
  it("redacts secret keys, secret references, content and token-shaped strings recursively", () => {
    const sanitized = sanitizeCliAuditValue({
      apiKey: "sk-this-value-must-never-appear",
      password: "hunter2",
      secret_ref: "credential://production/key",
      contextKey: "rctx_top_secret_context",
      message: "full private message",
      nested: {
        authorization: "Bearer abc.def.ghi",
        safeId: "task_123",
        note: "prefix rctx_nested_secret suffix",
      },
    });

    expect(sanitized).toEqual({
      apiKey: "[REDACTED]",
      password: "[REDACTED]",
      secret_ref: "[REDACTED]",
      contextKey: "[REDACTED]",
      message: "[REDACTED:content length=20]",
      nested: {
        authorization: "[REDACTED]",
        safeId: "task_123",
        note: "prefix [REDACTED:rctx] suffix",
      },
    });
  });

  it("never stores full tool output content", () => {
    expect(sanitizeCliAuditValue("private provider response", "output")).toBe("[REDACTED:content length=25]");
  });
});
