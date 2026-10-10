import { describe, expect, it, mock } from "bun:test";

import type { ConsoleApiClient } from "../cloud-auth/client.js";
import { CloudAuthError } from "../cloud-auth/errors.js";
import { cloudErrorToContractError, renderCloudContractError } from "../cli/cloud-error-contract.js";
import type { CloudCredentials } from "../cloud-auth/types.js";
import type { ContextRecord } from "../router/router-db.js";
import type { LinkApiClient } from "./client.js";
import { decodeExecContextHeader, type ConnectorTurnDeps } from "./connector-turn.js";
import {
  APPROVAL_HEADER,
  CONSOLE_CONNECT_START_PATH,
  connectorReconnectError,
  execCapability,
  listConnectors,
  pickDefaultConnector,
  startConnect,
  type ConnectorListItem,
  waitForConnectorApproval,
} from "./connectors.js";

const TERMINAL: ConnectorTurnDeps = { runtimeContext: { present: false, record: null } };

describe("connector link helpers", () => {
  it("starts a connection through the Console with the bearer, never Link", async () => {
    const consoleCalls: Array<{ method: string; path: string; body: unknown; accessToken?: string }> = [];
    const consoleClient = makeConsoleClient(async (method, path, body, accessToken) => {
      consoleCalls.push({ method, path, body, accessToken });
      return {
        connectUrl: "https://console.example/connect/tok_1",
        pendingGrantId: "grant_1",
        expiresAt: "2026-10-10T03:10:00.000Z",
      };
    });
    const link = makeLinkClient(async () => {
      throw new Error("Link should not be called to start a connection");
    });

    const result = await startConnect(
      { provider: "google", accessMode: "read_only", reconnectConnectionId: "conn_1", displayName: "Gmail Luis" },
      { consoleClient, link, readCredentials: makeReadCredentials(), turn: TERMINAL },
    );

    expect(consoleCalls).toEqual([
      {
        method: "POST",
        path: CONSOLE_CONNECT_START_PATH,
        accessToken: "access-secret",
        body: {
          provider: "google",
          accessMode: "read_only",
          reconnectConnectionId: "conn_1",
          displayName: "Gmail Luis",
        },
      },
    ]);
    expect(CONSOLE_CONNECT_START_PATH).toBe("/api/cli/connectors/connect/start");
    expect(result).toEqual({
      connectUrl: "https://console.example/connect/tok_1",
      pendingGrantId: "grant_1",
      expiresAt: "2026-10-10T03:10:00.000Z",
      userEmail: "alice@example.com",
    });
  });

  it("sends only the provider for a plain full-access connection", async () => {
    const bodies: unknown[] = [];
    const consoleClient = makeConsoleClient(async (_method, _path, body) => {
      bodies.push(body);
      return {
        connectUrl: "https://console.example/connect/tok_2",
        pendingGrantId: "g",
        expiresAt: "2026-10-10T03:10:00Z",
      };
    });

    await startConnect(
      { provider: "google" },
      { consoleClient, readCredentials: makeReadCredentials(), turn: TERMINAL },
    );

    expect(bodies).toEqual([{ provider: "google" }]);
  });

  it("rejects an incomplete Console answer", async () => {
    const consoleClient = makeConsoleClient(async () => ({ pendingGrantId: "grant_1" }));

    await expect(
      startConnect({ provider: "google" }, { consoleClient, readCredentials: makeReadCredentials(), turn: TERMINAL }),
    ).rejects.toMatchObject({ code: "SERVER_UNAVAILABLE" } satisfies Partial<CloudAuthError>);
  });

  it("blocks another person's turn before any Console or Link call", async () => {
    const consoleClient = makeConsoleClient(async () => {
      throw new Error("Console should not be called");
    });
    const link = makeLinkClient(async () => {
      throw new Error("Link should not be called");
    });

    await expect(
      listConnectors(
        {},
        {
          consoleClient,
          link,
          readCredentials: makeReadCredentials(),
          turn: {
            activeUserId: "user_alice",
            runtimeContext: {
              present: true,
              record: contextRecord({
                actorPrincipal: "contact:c_bob",
                actorResolution: "resolved",
                consoleUserId: "user_bob",
                agentIdentityCompartment: "dm:5511@s.whatsapp.net",
              }),
            },
          },
        },
      ),
    ).rejects.toMatchObject({ code: "CONNECTOR_SPEAKER_NOT_OWNER", exitCode: 3 } satisfies Partial<CloudAuthError>);
    expect((consoleClient.me as ReturnType<typeof mock>).mock.calls).toHaveLength(0);
  });

  it("refuses a stored session the Console says belongs to another user", async () => {
    const consoleClient = makeConsoleClient(async () => {
      throw new Error("Console should not be called");
    });
    (consoleClient as unknown as { me: unknown }).me = mock(async () => ({ user: { id: "user_bob" } }));
    const link = makeLinkClient(async () => {
      throw new Error("Link should not be called");
    });

    await expect(
      listConnectors(
        {},
        {
          consoleClient,
          link,
          readCredentials: makeReadCredentials(),
          turn: { ...TERMINAL, activeUserId: "user_alice" },
        },
      ),
    ).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    expect((link.request as ReturnType<typeof mock>).mock.calls).toHaveLength(0);
  });

  it("sends X-Ravi-Exec-Context built from the turn on exec", async () => {
    const seen: Array<{ path: string; headers?: Record<string, string> }> = [];
    const link = makeLinkClient(async (_method, path, _token, _body, options) => {
      seen.push({ path, headers: options?.headers });
      return { result: { messages: [] }, capability: "gmail.message.list", refreshed: false };
    });
    const record = contextRecord({
      actorPrincipal: "contact:c_alice",
      actorResolution: "resolved",
      consoleUserId: "user_alice",
      agentIdentityCompartment: "dm:5511@s.whatsapp.net",
      executorAgentId: "main",
    });

    await execCapability(
      { connectorId: "conn_1", capability: "gmail.message.list", parameters: {} },
      {
        consoleClient: makeConsoleClient(async () => ({})),
        link,
        readCredentials: makeReadCredentials(),
        turn: { activeUserId: "user_alice", runtimeContext: { present: true, record } },
      },
    );

    expect(seen[0]?.path).toBe("/cli/exec/conn_1");
    const header = seen[0]?.headers?.["X-Ravi-Exec-Context"];
    expect(header).toBeString();
    expect(decodeExecContextHeader(header!)).toMatchObject({
      v: 1,
      agentId: "main",
      speaker: { kind: "owner", contactId: "c_alice", consoleUserId: "user_alice" },
      conversation: "dm",
    });
    expect(seen[0]?.headers?.["X-Ravi-Step-Up"]).toBeUndefined();
  });

  it("turns a Link reauth answer into a private reconnect line for the owner", async () => {
    const link = makeLinkClient(async () => {
      throw new CloudAuthError(
        "CONNECTOR_REAUTH_REQUIRED",
        "Ravi Link request failed (409): connector_reauth_required",
        {
          status: 409,
        },
      );
    });

    await expect(
      execCapability(
        { connectorId: "conn_1", capability: "gmail.message.list", parameters: {} },
        {
          consoleClient: makeConsoleClient(async () => ({})),
          link,
          readCredentials: makeReadCredentials(),
          turn: TERMINAL,
        },
      ),
    ).rejects.toMatchObject({
      code: "CONNECTOR_REAUTH_REQUIRED",
      details: {
        source: "connector-turn",
        chatLine: "Your Gmail connection expired. Reconnect: https://console.example/connectors",
        replyTo: "owner_privately",
        reconnectLink: "https://console.example/connectors",
      },
    });
  });

  it("keeps the whole reconnect link in the public envelope and the human output", () => {
    const contract = cloudErrorToContractError(
      "gmail list",
      connectorReconnectError({ consoleUrl: "https://console.ravi.bot/", ownerName: "Luis Filipe" }),
    );
    const envelope = contract.envelope();

    expect(contract.exitCode).toBe(1);
    expect(envelope.error).toMatchObject({
      code: "CONNECTOR_REAUTH_REQUIRED",
      chatLine: "Your Gmail connection expired. Reconnect: https://console.ravi.bot/connectors",
      chatLinePt: "Sua conexão do Gmail expirou. Reconecte: https://console.ravi.bot/connectors",
      replyTo: "owner_privately",
      reconnectLink: "https://console.ravi.bot/connectors",
    });
    expect(JSON.stringify(envelope)).not.toContain("REDACTED");
    expect(envelope.error.message).toBe(
      'The Gmail connection expired. Tell Luis Filipe privately, never in a group: "Your Gmail connection expired. Reconnect: console.ravi.bot/connectors"',
    );

    const lines: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => lines.push(args.map(String).join(" "));
    try {
      renderCloudContractError(contract, false);
    } finally {
      console.error = originalError;
    }
    expect(lines).toContain(
      "Chat line (to the owner, privately): Your Gmail connection expired. Reconnect: https://console.ravi.bot/connectors",
    );
  });
});

