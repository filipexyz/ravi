import { describe, expect, it, mock } from "bun:test";

import type { ConsoleApiClient } from "../cloud-auth/client.js";
import { CloudAuthError } from "../cloud-auth/errors.js";
import { cloudErrorToContractError, renderCloudContractError } from "../cli/cloud-error-contract.js";
import type { CloudCredentials } from "../cloud-auth/types.js";
import type { ContextRecord } from "../router/router-db.js";
import { LinkApiClient } from "./client.js";
import { decodeExecContextHeader, type ConnectorTurnDeps } from "./connector-turn.js";
import {
  APPROVAL_HEADER,
  CONSOLE_CONNECT_START_PATH,
  connectorReconnectError,
  execCapability,
  execCapabilityWithApproval,
  listConnectors,
  pickDefaultConnector,
  startConnect,
  type ConnectorListItem,
  type TerminalApprovalOptions,
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

  it("tells the owner, privately, when the organization turned Google off", async () => {
    const consoleClient = makeConsoleClient(async () => {
      throw new CloudAuthError("CONNECTOR_DISABLED_BY_ORG", "Console request failed (403)", { status: 403 });
    });

    const error = (await startConnect(
      { provider: "google" },
      { consoleClient, readCredentials: makeReadCredentials(), turn: TERMINAL },
    ).catch((e) => e)) as CloudAuthError;
    const contract = cloudErrorToContractError("connectors connect", error);

    expect(contract.exitCode).toBe(3);
    expect(contract.envelope().error).toMatchObject({
      code: "CONNECTOR_DISABLED_BY_ORG",
      replyTo: "owner_privately",
      chatLine:
        "Your organization turned off Google connections in Ravi Console. An organization owner or admin can turn them back on.",
    });
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
    expect(await waitForConnectorApproval("apr_1", deps("expired"), { sleep: async () => {} })).toBe("expired");
    expect(await waitForConnectorApproval("apr_1", deps("consumed"), { sleep: async () => {} })).toBe("used");
    expect(await waitForConnectorApproval("apr_1", deps("weird"), { sleep: async () => {} })).toBe("invalid");
    expect(await waitForConnectorApproval("../x", deps("approved"), { sleep: async () => {} })).toBe("invalid");

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

// A stand-in for link.ravi.so: the real LinkApiClient talks to it over a fake
// fetch, so status codes and bodies go through the same mapping as production.
const APPROVAL_ID = "3f2c8a1e-5b6d-4c7e-9f00-1a2b3c4d5e6f";

interface FakeWorkerCall {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

type FakeAnswer = [status: number, body: Record<string, unknown>];

function fakeWorker(
  handlers: {
    exec?: (call: FakeWorkerCall, index: number) => FakeAnswer;
    agentExec?: (call: FakeWorkerCall, index: number) => FakeAnswer;
    approval?: (call: FakeWorkerCall, index: number) => FakeAnswer;
  },
  turn: ConnectorTurnDeps = TERMINAL,
) {
  const calls: FakeWorkerCall[] = [];
  let execs = 0;
  let agentExecs = 0;
  let polls = 0;
  const link = new LinkApiClient({
    linkUrl: "https://link.test",
    fetch: async (url, init) => {
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
        headers[key.toLowerCase()] = value;
      }
      const call: FakeWorkerCall = {
        method: init?.method ?? "GET",
        path: url.replace("https://link.test", ""),
        headers,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      };
      calls.push(call);
      let answer: FakeAnswer = [404, { error: "not_found" }];
      if (call.method === "POST" && call.path.startsWith("/cli/exec/") && handlers.exec) {
        answer = handlers.exec(call, execs++);
      } else if (call.method === "POST" && call.path === "/cli/agent-exec" && handlers.agentExec) {
        answer = handlers.agentExec(call, agentExecs++);
      } else if (call.method === "GET" && call.path.startsWith("/cli/approvals/") && handlers.approval) {
        answer = handlers.approval(call, polls++);
      }
      return new Response(JSON.stringify({ requestId: "req_1", ...answer[1] }), {
        status: answer[0],
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  const deps = {
    consoleClient: makeConsoleClient(async () => ({})),
    link,
    readCredentials: makeReadCredentials(),
    turn,
  };
  return { calls, deps };
}

const approvalRequired = (code = "connector_approval_required"): FakeAnswer => [
  409,
  {
    error: code,
    approvalId: APPROVAL_ID,
    approvalUrl: `https://console.worker-side.example/connectors/approvals/${APPROVAL_ID}`,
    expiresAt: "2026-10-10T12:15:00.000Z",
    reason: "policy",
  },
];
const sent: FakeAnswer = [200, { result: { messageId: "m_1" }, capability: "gmail.message.send", refreshed: false }];
const SEND = {
  connectorId: "conn_1",
  capability: "gmail.message.send",
  parameters: { to: ["ana@example.com"], subject: "Oi", body: "Corpo" },
};

function terminalSpy(statusClock: { now: number } = { now: 0 }) {
  const opened: string[] = [];
  const lines: string[] = [];
  const sleeps: number[] = [];
  const terminal: TerminalApprovalOptions = {
    openExternal: (url) => void opened.push(url),
    log: (line) => void lines.push(line),
    sleep: async (ms) => {
      sleeps.push(ms);
      statusClock.now += ms;
    },
    now: () => statusClock.now,
  };
  return { terminal, opened, lines, sleeps };
}

describe("approval flow against a fake Worker", () => {
  it("at the operator's terminal opens the page, polls every 2 s, then sends once more with the approval", async () => {
    const statuses = ["pending", "pending", "approved"];
    const worker = fakeWorker({
      exec: (call) => (call.headers["x-ravi-approval"] === APPROVAL_ID ? sent : approvalRequired()),
      approval: () => [
        200,
        { status: statuses.shift(), expiresAt: "2026-10-10T12:15:00.000Z", capability: "gmail.message.send" },
      ],
    });
    const spy = terminalSpy();

    const result = await execCapabilityWithApproval(SEND, worker.deps, spy.terminal);

    expect(result).toMatchObject({ result: { messageId: "m_1" }, capability: "gmail.message.send" });
    expect(worker.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /cli/exec/conn_1",
      `GET /cli/approvals/${APPROVAL_ID}`,
      `GET /cli/approvals/${APPROVAL_ID}`,
      `GET /cli/approvals/${APPROVAL_ID}`,
      "POST /cli/exec/conn_1",
    ]);
    const [first, , , , retry] = worker.calls;
    expect(first?.headers["x-ravi-approval"]).toBeUndefined();
    expect(retry?.headers["x-ravi-approval"]).toBe(APPROVAL_ID);
    expect(retry?.headers["x-ravi-exec-context"]).toBeString();
    // The same action is sent again, so the Worker's parameter hash matches.
    expect(retry?.body).toEqual(first?.body);
    expect(spy.sleeps).toEqual([2_000, 2_000]);
    // The page comes from the Console of the active login, not from the Worker answer.
    const page = `https://console.example/connectors/approvals/${APPROVAL_ID}`;
    expect(spy.opened).toEqual([page]);
    expect(spy.lines).toContain(`Open: ${page}`);
    expect(spy.lines.join("\n")).not.toContain("worker-side");
  });

  it("also waits when the operator re-runs with an approval that is still pending", async () => {
    const statuses = ["pending", "approved"];
    const worker = fakeWorker({
      exec: (_call, index) => (index === 0 ? approvalRequired("connector_approval_pending") : sent),
      approval: () => [200, { status: statuses.shift() }],
    });
    const spy = terminalSpy();

    await execCapabilityWithApproval({ ...SEND, approvalId: APPROVAL_ID }, worker.deps, spy.terminal);

    const execs = worker.calls.filter((call) => call.method === "POST");
    expect(execs.map((call) => call.headers["x-ravi-approval"])).toEqual([APPROVAL_ID, APPROVAL_ID]);
  });

  it("anywhere else exits 3 with the approval link, the expiry and the flag to re-run with", async () => {
    const worker = fakeWorker({ exec: () => approvalRequired() });

    const error = (await execCapabilityWithApproval(SEND, worker.deps, null).catch((e) => e)) as CloudAuthError;
    const contract = cloudErrorToContractError("gmail send", error);

    expect(worker.calls).toHaveLength(1);
    expect(contract.exitCode).toBe(3);
    expect(contract.envelope().error).toMatchObject({
      code: "CONNECTOR_APPROVAL_REQUIRED",
      approvalId: APPROVAL_ID,
      approvalLink: `https://console.example/connectors/approvals/${APPROVAL_ID}`,
      expiresAt: "2026-10-10T12:15:00.000Z",
      retryWith: `--approval ${APPROVAL_ID}`,
      replyTo: "owner_privately",
      chatLine: `Please approve this Gmail action: https://console.example/connectors/approvals/${APPROVAL_ID}`,
    });
    expect(contract.message).toContain("never in a group");
    expect(contract.message).toContain(`--approval ${APPROVAL_ID}`);
    expect(JSON.stringify(contract.envelope())).not.toContain("worker-side");
  });

  it("--approval sends X-Ravi-Approval, and a pending approval exits 3 with the same details", async () => {
    const worker = fakeWorker({ exec: () => approvalRequired("connector_approval_pending") });

    const error = (await execCapabilityWithApproval({ ...SEND, approvalId: APPROVAL_ID }, worker.deps, null).catch(
      (e) => e,
    )) as CloudAuthError;
    const contract = cloudErrorToContractError("gmail send", error);

    expect(worker.calls[0]?.headers["x-ravi-approval"]).toBe(APPROVAL_ID);
    expect(contract.exitCode).toBe(3);
    expect(contract.envelope().error).toMatchObject({
      code: "CONNECTOR_APPROVAL_PENDING",
      approvalId: APPROVAL_ID,
      retryWith: `--approval ${APPROVAL_ID}`,
      expiresAt: "2026-10-10T12:15:00.000Z",
    });
  });

  it("stops with CONNECTOR_APPROVAL_DENIED (exit 3) when the owner declines while it waits", async () => {
    const statuses = ["pending", "denied"];
    const worker = fakeWorker({ exec: () => approvalRequired(), approval: () => [200, { status: statuses.shift() }] });
    const spy = terminalSpy();

    const error = (await execCapabilityWithApproval(SEND, worker.deps, spy.terminal).catch((e) => e)) as CloudAuthError;
    const contract = cloudErrorToContractError("gmail send", error);

    expect(worker.calls.filter((call) => call.method === "POST")).toHaveLength(1);
    expect(contract.exitCode).toBe(3);
    expect(contract.code).toBe("CONNECTOR_APPROVAL_DENIED");
    expect(contract.message).toBe("The approval was declined in Ravi Console, so this Gmail action was not done.");
  });

  it.each([
    ["expired", "expired before it was decided"],
    ["consumed", "was already used"],
  ])("stops with CONNECTOR_APPROVAL_INVALID (exit 1) when the approval is %s while it waits", async (status, why) => {
    const worker = fakeWorker({ exec: () => approvalRequired(), approval: () => [200, { status }] });
    const spy = terminalSpy();

    const error = (await execCapabilityWithApproval(SEND, worker.deps, spy.terminal).catch((e) => e)) as CloudAuthError;
    const contract = cloudErrorToContractError("gmail send", error);

    expect(worker.calls.filter((call) => call.method === "POST")).toHaveLength(1);
    expect(contract.exitCode).toBe(1);
    expect(contract.code).toBe("CONNECTOR_APPROVAL_INVALID");
    expect(contract.message).toContain(why);
    expect(contract.message).toContain("Run the same command again to ask for a new approval.");
  });

  it("treats an approval the Worker does not know for this user as invalid", async () => {
    const worker = fakeWorker({ exec: () => approvalRequired(), approval: () => [404, { error: "not_found" }] });
    const spy = terminalSpy();

    const error = (await execCapabilityWithApproval(SEND, worker.deps, spy.terminal).catch((e) => e)) as CloudAuthError;

    expect(error.code).toBe("CONNECTOR_APPROVAL_INVALID");
  });

  it("keeps waiting through a passing outage", async () => {
    const answers: FakeAnswer[] = [
      [503, { error: "internal_error" }],
      [200, { status: "approved" }],
    ];
    const worker = fakeWorker({
      exec: (call) => (call.headers["x-ravi-approval"] ? sent : approvalRequired()),
      approval: () => answers.shift()!,
    });
    const spy = terminalSpy();

    await execCapabilityWithApproval(SEND, worker.deps, spy.terminal);

    expect(worker.calls.filter((call) => call.method === "GET")).toHaveLength(2);
  });

  it("refreshes an expired bearer once while it waits, then goes on polling", async () => {
    const answers: FakeAnswer[] = [
      [401, { error: "unauthorized" }],
      [200, { status: "approved" }],
    ];
    const worker = fakeWorker({
      exec: (call) => (call.headers["x-ravi-approval"] ? sent : approvalRequired()),
      approval: () => answers.shift()!,
    });
    const spy = terminalSpy();

    await execCapabilityWithApproval(SEND, worker.deps, spy.terminal);

    expect(worker.calls.filter((call) => call.method === "GET")).toHaveLength(2);
    // The Console session is checked for the first exec, the wait, one
    // re-authentication after the 401 and the exec with the approval.
    expect(worker.deps.consoleClient.me).toHaveBeenCalledTimes(4);
    expect(spy.sleeps).toEqual([]);
  });

  it("stops with AUTH_EXPIRED when the bearer is still refused after one refresh", async () => {
    const worker = fakeWorker({
      exec: () => approvalRequired(),
      approval: () => [401, { error: "unauthorized" }],
    });
    const spy = terminalSpy();

    const error = (await execCapabilityWithApproval(SEND, worker.deps, spy.terminal).catch((e) => e)) as CloudAuthError;

    expect(error).toBeInstanceOf(CloudAuthError);
    expect(error.code).toBe("AUTH_EXPIRED");
    expect(worker.calls.filter((call) => call.method === "GET")).toHaveLength(2);
    expect(worker.deps.consoleClient.me).toHaveBeenCalledTimes(3);
    expect(spy.sleeps).toEqual([]);
  });

  it("keeps the approval when the approved action then asks for a step-up", async () => {
    const worker = fakeWorker({
      exec: (call) => {
        if (!call.headers["x-ravi-approval"]) return approvalRequired();
        if (!call.headers["x-ravi-step-up"]) {
          return [
            409,
            {
              error: "connector_stepup_required",
              challengeId: "chl_1",
              verificationUrl: "https://link.test/stepup/chl_1",
              expiresAt: "2026-10-10T12:05:00.000Z",
            },
          ];
        }
        return sent;
      },
      approval: () => [200, { status: "approved" }],
    });
    const spy = terminalSpy();
    const challenges: string[] = [];

    const result = await execCapabilityWithApproval(SEND, worker.deps, spy.terminal, async (challenge) => {
      challenges.push(challenge.challengeId);
      return "stepup-code";
    });

    expect(result).toMatchObject({ result: { messageId: "m_1" } });
    expect(challenges).toEqual(["chl_1"]);
    const execs = worker.calls.filter((call) => call.method === "POST");
    expect(
      execs.map((call) => [call.headers["x-ravi-approval"] ?? "-", call.headers["x-ravi-step-up"] ?? "-"]),
    ).toEqual([
      ["-", "-"],
      [APPROVAL_ID, "-"],
      [APPROVAL_ID, "stepup-code"],
    ]);
    // The owner approves once: no second approval is asked for.
    expect(worker.calls.filter((call) => call.method === "GET")).toHaveLength(1);
  });

  it("hands the approval answer back after 10 minutes without a decision", async () => {
    const worker = fakeWorker({ exec: () => approvalRequired(), approval: () => [200, { status: "pending" }] });
    const spy = terminalSpy();

    const error = (await execCapabilityWithApproval(SEND, worker.deps, spy.terminal).catch((e) => e)) as CloudAuthError;

    expect(error.code).toBe("CONNECTOR_APPROVAL_REQUIRED");
    expect(cloudErrorToContractError("gmail send", error).exitCode).toBe(3);
    expect(spy.sleeps.reduce((total, ms) => total + ms, 0)).toBe(10 * 60_000);
    expect(worker.calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });
});

describe("Worker connector answers on exec", () => {
  async function execAnswer(answer: FakeAnswer, capability = "gmail.message.send") {
    const worker = fakeWorker({ exec: () => answer });
    const error = (await execCapability({ ...SEND, capability }, worker.deps).catch((e) => e)) as CloudAuthError;
    return { error, contract: cloudErrorToContractError("gmail send", error) };
  }

  it("a denied approval exits 3 and tells the agent not to retry", async () => {
    const { contract } = await execAnswer([403, { error: "connector_approval_denied" }]);

    expect(contract.exitCode).toBe(3);
    expect(contract.envelope().error).toMatchObject({
      code: "CONNECTOR_APPROVAL_DENIED",
      chatLine: "Okay, I didn't do it: the approval was declined.",
      replyTo: "same_chat",
    });
    expect(contract.message).toContain("Do not run it again with this approval.");
  });

  it("an approval that does not cover the action exits 1 and says to ask again without --approval", async () => {
    const { contract } = await execAnswer([400, { error: "connector_approval_invalid" }]);

    expect(contract.exitCode).toBe(1);
    expect(contract.code).toBe("CONNECTOR_APPROVAL_INVALID");
    expect(contract.message).toContain("without --approval");
  });

  it("a blocked tool exits 3 with the line for the owner and the Connectors page", async () => {
    const { contract } = await execAnswer([403, { error: "connector_tool_blocked" }]);

    expect(contract.exitCode).toBe(3);
    expect(contract.envelope().error).toMatchObject({
      code: "CONNECTOR_TOOL_BLOCKED",
      replyTo: "owner_privately",
      reconnectLink: "https://console.example/connectors",
    });
    expect(String(contract.details.chatLine)).toContain("https://console.example/connectors");
    expect(contract.message).toContain("Do not retry it");
  });

  it("a connector the organization turned off exits 3 with the line for the owner", async () => {
    const { contract } = await execAnswer([403, { error: "connector_disabled_by_org" }], "gcal.freebusy.query");

    expect(contract.exitCode).toBe(3);
    expect(contract.code).toBe("CONNECTOR_DISABLED_BY_ORG");
    expect(contract.message).toContain("Google Calendar");
    expect(String(contract.details.chatLine)).toContain("organization owner or admin");
  });

  it("a read-only connection asked to write explains Allow writing", async () => {
    const { contract } = await execAnswer([403, { error: "connector_permission_required", accessMode: "read_only" }]);

    expect(contract.exitCode).toBe(1);
    expect(contract.code).toBe("CONNECTOR_PERMISSION_REQUIRED");
    expect(String(contract.details.chatLine)).toContain("read only");
    expect(String(contract.details.chatLine)).toContain("Allow writing");
    expect(JSON.stringify(contract.envelope())).not.toContain("REDACTED");
  });

  it.each([
    [403, "connector_group_blocked", "CONNECTOR_GROUP_BLOCKED", 3],
    [403, "connector_speaker_not_owner", "CONNECTOR_SPEAKER_NOT_OWNER", 3],
    [409, "connector_consent_required", "CONNECTOR_CONSENT_REQUIRED", 3],
    [403, "connector_not_linked", "CONNECTOR_NOT_LINKED", 3],
    [409, "connector_connection_required", "CONNECTOR_CONNECTION_REQUIRED", 1],
    [409, "connector_policy_above_ceiling", "CONNECTOR_POLICY_ABOVE_CEILING", 1],
    [403, "connector_forbidden", "CONNECTOR_FORBIDDEN", 1],
  ] as const)("%i %s → %s, exit %i, catalog copy", async (status, workerCode, cliCode, exit) => {
    const { contract } = await execAnswer([status, { error: workerCode }]);

    expect(contract.code).toBe(cliCode);
    expect(contract.exitCode).toBe(exit);
    expect(contract.message).not.toContain(workerCode);
    expect(contract.details.suggestedAction).toBeString();
  });
});

describe("agent exec (per-agent mode)", () => {
  const CONSENT_TOKEN = "cst_0123456789abcdefXYZ";
  const BOB_DM = {
    actorPrincipal: "contact:c_bob",
    actorResolution: "resolved",
    consoleUserId: "user_bob",
    consoleOrgId: "org_1",
    agentIdentityCompartment: "dm:5511888888888@s.whatsapp.net",
    executorAgentId: "main",
  };
  const ALICE_DM = { ...BOB_DM, actorPrincipal: "contact:c_alice", consoleUserId: "user_alice" };
  const LIST = { capability: "gmail.message.list", parameters: { q: "is:unread" } };
  const listed: FakeAnswer = [200, { result: { messages: [] }, capability: "gmail.message.list", refreshed: false }];

  function contactTurn(
    metadata: Record<string, unknown>,
    mode: "owner" | "person_asking" | "shared",
  ): ConnectorTurnDeps {
    return {
      activeUserId: "user_alice",
      activeOrgId: "org_1",
      ownerName: "Alice",
      runtimeContext: { present: true, record: contextRecord(metadata) },
      getAgentMode: () => mode,
      getAgentDisplayName: () => "Main agent",
      isPrivateDirectSession: () => true,
    };
  }

  async function agentAnswer(answer: FakeAnswer, mode: "person_asking" | "shared" = "person_asking") {
    const worker = fakeWorker({ agentExec: () => answer }, contactTurn(BOB_DM, mode));
    const error = (await execCapability(LIST, worker.deps).catch((e) => e)) as CloudAuthError;
    return { error, contract: cloudErrorToContractError("gmail list", error), calls: worker.calls };
  }

  it("sends a person-asking turn to /cli/agent-exec with the mode, the agent and only the contact id", async () => {
    const worker = fakeWorker({ agentExec: () => listed }, contactTurn(BOB_DM, "person_asking"));

    await execCapability({ ...LIST, expectedMode: "person_asking" }, worker.deps);

    expect(worker.calls).toHaveLength(1);
    const call = worker.calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.path).toBe("/cli/agent-exec");
    expect(call.body).toEqual({
      provider: "google",
      capability: "gmail.message.list",
      parameters: { q: "is:unread" },
      mode: "person_asking",
    });
    const context = decodeExecContextHeader(call.headers["x-ravi-exec-context"]!) as Record<string, unknown>;
    expect(context).toMatchObject({
      v: 1,
      agentId: "main",
      agentDisplayName: "Main agent",
      speaker: { kind: "contact", contactId: "c_bob" },
      conversation: "dm",
    });
    expect(JSON.stringify(context)).not.toContain("consoleUserId");
    expect(JSON.stringify(context)).not.toContain("user_bob");
  });

  it("sends a shared-mode contact turn with mode shared, and keeps the owner's own turn on /cli/exec", async () => {
    const shared = fakeWorker({ agentExec: () => listed }, contactTurn(BOB_DM, "shared"));
    await execCapability(LIST, shared.deps);
    expect(shared.calls[0]?.path).toBe("/cli/agent-exec");
    expect(shared.calls[0]?.body).toMatchObject({ mode: "shared" });

    const own = fakeWorker({ exec: () => listed, agentExec: () => listed }, contactTurn(ALICE_DM, "shared"));
    await execCapability({ ...LIST, connectorId: "conn_1" }, own.deps);
    expect(own.calls.map((call) => call.path)).toEqual(["/cli/exec/conn_1"]);
    expect(decodeExecContextHeader(own.calls[0]!.headers["x-ravi-exec-context"]!)).toMatchObject({
      speaker: { kind: "owner", contactId: "c_alice", consoleUserId: "user_alice" },
    });

    const explicit = fakeWorker({ exec: () => listed, agentExec: () => listed }, contactTurn(ALICE_DM, "shared"));
    await execCapability({ ...LIST, useShared: true }, explicit.deps);
    expect(explicit.calls.map((call) => call.path)).toEqual(["/cli/agent-exec"]);
    const header = decodeExecContextHeader(explicit.calls[0]!.headers["x-ravi-exec-context"]!);
    expect(header).toMatchObject({ speaker: { kind: "owner", contactId: "c_alice" } });
    expect(JSON.stringify(header)).not.toContain("consoleUserId");
  });

  it("refuses a run whose mode changed since the command chose its target", async () => {
    const worker = fakeWorker({ exec: () => listed, agentExec: () => listed }, contactTurn(BOB_DM, "person_asking"));

    await expect(execCapability({ ...LIST, expectedMode: "owner" }, worker.deps)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(worker.calls).toHaveLength(0);
  });

  it("refuses a person-asking turn whose direct chat shares its session with others, before any call", async () => {
    const worker = fakeWorker(
      { exec: () => listed, agentExec: () => listed },
      { ...contactTurn(BOB_DM, "person_asking"), isPrivateDirectSession: () => false },
    );

    const error = (await execCapability(LIST, worker.deps).catch((e) => e)) as CloudAuthError;
    const contract = cloudErrorToContractError("gmail list", error);

    expect(worker.calls).toHaveLength(0);
    expect(contract.exitCode).toBe(3);
    expect(contract.envelope().error).toMatchObject({
      code: "CONNECTOR_GROUP_BLOCKED",
      chatLine: "I can't use your Gmail in this conversation.",
      replyTo: "same_chat",
    });
  });

  it("a shared account that was disconnected or paused exits 3 without a retry", async () => {
    const { contract, calls } = await agentAnswer(
      [503, { error: "connector_unavailable", reason: "shared_connection_unavailable" }],
      "shared",
    );

    expect(calls).toHaveLength(1);
    expect(contract.exitCode).toBe(3);
    expect(contract.details.retryable).toBe(false);
    expect(contract.envelope().error).toMatchObject({
      code: "CONNECTOR_CONNECTION_REQUIRED",
      chatLine: "I can't use the shared Gmail account right now.",
      chatLinePt: "Não consigo usar a conta compartilhada do Gmail agora.",
      replyTo: "same_chat",
    });
    expect(contract.message).toContain("Do not retry");

    // Any other 503 is still an outage, retried as before.
    const outage = await agentAnswer([503, { error: "connector_unavailable" }], "shared");
    expect(outage.contract.code).toBe("SERVER_UNAVAILABLE");
    expect(outage.contract.details.retryable).toBe(true);
  });

  it("refuses the owner's own exec without a connection id, before any call", async () => {
    const worker = fakeWorker({ exec: () => listed });

    await expect(execCapability(LIST, worker.deps)).rejects.toMatchObject({ code: "PAYLOAD_INVALID" });
    expect(worker.calls).toHaveLength(0);
  });

  it("consent required exits 3 with the consent link rebuilt from the Console and the line for that person", async () => {
    const { contract, calls } = await agentAnswer([
      409,
      {
        error: "connector_consent_required",
        consentRequestId: "creq_1",
        consentUrl: `https://console.worker-side.example/connectors/consent/${CONSENT_TOKEN}`,
        expiresAt: "2026-10-10T13:00:00.000Z",
      },
    ]);
    const link = `https://console.example/connectors/consent/${CONSENT_TOKEN}`;

    expect(calls).toHaveLength(1);
    expect(contract.exitCode).toBe(3);
    const envelope = contract.envelope();
    expect(envelope.error).toMatchObject({
      code: "CONNECTOR_CONSENT_REQUIRED",
      chatLine: `To use your Gmail here, approve it once: ${link}`,
      chatLinePt: `Para eu usar o seu Gmail aqui, aprove uma vez: ${link}`,
      replyTo: "same_chat",
      consentLink: link,
      expiresAt: "2026-10-10T13:00:00.000Z",
    });
    expect(JSON.stringify(envelope)).not.toContain("worker-side");
    expect(JSON.stringify(envelope)).not.toContain("REDACTED");
    expect(JSON.stringify(envelope)).not.toContain("creq_1");
    expect(contract.message).toContain("agent main");
    expect(contract.message).toContain("never in a group");
    expect(contract.message).not.toContain(CONSENT_TOKEN);
  });

  it("consent required without a usable link asks to run the command again", async () => {
    for (const consentUrl of [
      "https://console.worker-side.example/connectors/approvals/short",
      "not a url",
      `https://console.worker-side.example/connectors/consent/${CONSENT_TOKEN}/../x`,
    ]) {
      const { contract } = await agentAnswer([409, { error: "connector_consent_required", consentUrl }]);

      expect(contract.exitCode).toBe(3);
      expect(contract.code).toBe("CONNECTOR_CONSENT_REQUIRED");
      expect(contract.details.consentLink).toBeUndefined();
      expect(contract.details.chatLine).toBeUndefined();
      expect(contract.message).toContain("Run the same command again");
    }
  });

  it("not linked exits 3 and tells the agent to ask the person to link with ravi link", async () => {
    const { contract } = await agentAnswer([403, { error: "connector_not_linked" }]);

    expect(contract.exitCode).toBe(3);
    expect(contract.envelope().error).toMatchObject({
      code: "CONNECTOR_NOT_LINKED",
      chatLine:
        "To use your Gmail here, first link this chat to your Ravi account. Want me to send you a private link to do it?",
      chatLinePt:
        "Para eu usar o seu Gmail aqui, primeiro vincule este chat à sua conta Ravi. Quer que eu te mande um link privado para isso?",
      replyTo: "same_chat",
    });
    // The command is for the agent only, never in the line the person reads.
    expect(contract.message).toContain("`ravi link`");
    expect(String(contract.details.chatLine)).not.toContain("ravi link");
    expect(String(contract.details.chatLinePt)).not.toContain("ravi link");

    const member = await agentAnswer([403, { error: "connector_not_linked", reason: "speaker_not_member" }]);
    expect(member.contract.exitCode).toBe(3);
    expect(String(member.contract.details.chatLine)).toContain("not part of this organization");
  });

  it("connection required exits 3 and asks the person to connect an account in the Console", async () => {
    const { contract } = await agentAnswer([
      409,
      { error: "connector_connection_required", connectorsUrl: "https://console.worker-side.example/connectors" },
    ]);

    expect(contract.exitCode).toBe(3);
    expect(contract.envelope().error).toMatchObject({
      code: "CONNECTOR_CONNECTION_REQUIRED",
      chatLine: "To use your Gmail here, connect it in Ravi Console first: https://console.example/connectors",
      chatLinePt:
        "Para eu usar o seu Gmail aqui, conecte ele no Ravi Console primeiro: https://console.example/connectors",
      replyTo: "same_chat",
      reconnectLink: "https://console.example/connectors",
    });
    expect(JSON.stringify(contract.envelope())).not.toContain("worker-side");
  });

  it("keeps connection required at exit 1 for the owner's own connection", async () => {
    const worker = fakeWorker({ exec: () => [409, { error: "connector_connection_required" }] });
    const error = await execCapability({ ...LIST, connectorId: "conn_1" }, worker.deps).catch((e) => e);

    expect(cloudErrorToContractError("gmail list", error).exitCode).toBe(1);
  });

  it("an approval for the person asking goes to them in this chat; a shared account's goes to its manager", async () => {
    const approval: FakeAnswer = [
      409,
      { error: "connector_approval_required", approvalId: APPROVAL_ID, expiresAt: "2026-10-10T12:15:00.000Z" },
    ];
    const asking = await agentAnswer(approval);
    expect(asking.contract.exitCode).toBe(3);
    expect(asking.contract.envelope().error).toMatchObject({
      code: "CONNECTOR_APPROVAL_REQUIRED",
      replyTo: "same_chat",
      approvalId: APPROVAL_ID,
    });

    const shared = await agentAnswer(approval, "shared");
    expect(shared.contract.exitCode).toBe(3);
    expect(shared.contract.envelope().error).toMatchObject({
      code: "CONNECTOR_APPROVAL_REQUIRED",
      replyTo: "same_chat",
    });
    expect(String(shared.contract.details.chatLine ?? "")).not.toContain("https://");
  });

  it("a shared account not shared for this conversation exits 3 with a line for the chat", async () => {
    const { contract } = await agentAnswer([403, { error: "connector_forbidden" }], "shared");

    expect(contract.exitCode).toBe(3);
    expect(contract.envelope().error).toMatchObject({
      code: "CONNECTOR_FORBIDDEN",
      chatLine: "I can't use a shared Gmail account in this conversation.",
      replyTo: "same_chat",
    });

    const group = await agentAnswer([403, { error: "connector_group_blocked" }], "shared");
    expect(group.contract.exitCode).toBe(3);
    expect(group.contract.details.chatLine).toBe("I can't use the shared account in this group.");
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
