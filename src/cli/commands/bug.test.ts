import { afterAll, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConsoleApiClient } from "../../cloud-auth/client.js";
import type { CloudCredentials } from "../../cloud-auth/types.js";
import { BUG_REPORT_COLLECTION_PROMPT } from "../../bug-report/prompt.js";
import { BUG_REPORT_SCHEMA_ID } from "../../bug-report/schema.js";

afterAll(() => mock.restore());
const actualCliContextModule = await import("../context.js");

mock.module("../context.js", () => ({
  ...actualCliContextModule,
  getContext: () => undefined,
  // Real hasContext checks RAVI_* envs; the contract helpers use it to throw
  // ContractError instead of process.exit, which is what tests need.
  hasContext: () => true,
  fail: (message: string) => {
    throw new Error(message);
  },
}));

const { BugCommands } = await import("./bug.js");
const { ContractError } = await import("../agent-contract.js");

const VALID_DOSSIER = {
  schemaVersion: BUG_REPORT_SCHEMA_ID,
  title: "Pages links vanish after refresh",
  summary: "Published page nav disappears after a hard refresh on the Console.",
  severity: "high" as const,
  surface: "console/pages",
  reproduction: {
    steps: ["Open a published page", "Hard refresh"],
    expected: "Nav stays visible",
    actual: "Nav is gone",
    frequency: "always",
  },
  environment: {
    raviVersion: "3.0.0",
    os: "linux",
    runtime: "bun",
    agentNames: ["main"],
  },
  evidence: {
    logs: ["[redacted] request failed"],
    notes: ["reproduced on two machines"],
    redactions: ["Authorization header"],
  },
  context: {
    organizationRef: "acme",
    projectRef: "rbbt",
    sessionHints: "agent:main:main",
  },
  sanitization: {
    rulesApplied: ["redact-auth-headers"],
  },
};

describe("bug CLI commands", () => {
  it("submits a validated dossier through POST /api/cli/bugs with --execute", async () => {
    const calls: Array<{ method: string; path: string; body: unknown; accessToken: string }> = [];
    const client = makeClient(async (method, path, body, accessToken) => {
      calls.push({ method, path, body, accessToken });
      return {
        id: "bug_1",
        title: VALID_DOSSIER.title,
        severity: "high",
        url: "https://console.example/bugs/bug_1",
      };
    });
    const command = new BugCommands({ client, readCredentials: makeReadCredentials() });

    const { output } = await captureConsole(() =>
      command.report(
        VALID_DOSSIER.title,
        VALID_DOSSIER.summary,
        VALID_DOSSIER.severity,
        VALID_DOSSIER.surface,
        JSON.stringify(VALID_DOSSIER),
        undefined,
        undefined,
        true,
        true,
      ),
    );
    const payload = JSON.parse(output);

    expect(calls).toEqual([
      {
        method: "POST",
        path: "/api/cli/bugs",
        accessToken: "access-secret",
        body: {
          schemaVersion: VALID_DOSSIER.schemaVersion,
          title: VALID_DOSSIER.title,
          summary: VALID_DOSSIER.summary,
          severity: VALID_DOSSIER.severity,
          surface: VALID_DOSSIER.surface,
          payload: {
            ...VALID_DOSSIER,
            source: "cli",
          },
        },
      },
    ]);
    expect(calls[0]?.body).not.toHaveProperty("source");
    expect(calls[0]?.body).not.toHaveProperty("organizationId");
    expect(calls[0]?.body).not.toHaveProperty("projectId");
    expect(payload).toMatchObject({
      success: true,
      consoleUrl: "https://console.example",
      id: "bug_1",
      url: "https://console.example/bugs/bug_1",
      bug: { id: "bug_1", severity: "high" },
    });
  });

  it("reads status from GET /api/cli/bugs/:id", async () => {
    const calls: Array<{ method: string; path: string; body: unknown }> = [];
    const client = makeClient(async (method, path, body) => {
      calls.push({ method, path, body });
      return { id: "bug_9", status: "open", title: "Crash" };
    });
    const command = new BugCommands({ client, readCredentials: makeReadCredentials() });
    const { output } = await captureConsole(() => command.status("bug_9", undefined, true));
    expect(calls).toEqual([{ method: "GET", path: "/api/cli/bugs/bug_9", body: undefined }]);
    expect(JSON.parse(output)).toMatchObject({
      success: true,
      id: "bug_9",
      url: "https://console.example/bugs/bug_9",
      bug: { status: "open" },
    });
  });

  it("lists my reports from GET /api/cli/bugs with pagination", async () => {
    const calls: Array<{ method: string; path: string }> = [];
    const client = makeClient(async (method, path) => {
      calls.push({ method, path });
      return {
        items: [
          { id: "bug_1", title: "One", severity: "low" },
          { id: "bug_2", title: "Two", severity: "high" },
        ],
      };
    });
    const command = new BugCommands({ client, readCredentials: makeReadCredentials() });
    const { output } = await captureConsole(() => command.list(undefined, "1", "0", true));
    expect(calls[0]).toEqual({ method: "GET", path: "/api/cli/bugs?limit=1&offset=0" });
    const payload = JSON.parse(output);
    expect(payload.total).toBe(2);
    expect(payload.items).toEqual([{ id: "bug_1", title: "One", severity: "low" }]);
    expect(payload.pagination.nextCommand).toContain("ravi bug list --json --limit 1 --offset 1");
  });
});

