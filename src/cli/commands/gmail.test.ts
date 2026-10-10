import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { CloudAuthError } from "../../cloud-auth/errors.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { cloudErrorToContractError } from "../cloud-error-contract.js";

// The default-connection paths of `ravi gmail`: the connections list is mocked
// so each case controls what Link answers, and exec is a recording spy.
const actualConnectorsModule = await import("../../link/connectors.js");
let listedConnections: Array<Record<string, unknown>> = [];
const execCalls: Array<Record<string, unknown>> = [];
let execFailure: Error | null = null;
mock.module("../../link/connectors.js", () => ({
  ...actualConnectorsModule,
  listConnectors: async () => listedConnections,
  execCapability: async (input: Record<string, unknown>) => {
    execCalls.push(input);
    if (execFailure) throw execFailure;
    return { result: { messages: [] }, capability: String(input.capability), refreshed: false };
  },
}));
const { GmailCommands } = await import("./gmail.js");

afterAll(() => mock.restore());

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-gmail-cli-test-");
  listedConnections = [];
  execCalls.length = 0;
  execFailure = null;
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

async function captureCloudError(fn: () => Promise<unknown>): Promise<CloudAuthError> {
  const originalLog = console.log;
  console.log = () => {};
  try {
    await fn();
  } catch (error) {
    if (error instanceof CloudAuthError) return error;
    throw error;
  } finally {
    console.log = originalLog;
  }
  throw new Error("expected the command to fail");
}

describe("gmail default connection", () => {
  it("asks for a connection when the person has no active Google connection", async () => {
    listedConnections = [
      { id: "gone", provider: "google", status: "revoked_by_user", requiresReauth: false, isDefault: true },
      { id: "gh", provider: "github", status: "active", requiresReauth: false },
    ];

    const error = await captureCloudError(() =>
      new GmailCommands().list(undefined, undefined, undefined, undefined, undefined, true),
    );
    const contract = cloudErrorToContractError("gmail list", error);

    expect(error.code).toBe("CONNECTOR_CONNECTION_REQUIRED");
    expect(contract.exitCode).toBe(1);
    expect(contract.envelope()).toMatchObject({
      success: false,
      op: "gmail list",
      error: {
        code: "CONNECTOR_CONNECTION_REQUIRED",
        message:
          "You have no active Google connection. Run `ravi connectors connect google` first, or pass --connector <id>.",
        retryable: false,
        suggestedAction: "ask the person to connect an account on the Console Connectors page",
      },
    });
    expect(execCalls).toHaveLength(0);
  });

  it("asks the owner, privately, to reconnect when only expired connections remain", async () => {
    listedConnections = [{ id: "stale", provider: "google", status: "active", requiresReauth: true }];

    const error = await captureCloudError(() => new GmailCommands().read("msg_1", undefined, undefined, true));
    const contract = cloudErrorToContractError("gmail read", error);

    expect(error.code).toBe("CONNECTOR_REAUTH_REQUIRED");
    expect(contract.exitCode).toBe(1);
    expect(contract.envelope()).toMatchObject({
      op: "gmail read",
      error: {
        code: "CONNECTOR_REAUTH_REQUIRED",
        message:
          'The Gmail connection expired. Tell the account owner privately, never in a group: "Your Gmail connection expired. Reconnect: console.ravi.bot/connectors"',
        chatLine: "Your Gmail connection expired. Reconnect: https://console.ravi.bot/connectors",
        replyTo: "owner_privately",
        reconnectLink: "https://console.ravi.bot/connectors",
        suggestedAction: "tell the account owner privately to reconnect it on the Console Connectors page",
      },
    });
    expect(execCalls).toHaveLength(0);
  });

  it("uses the active connection marked default", async () => {
    listedConnections = [
      { id: "newest", provider: "google", status: "active", requiresReauth: false, createdAt: "2026-10-01T00:00:00Z" },
      {
        id: "marked",
        provider: "google",
        status: "active",
        requiresReauth: false,
        isDefault: true,
        createdAt: "2026-01-01T00:00:00Z",
      },
    ];

    const originalLog = console.log;
    console.log = () => {};
    try {
      await new GmailCommands().list(undefined, undefined, undefined, undefined, undefined, true);
    } finally {
      console.log = originalLog;
    }

    expect(execCalls).toHaveLength(1);
    expect(execCalls[0]).toMatchObject({ connectorId: "marked", capability: "gmail.message.list" });
  });
});

describe("gmail send approvals", () => {
  function send(approval?: string) {
    return new GmailCommands().send(
      "bob@example.com",
      undefined,
      undefined,
      "Oi",
      "Corpo",
      undefined,
      undefined,
      "conn_1",
      true,
      approval,
      true,
    );
  }

  it("sends the approval id when the email is sent again after the owner approved", async () => {
    const originalLog = console.log;
    console.log = () => {};
    try {
      await send("apr_123");
    } finally {
      console.log = originalLog;
    }

    expect(execCalls).toHaveLength(1);
    expect(execCalls[0]).toMatchObject({
      connectorId: "conn_1",
      capability: "gmail.message.send",
      approvalId: "apr_123",
    });
  });

  it("rejects an approval id that is not one", async () => {
    const error = await captureCloudError(() => send("../x"));

    expect(error.code).toBe("PAYLOAD_INVALID");
    expect(execCalls).toHaveLength(0);
  });

  it("hands the approval answer back (exit 3) outside the operator's terminal", async () => {
    execFailure = actualConnectorsModule.connectorApprovalError(
      new CloudAuthError("CONNECTOR_APPROVAL_REQUIRED", "Ravi Link request failed (409): connector_approval_required", {
        status: 409,
        details: { approvalId: "apr_9" },
      }),
      { consoleUrl: "https://console.ravi.bot", ownerName: "Luis" },
    );

    // A runtime session, so the answer is handed back even when the test runs in a TTY.
    const previousSession = process.env.RAVI_SESSION_NAME;
    process.env.RAVI_SESSION_NAME = "agent-session";
    let error: CloudAuthError;
    try {
      error = await captureCloudError(() => send());
    } finally {
      if (previousSession === undefined) delete process.env.RAVI_SESSION_NAME;
      else process.env.RAVI_SESSION_NAME = previousSession;
    }
    const contract = cloudErrorToContractError("gmail send", error);

    expect(execCalls).toHaveLength(1);
    expect(contract.exitCode).toBe(3);
    expect(contract.envelope().error).toMatchObject({
      code: "CONNECTOR_APPROVAL_REQUIRED",
      approvalId: "apr_9",
      approvalLink: "https://console.ravi.bot/connectors/approvals/apr_9",
      retryWith: "--approval apr_9",
      replyTo: "owner_privately",
    });
  });
});
