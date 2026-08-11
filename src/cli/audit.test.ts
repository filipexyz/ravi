import { describe, expect, it, spyOn } from "bun:test";
import { ContractError } from "./agent-contract.js";
import { buildCliAuditPayload, runWithCliAudit, sanitizeCliAuditValue, wasContractErrorAudited } from "./audit.js";

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

  it("normalizes and redacts an unexpected top-level command failure", async () => {
    const previousSuppressAudit = process.env.RAVI_SUPPRESS_AUDIT_EVENTS;
    process.env.RAVI_SUPPRESS_AUDIT_EVENTS = "1";
    const output: string[] = [];
    const log = spyOn(console, "log").mockImplementation((value: unknown) => output.push(String(value)));

    let failure: unknown;
    try {
      await runWithCliAudit({ group: "demo", name: "boom", input: { json: true } }, () => {
        throw new Error("private provider detail");
      });
    } catch (error) {
      failure = error;
    } finally {
      log.mockRestore();
      if (previousSuppressAudit === undefined) delete process.env.RAVI_SUPPRESS_AUDIT_EVENTS;
      else process.env.RAVI_SUPPRESS_AUDIT_EVENTS = previousSuppressAudit;
    }

    expect(failure).toBeInstanceOf(ContractError);
    expect(failure).toMatchObject({ op: "demo boom", code: "UNHANDLED_ERROR", exitCode: 1 });
    expect(wasContractErrorAudited(failure as ContractError)).toBe(true);
    expect(output).toHaveLength(1);
    expect(output[0]).not.toContain("private provider detail");
    expect(JSON.parse(output[0] ?? "{}")).toMatchObject({
      success: false,
      op: "demo boom",
      error: { code: "UNHANDLED_ERROR", message: "Command failed unexpectedly." },
    });
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

  it("keeps existing redaction markers stable across transport boundaries", () => {
    expect(sanitizeCliAuditValue("[REDACTED]", "content")).toBe("[REDACTED]");
    expect(sanitizeCliAuditValue("[REDACTED:path]", "filePath")).toBe("[REDACTED:path]");
  });

  it("does not trust user-controlled strings that only resemble redaction markers", () => {
    const fakeContentMarker = "[REDACTED:PRIVATE_MESSAGE_8K2R]";
    expect(sanitizeCliAuditValue("[REDACTED:SENTINEL_SECRET_7M4Q]", "password")).toBe("[REDACTED]");
    expect(sanitizeCliAuditValue(fakeContentMarker, "content")).toBe(
      `[REDACTED:content length=${fakeContentMarker.length}]`,
    );
    expect(sanitizeCliAuditValue("[REDACTED:C:/private/file.txt]", "filePath")).toBe("[REDACTED:path]");
  });

  it("uses sibling setting keys to redact dynamic values and local paths", () => {
    const input = {
      key: "custom.password",
      value: "SENTINEL_SECRET_7M4Q",
      filePath: "C:/sentinel/private/file-9P3X.txt",
      count: 2,
    };

    expect(sanitizeCliAuditValue(input)).toEqual({
      key: "custom.password",
      value: "[REDACTED]",
      filePath: "[REDACTED:path]",
      count: 2,
    });
    expect(input.value).toBe("SENTINEL_SECRET_7M4Q");
    expect(input.filePath).toBe("C:/sentinel/private/file-9P3X.txt");
  });

  it("never includes a custom setting secret in the emitted audit payload", () => {
    const payload = buildCliAuditPayload({
      group: "settings",
      name: "set",
      input: { key: "custom.password", value: "SENTINEL_SECRET_7M4Q", json: true },
      outcome: "succeeded",
      status: "completed",
    });

    expect(payload).toMatchObject({
      tool: "settings_set",
      input: { key: "custom.password", value: "[REDACTED]", json: true },
      outcome: "succeeded",
      isError: false,
    });
    expect(JSON.stringify(payload)).not.toContain("SENTINEL_SECRET_7M4Q");
  });

  it("redacts user-authored task, failure and search text from audit inputs", () => {
    const sanitized = sanitizeCliAuditValue({
      title: "PRIVATE_TITLE_8K2R",
      instructions: "PRIVATE_INSTRUCTIONS_8K2R",
      reason: "PRIVATE_REASON_8K2R",
      query: "PRIVATE_QUERY_8K2R",
      taskId: "task_123",
    });

    expect(sanitized).toEqual({
      title: "[REDACTED:content length=18]",
      instructions: "[REDACTED:content length=25]",
      reason: "[REDACTED:content length=19]",
      query: "[REDACTED:content length=18]",
      taskId: "task_123",
    });
    const serialized = JSON.stringify(sanitized);
    expect(serialized).not.toContain("PRIVATE_TITLE_8K2R");
    expect(serialized).not.toContain("PRIVATE_INSTRUCTIONS_8K2R");
    expect(serialized).not.toContain("PRIVATE_REASON_8K2R");
    expect(serialized).not.toContain("PRIVATE_QUERY_8K2R");
  });

  it("does not include process paths in CLI audit provenance", () => {
    const payload = buildCliAuditPayload({ group: "tasks", name: "list" });
    const serialized = JSON.stringify(payload);

    expect(payload).toMatchObject({
      cliInvocation: {
        process: {
          cwd: "[REDACTED:path]",
          execPath: "[REDACTED:path]",
        },
      },
    });
    expect(serialized).not.toContain(process.cwd());
    expect(serialized).not.toContain(process.execPath);
  });

  it("removes secret values from serialized audit metadata", () => {
    const payload = buildCliAuditPayload({
      group: "artifacts",
      name: "create",
      input: { metadata: '{"token":"SENTINEL_METADATA_8K2R"}' },
      outcome: "succeeded",
    });

    expect(payload).toMatchObject({
      input: { metadata: '{"token":"[REDACTED]"}' },
    });
    expect(JSON.stringify(payload)).not.toContain("SENTINEL_METADATA_8K2R");
  });

  it("does not persist private URL components in audit argv", () => {
    const originalArgv = [...process.argv];
    try {
      process.argv.splice(
        0,
        process.argv.length,
        originalArgv[0] ?? "bun",
        originalArgv[1] ?? "ravi",
        "projects",
        "create",
        "--url",
        "https://user:SENTINEL_ARGV_5P9X@example.test/private?token=value",
      );

      const payload = buildCliAuditPayload({ group: "projects", name: "create" });
      const serialized = JSON.stringify(payload);
      expect(payload).toMatchObject({
        cliInvocation: { process: { argv: [`[REDACTED:argv count=${process.argv.length}]`] } },
      });
      expect(serialized).not.toContain("SENTINEL_ARGV_5P9X");
      expect(serialized).not.toContain("user:");
      expect(serialized).not.toContain("/private");
      expect(serialized).not.toContain("token=value");
    } finally {
      process.argv.splice(0, process.argv.length, ...originalArgv);
    }
  });

  it("never persists raw CLI values in audit argv", () => {
    const originalArgv = [...process.argv];
    const cases = [
      {
        group: "tasks",
        name: "create",
        argv: ["tasks", "create", "PRIVATE_TITLE_7H4M", "--instructions", "SENTINEL_PRIVATE_INSTRUCTIONS_7H4M"],
      },
      {
        group: "artifacts",
        name: "create",
        argv: ["artifacts", "create", "--uri=https://user:SENTINEL_URI_7H4M@example.test/private?token=secret"],
      },
      {
        group: "whatsapp_group",
        name: "join",
        argv: ["whatsapp", "group", "join", "https://chat.whatsapp.com/SENTINEL_INVITE_7H4M"],
      },
    ] as const;

    try {
      for (const testCase of cases) {
        process.argv.splice(
          0,
          process.argv.length,
          originalArgv[0] ?? "bun",
          originalArgv[1] ?? "ravi",
          ...testCase.argv,
        );

        const payload = buildCliAuditPayload({ group: testCase.group, name: testCase.name });
        const serialized = JSON.stringify(payload);

        expect(payload).toMatchObject({
          cliInvocation: {
            command: { group: testCase.group, name: testCase.name },
            process: { argv: [`[REDACTED:argv count=${process.argv.length}]`] },
          },
        });
        expect(serialized).not.toContain("PRIVATE_TITLE_7H4M");
        expect(serialized).not.toContain("SENTINEL_PRIVATE_INSTRUCTIONS_7H4M");
        expect(serialized).not.toContain("SENTINEL_URI_7H4M");
        expect(serialized).not.toContain("SENTINEL_INVITE_7H4M");
      }
    } finally {
      process.argv.splice(0, process.argv.length, ...originalArgv);
    }
  });
});