describe("connector approvals", () => {
  const approvalAnswer = () =>
    new CloudAuthError("CONNECTOR_APPROVAL_REQUIRED", "Ravi Link request failed (409): connector_approval_required", {
      status: 409,
      details: { approvalId: "apr_123", expiresAt: "2026-10-10T12:00:00.000Z" },
    });

  it("sends the approval id on a re-run", async () => {
    const seen: Array<Record<string, string> | undefined> = [];
    const link = makeLinkClient(async (_method, _path, _token, _body, options) => {
      seen.push(options?.headers);
      return { result: {}, capability: "gmail.message.send", refreshed: false };
    });

    await execCapability(
      { connectorId: "conn_1", capability: "gmail.message.send", parameters: {}, approvalId: "apr_123" },
      {
        consoleClient: makeConsoleClient(async () => ({})),
        link,
        readCredentials: makeReadCredentials(),
        turn: TERMINAL,
      },
    );

    expect(seen[0]?.[APPROVAL_HEADER]).toBe("apr_123");
  });

  it("turns an approval answer into a link for the owner and the flag to re-run with", async () => {
    const link = makeLinkClient(async () => {
      throw approvalAnswer();
    });

    const error = (await execCapability(
      { connectorId: "conn_1", capability: "gmail.message.send", parameters: {} },
      {
        consoleClient: makeConsoleClient(async () => ({})),
        link,
        readCredentials: makeReadCredentials(),
        turn: TERMINAL,
      },
    ).catch((e) => e)) as CloudAuthError;

    expect(error.code).toBe("CONNECTOR_APPROVAL_REQUIRED");
    expect(error.details).toMatchObject({
      source: "connector-turn",
      approvalId: "apr_123",
      approvalLink: "https://console.example/connectors/approvals/apr_123",
      retryWith: "--approval apr_123",
      expiresAt: "2026-10-10T12:00:00.000Z",
      replyTo: "owner_privately",
      chatLine: "Please approve this Gmail action: https://console.example/connectors/approvals/apr_123",
    });

    const envelope = cloudErrorToContractError("gmail send", error).envelope();
    expect(cloudErrorToContractError("gmail send", error).exitCode).toBe(3);
    expect(envelope.error).toMatchObject({
      code: "CONNECTOR_APPROVAL_REQUIRED",
      approvalId: "apr_123",
      approvalLink: "https://console.example/connectors/approvals/apr_123",
      retryWith: "--approval apr_123",
      expiresAt: "2026-10-10T12:00:00.000Z",
    });
    expect(envelope.error.message).toContain("console.example/connectors/approvals/apr_123");
    expect(envelope.error.message).toContain("--approval apr_123");
    expect(JSON.stringify(envelope)).not.toContain("REDACTED");
  });

  it("polls the approval until the owner decides", async () => {
    const answers = ["pending", "pending", "approved"];
    const paths: string[] = [];
    const link = makeLinkClient(async (_method, path) => {
      paths.push(path);
      return { status: answers.shift() };
    });
    const sleeps: number[] = [];

    const outcome = await waitForConnectorApproval(
      "apr_123",
      {
        consoleClient: makeConsoleClient(async () => ({})),
        link,
        readCredentials: makeReadCredentials(),
        turn: TERMINAL,
      },
      { sleep: async (ms) => void sleeps.push(ms), now: () => 0 },
    );

    expect(outcome).toBe("approved");
    expect(paths).toEqual(["/cli/approvals/apr_123", "/cli/approvals/apr_123", "/cli/approvals/apr_123"]);
    expect(sleeps).toEqual([2_000, 2_000]);
  });

  it("reports a denial, an expiry and a timeout", async () => {
    const deps = (status: string) => ({
      consoleClient: makeConsoleClient(async () => ({})),
      link: makeLinkClient(async () => ({ status })),
      readCredentials: makeReadCredentials(),
      turn: TERMINAL,
    });
    expect(await waitForConnectorApproval("apr_1", deps("denied"), { sleep: async () => {} })).toBe("denied");
    expect(await waitForConnectorApproval("apr_1", deps("consumed"), { sleep: async () => {} })).toBe("expired");

    let clock = 0;
    expect(
      await waitForConnectorApproval("apr_1", deps("pending"), {
        sleep: async (ms) => {
          clock += ms;
        },
        now: () => clock,
        timeoutMs: 10_000,
      }),
    ).toBe("timeout");
    expect(clock).toBe(10_000);
  });
});

