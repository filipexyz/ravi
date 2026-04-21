import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { recordSessionBlob, recordSessionEvent, upsertSessionTurn } from "../../session-trace/session-trace-db.js";

mock.module("../../permissions/scope.js", () => ({
  getScopeContext: () => undefined,
  isScopeEnforced: () => false,
  canAccessSession: () => true,
  canModifySession: () => true,
  filterAccessibleSessions: <T>(_: unknown, sessions: T[]) => sessions,
}));

const { SessionCommands } = await import("./sessions.js");

let stateDir: string | null = null;

afterAll(() => mock.restore());

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-session-trace-cli-test-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

function captureLogs(run: () => void): string {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };

  try {
    run();
  } finally {
    console.log = originalLog;
  }

  return lines.join("\n");
}

function seedCliTrace() {
  const systemPrompt = recordSessionBlob({
    kind: "system_prompt",
    contentText: "# Identity\nCLI trace system prompt",
    createdAt: 100,
  });
  const userPrompt = recordSessionBlob({
    kind: "user_prompt",
    contentText: "hello trace",
    createdAt: 100,
  });
  const request = recordSessionBlob({
    kind: "adapter_request",
    contentJson: { cwd: "/repo", prompt: "hello trace" },
    createdAt: 100,
  });

  upsertSessionTurn({
    turnId: "turn-cli",
    sessionKey: "agent:main:cli-trace",
    sessionName: "cli-trace",
    runId: "run-cli",
    agentId: "main",
    provider: "codex",
    model: "gpt-5.4",
    cwd: "/repo",
    status: "complete",
    resume: true,
    systemPromptSha256: systemPrompt.sha256,
    userPromptSha256: userPrompt.sha256,
    requestBlobSha256: request.sha256,
    startedAt: 200,
    completedAt: 400,
    updatedAt: 400,
  });

  recordSessionEvent({
    sessionKey: "agent:main:cli-trace",
    sessionName: "cli-trace",
    agentId: "main",
    runId: "run-cli",
    turnId: "turn-cli",
    eventType: "adapter.request",
    eventGroup: "adapter",
    status: "built",
    timestamp: 200,
    createdAt: 200,
    provider: "codex",
    model: "gpt-5.4",
    payloadJson: {
      cwd: "/repo",
      resume: true,
      fork: false,
      request_blob_sha256: request.sha256,
      system_prompt_sha256: systemPrompt.sha256,
      system_prompt_chars: systemPrompt.contentText?.length,
      system_prompt_sections: ["Identity"],
      user_prompt_sha256: userPrompt.sha256,
      user_prompt_chars: userPrompt.contentText?.length,
    },
    preview: "hello trace",
  });
  recordSessionEvent({
    sessionKey: "agent:main:cli-trace",
    sessionName: "cli-trace",
    agentId: "main",
    runId: "run-cli",
    turnId: "turn-cli",
    eventType: "turn.complete",
    eventGroup: "runtime",
    status: "complete",
    timestamp: 400,
    createdAt: 400,
    provider: "codex",
    model: "gpt-5.4",
    payloadJson: { status: "complete" },
  });
}

describe("SessionCommands trace", () => {
  it("prints a human timeline with raw request and requested prompt blobs", () => {
    seedCliTrace();

    const output = captureLogs(() => {
      new SessionCommands().trace(
        "cli-trace",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        false,
        true,
        true,
        true,
        false,
        undefined,
        undefined,
        true,
      );
    });

    expect(output).toContain("Session trace: cli-trace");
    expect(output).toContain("adapter.request");
    expect(output).toContain("requestBlob=sha256:");
    expect(output).toContain("systemPromptBlob=sha256:");
    expect(output).toContain("userPromptBlob=sha256:");
    expect(output).toContain("Explanation:");
  });

  it("prints the session system prompt without requiring a visible turn row", () => {
    seedCliTrace();

    const output = captureLogs(() => {
      new SessionCommands().trace(
        "cli-trace",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        false,
        false,
        true,
        false,
        false,
        undefined,
        "1",
        false,
      );
    });

    expect(output).toContain("Session system prompt");
    expect(output).toContain("systemPromptBlob=sha256:");
    expect(output).toContain("CLI trace system prompt");
    expect(output).not.toContain("turn.snapshot");
  });

  it("includes the session system prompt record in JSONL output", () => {
    seedCliTrace();

    const output = captureLogs(() => {
      new SessionCommands().trace(
        "cli-trace",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
        false,
        true,
        false,
        false,
        undefined,
        "1",
        false,
      );
    });

    const records = output
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { recordType: string; sha256?: string; contentText?: string });

    expect(records.some((record) => record.recordType === "system_prompt" && record.sha256)).toBe(true);
    expect(records.some((record) => record.recordType === "blob" && record.contentText?.includes("CLI trace"))).toBe(
      true,
    );
  });

  it("prints structured JSONL records", () => {
    seedCliTrace();

    const output = captureLogs(() => {
      new SessionCommands().trace(
        "cli-trace",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
        true,
        false,
        false,
        false,
        undefined,
        undefined,
        true,
      );
    });

    const records = output
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { recordType: string; eventType?: string });

    expect(records[0]?.recordType).toBe("metadata");
    expect(records.some((record) => record.recordType === "event" && record.eventType === "adapter.request")).toBe(
      true,
    );
    expect(records.some((record) => record.recordType === "turn")).toBe(true);
    expect(records.some((record) => record.recordType === "blob")).toBe(true);
    expect(records.some((record) => record.recordType === "explanation")).toBe(true);
  });
});