describe("bug agent-first contract", () => {
  it("blocks bug report without --execute (dry-run, exit 3, nothing leaves the machine)", async () => {
    const sensitiveTitle = "SENTINEL_SECRET_7M4Q";
    const sensitiveSummary = "PRIVATE_MESSAGE_8K2R";
    const calls: unknown[] = [];
    const client = makeClient(async (...args) => {
      calls.push(args);
      return {};
    });
    let credentialReads = 0;
    const command = new BugCommands({
      client,
      readCredentials: () => {
        credentialReads += 1;
        return makeCredentials();
      },
    });

    let thrown: unknown;
    try {
      await captureConsole(() =>
        command.report(
          sensitiveTitle,
          sensitiveSummary,
          "high",
          "console/pages",
          JSON.stringify({
            ...VALID_DOSSIER,
            title: sensitiveTitle,
            summary: sensitiveSummary,
            context: {
              organizationRef: "PRIVATE_ORG_3P9X",
              projectRef: "PRIVATE_PROJECT_3P9X",
              sessionHints: "C:/sentinel/private",
            },
          }),
          undefined,
          "https://private-console.invalid",
          true,
        ),
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ContractError);
    const contractError = thrown as InstanceType<typeof ContractError>;
    expect(contractError.exitCode).toBe(3);
    const envelope = contractError.envelope();
    expect(envelope.op).toBe("bug report");
    expect(envelope.error.code).toBe("WRITE_REQUIRES_EXECUTE");
    expect(envelope.error.dryRun).toBe(true);
    const plan = envelope.error.plan as Record<string, unknown>;
    expect(plan).toMatchObject({
      schemaVersion: BUG_REPORT_SCHEMA_ID,
      titlePresent: true,
      summaryChars: sensitiveSummary.length,
      severity: "high",
      surface: "console/pages",
      reproductionPresent: true,
      organizationRefPresent: true,
      projectRefPresent: true,
      sessionHintsPresent: true,
      collectionPrompt: BUG_REPORT_COLLECTION_PROMPT,
    });
    const serializedPlan = JSON.stringify(plan);
    expect(serializedPlan).not.toContain(sensitiveTitle);
    expect(serializedPlan).not.toContain(sensitiveSummary);
    expect(serializedPlan).not.toContain("PRIVATE_ORG_3P9X");
    expect(serializedPlan).not.toContain("PRIVATE_PROJECT_3P9X");
    expect(serializedPlan).not.toContain("C:/sentinel/private");
    expect(serializedPlan).not.toContain("https://private-console.invalid");
    expect(serializedPlan).toContain("ravi.bug_report/v1");
    expect(calls).toHaveLength(0);
    expect(credentialReads).toBe(0);
  });

  it("prints the collection prompt on a flagless dry-run without touching auth", async () => {
    let credentialReads = 0;
    const calls: unknown[] = [];
    const command = new BugCommands({
      client: makeClient(async (...args) => {
        calls.push(args);
        return {};
      }),
      readCredentials: () => {
        credentialReads += 1;
        return makeCredentials();
      },
    });

    const { output, error: thrown } = await captureConsoleAllowThrow(() =>
      command.report(undefined, undefined, undefined, undefined, undefined, undefined, undefined, false),
    );

    expect(thrown).toBeInstanceOf(ContractError);
    expect((thrown as InstanceType<typeof ContractError>).exitCode).toBe(3);
    expect(output).toContain(BUG_REPORT_COLLECTION_PROMPT);
    expect(calls).toHaveLength(0);
    expect(credentialReads).toBe(0);
  });

  it("fails fast on invalid --severity even in dry-run (PAYLOAD_INVALID, not exit 3)", async () => {
    const command = new BugCommands({
      client: makeClient(async () => ({})),
      readCredentials: makeReadCredentials(),
    });

    let thrown: unknown;
    try {
      await captureConsole(() =>
        command.report(undefined, undefined, "bogus", undefined, undefined, undefined, undefined, true),
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).not.toBeInstanceOf(ContractError);
    expect((thrown as { code?: string }).code).toBe("PAYLOAD_INVALID");
  });

  it("fails fast on broken --dossier-json even in dry-run", async () => {
    const command = new BugCommands({
      client: makeClient(async () => ({})),
      readCredentials: makeReadCredentials(),
    });

    let thrown: unknown;
    try {
      await captureConsole(() =>
        command.report(undefined, undefined, undefined, undefined, "{not-json", undefined, undefined, true),
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).not.toBeInstanceOf(ContractError);
    expect((thrown as { code?: string }).code).toBe("PAYLOAD_INVALID");
  });

  it("fails --execute without a complete dossier (PAYLOAD_INVALID)", async () => {
    const command = new BugCommands({
      client: makeClient(async () => ({})),
      readCredentials: makeReadCredentials(),
    });

    let thrown: unknown;
    try {
      await captureConsole(() =>
        command.report(undefined, undefined, undefined, undefined, undefined, undefined, undefined, true, true),
      );
    } catch (error) {
      thrown = error;
    }

    expect((thrown as { code?: string }).code).toBe("PAYLOAD_INVALID");
  });

  it("reads a dossier file on --execute", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ravi-bug-"));
    const file = join(dir, "dossier.json");
    writeFileSync(file, JSON.stringify(VALID_DOSSIER));
    const calls: Array<{ path: string; body: unknown }> = [];
    const command = new BugCommands({
      client: makeClient(async (_method, path, body) => {
        calls.push({ path, body });
        return { id: "bug_file" };
      }),
      readCredentials: makeReadCredentials(),
    });

    const { output } = await captureConsole(() =>
      command.report(undefined, undefined, undefined, undefined, undefined, file, undefined, true, true),
    );
    expect(calls[0]?.path).toBe("/api/cli/bugs");
    expect(calls[0]?.body).toMatchObject({
      title: VALID_DOSSIER.title,
      payload: { title: VALID_DOSSIER.title, source: "cli" },
    });
    expect(calls[0]?.body).not.toHaveProperty("source");
    expect(JSON.parse(output).id).toBe("bug_file");
  });
});

async function captureConsole<T>(run: () => T | Promise<T>): Promise<{ output: string; result: T }> {
  const captured = await captureConsoleAllowThrow(run);
  if (captured.error) throw captured.error;
  return { output: captured.output, result: captured.result as T };
}

async function captureConsoleAllowThrow<T>(
  run: () => T | Promise<T>,
): Promise<{ output: string; result?: T; error?: unknown }> {
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    const result = await run();
    return { output: lines.join("\n"), result };
  } catch (error) {
    return { output: lines.join("\n"), error };
  } finally {
    console.log = originalLog;
  }
}

function makeClient(
  handler: (method: string, path: string, body: unknown, accessToken: string) => Promise<unknown>,
): ConsoleApiClient {
  return {
    me: mock(async () => ({
      user: { email: "alice@example.com" },
      organization: { id: "org_1" },
    })),
    requestJson: mock(async (method: string, path: string, body: unknown, accessToken: string) =>
      handler(method, path, body, accessToken),
    ),
  } as unknown as ConsoleApiClient;
}

function makeReadCredentials() {
  return () => makeCredentials();
}

function makeCredentials(): CloudCredentials {
  return {
    version: 1,
    consoleUrl: "https://console.example",
    installationId: "ins_123",
    accessToken: "access-secret",
    refreshToken: "refresh-secret",
    accessTokenExpiresAt: "2026-05-10T00:00:00.000Z",
    refreshTokenExpiresAt: "2026-06-10T00:00:00.000Z",
    scopes: ["console.bugs"],
    user: { email: "alice@example.com" },
    organization: { id: "org_1", name: "Acme" },
    createdAt: "2026-05-09T00:00:00.000Z",
    updatedAt: "2026-05-09T00:00:00.000Z",
  };
}