describe("pickDefaultConnector", () => {
  const base = { projectId: null, displayName: "Google", scopes: [] as string[], requiresReauth: false };

  it("prefers the live row marked default", () => {
    const connections: ConnectorListItem[] = [
      { ...base, id: "newest", provider: "google", status: "active", createdAt: "2026-10-01T00:00:00Z" },
      {
        ...base,
        id: "marked",
        provider: "google",
        status: "active",
        createdAt: "2026-01-01T00:00:00Z",
        isDefault: true,
      },
    ];

    expect(pickDefaultConnector(connections).connector?.id).toBe("marked");
  });

  it("falls back to the newest active row and skips history and reauth rows", () => {
    const connections: ConnectorListItem[] = [
      { ...base, id: "old", provider: "google", status: "active", createdAt: "2026-01-01T00:00:00Z" },
      {
        ...base,
        id: "gone",
        provider: "google",
        status: "revoked_by_user",
        createdAt: "2026-11-01T00:00:00Z",
        isDefault: true,
      },
      {
        ...base,
        id: "stale",
        provider: "google",
        status: "active",
        createdAt: "2026-10-05T00:00:00Z",
        requiresReauth: true,
      },
      { ...base, id: "new", provider: "google", status: "active", createdAt: "2026-09-01T00:00:00Z" },
      { ...base, id: "gh", provider: "github", status: "active", createdAt: "2026-12-01T00:00:00Z" },
    ];

    expect(pickDefaultConnector(connections).connector?.id).toBe("new");
  });

  it("skips a default row Link would not run and uses the newest active one", () => {
    for (const status of ["revoke_pending", "suspended", "degraded"]) {
      const connections: ConnectorListItem[] = [
        { ...base, id: "marked", provider: "google", status, createdAt: "2026-10-01T00:00:00Z", isDefault: true },
        { ...base, id: "other", provider: "google", status: "active", createdAt: "2026-01-01T00:00:00Z" },
      ];

      expect(pickDefaultConnector(connections).connector?.id).toBe("other");
    }
  });

  it("reports when only rows that need reconnecting remain", () => {
    const connections: ConnectorListItem[] = [
      {
        ...base,
        id: "stale",
        provider: "google",
        status: "active",
        createdAt: "2026-10-05T00:00:00Z",
        requiresReauth: true,
      },
    ];

    expect(pickDefaultConnector(connections)).toEqual({ connector: null, needsReconnect: true });
    expect(pickDefaultConnector([])).toEqual({ connector: null, needsReconnect: false });
  });
});

