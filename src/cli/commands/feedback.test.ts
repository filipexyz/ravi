import { afterAll, describe, expect, it, mock } from "bun:test";
import type { ConsoleApiClient } from "../../cloud-auth/client.js";
import type { CloudCredentials } from "../../cloud-auth/types.js";

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

const { FeedbackCommands } = await import("./feedback.js");
const { ContractError } = await import("../agent-contract.js");

describe("feedback CLI commands", () => {
  it("submits structured feedback through the Console CLI API with --execute", async () => {
    const calls: Array<{ method: string; path: string; body: unknown; accessToken: string }> = [];
    const client = makeClient(async (method, path, body, accessToken) => {
      calls.push({ method, path, body, accessToken });
      return {
        id: "fb_1",
        kind: "bug",
        severity: "high",
        message: "Pages links are hard to find",
      };
    });
    const command = new FeedbackCommands({ client, readCredentials: makeReadCredentials() });

    const { output } = await captureConsole(() =>
      command.send(
        ["Pages", "links", "are", "hard", "to", "find"],
        "bug",
        "high",
        "Pages nav",
        "console/pages",
        "rbbt",
        "https://console.example/p/rbbt/pages",
        "pages,ux",
        '{"route":"/p/rbbt/pages"}',
        undefined,
        true,
        true,
      ),
    );
    const payload = JSON.parse(output);

    expect(calls).toEqual([
      {
        method: "POST",
        path: "/api/cli/feedback",
        accessToken: "access-secret",
        body: {
          kind: "bug",
          severity: "high",
          title: "Pages nav",
          message: "Pages links are hard to find",
          surface: "console/pages",
          projectRef: "rbbt",
          url: "https://console.example/p/rbbt/pages",
          tags: ["pages", "ux"],
          source: "cli",
          metadata: { route: "/p/rbbt/pages" },
        },
      },
    ]);
    expect(payload).toMatchObject({
      success: true,
      consoleUrl: "https://console.example",
      feedback: {
        id: "fb_1",
        kind: "bug",
        severity: "high",
      },
      url: "https://console.example/org/feedback",
    });
  });
});

describe("feedback agent-first contract", () => {
  it("blocks feedback send without --execute (dry-run, exit 3, nothing leaves the machine)", async () => {
    const calls: unknown[] = [];
    const client = makeClient(async (...args) => {
      calls.push(args);
      return {};
    });
    let credentialReads = 0;
    const command = new FeedbackCommands({
      client,
      readCredentials: () => {
        credentialReads += 1;
        return makeCredentials();
      },
    });

    let thrown: unknown;
    try {
      await captureConsole(() =>
        command.send(
          ["Pages", "links", "are", "hard", "to", "find"],
          "bug",
          "high",
          "Pages nav",
          "console/pages",
          "rbbt",
          "https://console.example/p/rbbt/pages",
          "pages,ux",
          '{"route":"/p/rbbt/pages"}',
          undefined,
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
    expect(envelope.op).toBe("feedback send");
    expect(envelope.error.code).toBe("WRITE_REQUIRES_EXECUTE");
    expect(envelope.error.dryRun).toBe(true);
    const plan = envelope.error.plan as Record<string, unknown>;
    expect(plan).toMatchObject({
      kind: "bug",
      severity: "high",
      title: "Pages nav",
      message: "Pages links are hard to find",
      surface: "console/pages",
      project: "rbbt",
      tags: ["pages", "ux"],
      metadata: { route: "/p/rbbt/pages" },
    });
    // The brake fires before auth or any network call.
    expect(calls).toHaveLength(0);
    expect(credentialReads).toBe(0);
  });

  it("fails fast on invalid --kind even in dry-run (PAYLOAD_INVALID, not exit 3)", async () => {
    const command = new FeedbackCommands({
      client: makeClient(async () => ({})),
      readCredentials: makeReadCredentials(),
    });

    let thrown: unknown;
    try {
      await captureConsole(() =>
        command.send(
          ["oi"],
          "bogus",
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          true,
        ),
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).not.toBeInstanceOf(ContractError);
    expect((thrown as { code?: string }).code).toBe("PAYLOAD_INVALID");
  });

  it("fails fast on an empty message (PAYLOAD_INVALID)", async () => {
    const command = new FeedbackCommands({
      client: makeClient(async () => ({})),
      readCredentials: makeReadCredentials(),
    });

    let thrown: unknown;
    try {
      await captureConsole(() =>
        command.send(
          [],
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          true,
        ),
      );
    } catch (error) {
      thrown = error;
    }

    expect((thrown as { code?: string }).code).toBe("PAYLOAD_INVALID");
  });
});

async function captureConsole<T>(run: () => T | Promise<T>): Promise<{ output: string; result: T }> {
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    const result = await run();
    return { output: lines.join("\n"), result };
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
    scopes: ["console.feedback"],
    user: { email: "alice@example.com" },
    organization: { id: "org_1", name: "Acme" },
    createdAt: "2026-05-09T00:00:00.000Z",
    updatedAt: "2026-05-09T00:00:00.000Z",
  };
}