function contextRecord(metadata: Record<string, unknown>): ContextRecord {
  return {
    contextId: `ctx_${Math.random().toString(36).slice(2)}`,
    contextKey: "rctx_test",
    kind: "turn-runtime",
    agentId: "main",
    capabilities: [],
    metadata,
    createdAt: Date.now(),
  };
}

function makeConsoleClient(
  handler: (method: string, path: string, body: unknown, accessToken?: string) => Promise<unknown>,
): ConsoleApiClient {
  return {
    me: mock(async () => ({
      user: { email: "alice@example.com" },
      organization: { id: "org_1" },
    })),
    requestJson: mock(async (method: string, path: string, body: unknown, accessToken?: string) =>
      handler(method, path, body, accessToken),
    ),
  } as unknown as ConsoleApiClient;
}

function makeLinkClient(
  handler: (
    method: string,
    path: string,
    accessToken: string,
    body: unknown,
    options?: { headers?: Record<string, string> },
  ) => Promise<unknown>,
): LinkApiClient {
  return {
    request: mock(
      async (
        method: string,
        path: string,
        accessToken: string,
        body: unknown,
        options?: { headers?: Record<string, string> },
      ) => handler(method, path, accessToken, body, options),
    ),
  } as unknown as LinkApiClient;
}

function makeReadCredentials() {
  return () =>
    ({
      version: 1,
      consoleUrl: "https://console.example",
      installationId: "ins_123",
      accessToken: "access-secret",
      refreshToken: "refresh-secret",
      accessTokenExpiresAt: "2030-05-10T00:00:00.000Z",
      refreshTokenExpiresAt: "2030-06-10T00:00:00.000Z",
      scopes: ["console.projects.read", "console.projects.link"],
      user: { id: "user_alice", email: "alice@example.com" },
      organization: { id: "org_1", name: "Acme" },
      createdAt: "2026-05-09T00:00:00.000Z",
      updatedAt: "2026-05-09T00:00:00.000Z",
    }) satisfies CloudCredentials;
}
