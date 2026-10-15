// The sandbox listener end to end: real route table, real dispatch against a
// temp ravi.db with a task, fake JWKS origins, runtime-generated keys. No
// network is reached (Console `sandbox-gateway/listener` SPEC §Request
// Checks; OSS `.ravi/specs/sandbox/listener`).

import "reflect-metadata";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, setDefaultTimeout, test } from "bun:test";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { ADMIN_BOOTSTRAP_KIND, createRuntimeContext } from "../runtime/context-registry.js";
import { dbCreateAgent, dbUpdateAgent } from "../router/router-db.js";
import type { AuditEvent } from "../sdk/gateway/dispatcher.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import type { TestSigner } from "../test/sandbox-grant-tokens.js";
import type { SandboxListenerConfig } from "./config.js";
import type { SandboxListenerDeps, SandboxListenerHandle, SandboxListenerOutcome } from "./server.js";

// No NATS server in tests: `tasks report` emits task events after the write.
// Emitted events are captured so the production audit path can be asserted.
const natsEmits: Array<{ subject: string; payload: Record<string, unknown> }> = [];
const actualNatsModule = { ...(await import("../nats.js")) };
mock.module("../nats.js", () => ({
  ...actualNatsModule,
  publish: async () => {},
  nats: {
    ...actualNatsModule.nats,
    emit: async (subject: string, payload: Record<string, unknown>) => {
      natsEmits.push({ subject, payload });
    },
  },
}));

const { dbCreateTask } = await import("../tasks/task-db.js");
const { createSandboxRunAuthority, revokeSandboxRun } = await import("../sandbox/run-context.js");
const {
  acknowledgeServedJtis,
  dbAppendServedJti,
  dbGetSandboxRun,
  dbGetServedJtiOverflowAt,
  dbListUnacknowledgedServedJtis,
  ensureSandboxSchema,
} = await import("../sandbox/runs-db.js");
const {
  createSigner,
  fakeJwksOrigin,
  failingResponder,
  GATE_HEADER,
  GRANT_HEADER,
  grantClaims,
  jwksResponse,
  signCompact,
  TEST_ACCESS_AUD,
  TEST_ACCESS_CLIENT_ID,
  TEST_ACCESS_TEAM_DOMAIN,
  TEST_GRANT_JTI,
  TEST_INSTALLATION_A,
  TEST_RUN_ID,
} = await import("../test/sandbox-grant-tokens.js");
const { installationAudience, runSubject, SANDBOX_GATE_ISSUER, SANDBOX_GATE_JWKS_PATH } = await import("./contract.js");
const { sha256Base64url } = await import("./gate-assertion.js");
const { SANDBOX_LISTENER_MAX_BODY_BYTES, startSandboxListener } = await import("./server.js");

setDefaultTimeout(30_000);

const AGENT = "sandbox-worker";
const CONSOLE_ISSUER = "https://console.ravi.bot";
const TUNNEL_HOSTNAME = `${TEST_INSTALLATION_A}.tun.ravi.bot`;
const OTHER_RUN_ID = "sbr_zzzzzzzzzzzzzzzzzzzzzzzzzz";
const nowSeconds = () => Math.floor(Date.now() / 1000);
const encoder = new TextEncoder();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let access: TestSigner;
let otherAccess: TestSigner;
let gate: TestSigner;
let grantIssuer: TestSigner;
let stateDir: string | null = null;
let listener: SandboxListenerHandle | null = null;
let taskId: string;
let otherTaskId: string;
let grant: string;
let outcomes: SandboxListenerOutcome[] = [];
let audits: Array<{ event: AuditEvent; meta: { runId: string; requestId: string } }> = [];
let requestCounter = 0;

const config = (patch: Partial<SandboxListenerConfig> = {}): SandboxListenerConfig => ({
  port: 0,
  accessTeamDomain: TEST_ACCESS_TEAM_DOMAIN,
  accessAud: TEST_ACCESS_AUD,
  accessClientId: TEST_ACCESS_CLIENT_ID,
  installationId: TEST_INSTALLATION_A,
  consoleIssuer: CONSOLE_ISSUER,
  tunnelHostname: TUNNEL_HOSTNAME,
  driftLatched: false,
  ...patch,
});

const jwksByUrl = (url: string) => {
  if (url.includes("/cdn-cgi/access/certs")) return jwksResponse(access.jwks);
  if (url.endsWith(SANDBOX_GATE_JWKS_PATH)) return jwksResponse(gate.jwks);
  return jwksResponse(grantIssuer.jwks);
};

async function start(patch: Partial<SandboxListenerConfig> = {}, deps: SandboxListenerDeps = {}) {
  listener = await startSandboxListener({
    port: 0,
    config: config(patch),
    deps: {
      fetch: fakeJwksOrigin(jwksByUrl).fetch,
      jwksPersistDir: null,
      onOutcome: (outcome) => outcomes.push(outcome),
      emitAudit: (event, meta) => {
        audits.push({ event, meta });
      },
      ...deps,
    },
  });
  return listener;
}

const signGrant = (overrides: Record<string, unknown> = {}) =>
  signCompact(
    GRANT_HEADER,
    grantClaims({
      task: taskId,
      caps: [`mutate:task:${taskId}`, `read:task:${taskId}`],
      cmds: ["tasks.report", "tasks.show"],
      agent: AGENT,
      iat: nowSeconds() - 10,
      nbf: nowSeconds() - 10,
      exp: nowSeconds() + 600,
      ...overrides,
    }),
    grantIssuer.privateKey,
  );

const signAccess = (overrides: Record<string, unknown> = {}, key = access.privateKey) =>
  signCompact(
    { alg: "RS256", kid: access.kid },
    {
      iss: `https://${TEST_ACCESS_TEAM_DOMAIN}`,
      aud: [TEST_ACCESS_AUD],
      sub: "",
      type: "app",
      common_name: TEST_ACCESS_CLIENT_ID,
      iat: nowSeconds(),
      exp: nowSeconds() + 300,
      ...overrides,
    },
    key,
  );

const signAssertion = (
  input: { requestId: string; cmd: string; body: Uint8Array; grantJws: string },
  overrides: Record<string, unknown> = {},
  key = gate.privateKey,
) =>
  signCompact(
    GATE_HEADER,
    {
      iss: SANDBOX_GATE_ISSUER,
      aud: installationAudience(TEST_INSTALLATION_A),
      sub: runSubject(TEST_RUN_ID),
      jti: input.requestId,
      cmd: input.cmd,
      bodySha256: sha256Base64url(input.body),
      grantSha256: sha256Base64url(input.grantJws),
      iat: nowSeconds(),
      exp: nowSeconds() + 30,
      ...overrides,
    },
    key,
  );

function newRequestId() {
  requestCounter += 1;
  return `3f2504e0-4f89-41d3-9a0c-${requestCounter.toString(16).padStart(12, "0")}`;
}

interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
  json: () => unknown;
}

/** node:http so the target goes out raw (fetch would normalise `..`) and `Host` is ours to set. */
function raw(options: {
  method?: string;
  path: string;
  headers: Record<string, string>;
  body?: Uint8Array;
  port?: number;
}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: options.port ?? listener!.port,
        method: options.method ?? "POST",
        path: options.path,
        headers: { ...options.headers, ...(options.body ? { "content-length": String(options.body.length) } : {}) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json: () => JSON.parse(text) });
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

/**
 * A raw TCP request: Bun's node:http client normalises `/./` and `/../`
 * before sending, so traversal targets must be written on the wire by hand.
 */
function rawSocket(path: string, method = "POST"): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(listener!.port, "127.0.0.1", () => {
      socket.write(
        `${method} ${path} HTTP/1.1\r\nHost: ${TUNNEL_HOSTNAME}\r\nX-Ravi-Gate: 1\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
      );
    });
    let data = "";
    socket.on("data", (chunk) => {
      data += chunk.toString("utf8");
    });
    socket.on("error", reject);
    socket.on("close", () => {
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(data)?.[1] ?? 0);
      resolve({ status, text: data.slice(data.indexOf("\r\n\r\n") + 4) });
    });
  });
}

interface SendOptions {
  cmd?: string;
  path?: string;
  method?: string;
  body?: unknown;
  bodyBytes?: Uint8Array;
  requestId?: string | null;
  headers?: Record<string, string | undefined>;
  access?: string | null;
  assertion?: string | null;
  assertionOverrides?: Record<string, unknown>;
  assertionKey?: TestSigner["privateKey"];
  assertionBody?: Uint8Array;
  grantForHash?: string;
  port?: number;
}

/** A Gate-shaped request: every header the Gate sends, signed for this exact body and target. */
async function send(options: SendOptions = {}): Promise<RawResponse & { requestId: string | null }> {
  const cmd = options.cmd ?? "tasks.report";
  const path = options.path ?? `/api/v1/${cmd.replace(/\./g, "/")}`;
  const body =
    options.bodyBytes ??
    encoder.encode(JSON.stringify(options.body ?? { taskId, message: "progress from the sandbox" }));
  const requestId = options.requestId === undefined ? newRequestId() : options.requestId;
  const accessJwt = options.access === undefined ? await signAccess() : options.access;
  const assertion =
    options.assertion === undefined
      ? await signAssertion(
          {
            requestId: requestId ?? "",
            cmd,
            body: options.assertionBody ?? body,
            grantJws: options.grantForHash ?? grant,
          },
          options.assertionOverrides,
          options.assertionKey,
        )
      : options.assertion;
  const headers: Record<string, string | undefined> = {
    host: TUNNEL_HOSTNAME,
    "content-type": "application/json",
    "x-ravi-gate": "1",
    ...(requestId ? { "x-ravi-request-id": requestId } : {}),
    ...(accessJwt ? { "cf-access-jwt-assertion": accessJwt } : {}),
    ...(assertion ? { "x-ravi-gate-assertion": assertion } : {}),
    ...options.headers,
  };
  const defined = Object.fromEntries(
    Object.entries(headers).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  const response = await raw({ method: options.method, path, headers: defined, body, port: options.port });
  return { ...response, requestId };
}

const errorCode = (response: RawResponse) => (response.json() as { error: { code: string } }).error.code;
const lastOutcome = () => outcomes[outcomes.length - 1]!;

beforeAll(async () => {
  access = await createSigner("RS256", "access-key-1");
  otherAccess = await createSigner("RS256", "access-key-2");
  gate = await createSigner("ES256", "sandbox-gate-1");
  grantIssuer = await createSigner("ES256", "sandbox-grant-1");
});

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-sandbox-listener-");
  outcomes = [];
  audits = [];
  natsEmits.length = 0;
  taskId = dbCreateTask({ title: "Sandbox task", instructions: "Do the thing", createdBy: "test" }).task.id;
  otherTaskId = dbCreateTask({ title: "Another task", instructions: "Not yours", createdBy: "test" }).task.id;
  dbCreateAgent({ id: AGENT, cwd: `/tmp/${AGENT}` });
  dbUpdateAgent(AGENT, {
    defaults: {
      runtimePermissions: { profile: "explicit-only", capabilities: [`mutate:task:${taskId}`, `read:task:${taskId}`] },
    },
  });
  grant = await signGrant();
  createSandboxRunAuthority({
    runId: TEST_RUN_ID,
    jti: TEST_GRANT_JTI,
    agentId: AGENT,
    homeTaskId: taskId,
    caps: [`mutate:task:${taskId}`, `read:task:${taskId}`],
    cmds: ["tasks.report", "tasks.show"],
    grant,
    org: "org_123",
    installationId: TEST_INSTALLATION_A,
    expiresAt: (nowSeconds() + 600) * 1000,
  });
});

afterEach(async () => {
  await listener?.stop();
  listener = null;
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

afterAll(() => {
  mock.restore();
});

describe("sandbox listener", () => {
  test("serves `tasks report` from the run's child context, audited and marked", async () => {
    await start();
    const response = await send();
    expect(response.status).toBe(200);
    expect(response.headers["x-ravi-listener"]).toBe("1");
    expect(response.headers["content-type"]).toBe("application/json");
    const result = response.json() as { task: { id: string; status: string; progress: number } };
    expect(result.task.id).toBe(taskId);
    expect(result.task.status).toBe("in_progress");

    const run = dbGetSandboxRun(TEST_RUN_ID)!;
    expect(run.requestCount).toBe(1);
    expect(run.lastRequestAt).toBeNumber();
    expect(audits).toHaveLength(1);
    expect(audits[0]!.event).toMatchObject({
      group: "tasks",
      name: "report",
      outcome: "succeeded",
      contextId: run.contextId,
      parentContextId: run.rootContextId,
      agentId: AGENT,
    });
    expect(audits[0]!.meta).toEqual({ runId: TEST_RUN_ID, requestId: response.requestId! });
    expect(lastOutcome()).toMatchObject({
      requestId: response.requestId,
      runId: TEST_RUN_ID,
      cmd: "tasks.report",
      status: 200,
      code: null,
    });
    expect(dbListUnacknowledgedServedJtis().map((row) => [row.jti, row.runId, row.status])).toEqual([
      [response.requestId, TEST_RUN_ID, 200],
    ]);

    // `tasks show` reads with the concrete `read:task` cap.
    const shown = await send({ cmd: "tasks.show", body: { taskId } });
    expect(shown.status).toBe(200);
    expect((shown.json() as { task: { id: string } }).task.id).toBe(taskId);
  });

  test("refuses every unauthenticated or mis-authenticated request before it reaches a run", async () => {
    await start();
    const cases: Array<[string, SendOptions, number, string, string?]> = [
      ["no Gate marker", { headers: { "x-ravi-gate": undefined } }, 404, "not_found", "gate_marker_missing"],
      ["Host of another installation", { headers: { host: "other.tun.ravi.bot" } }, 421, "host_mismatch"],
      ["GET", { method: "GET" }, 404, "not_found"],
      ["missing Access JWT", { access: null }, 401, "access_invalid", "token_malformed"],
      [
        "Access JWT signed by another team's key",
        { access: await signAccess({}, otherAccess.privateKey) },
        401,
        "access_invalid",
        "signature_invalid",
      ],
      [
        "Access JWT for another service token",
        { access: await signAccess({ common_name: "someone-else.access" }) },
        401,
        "access_invalid",
        "common_name_mismatch",
      ],
      ["missing Gate assertion", { assertion: null }, 401, "gate_assertion_invalid", "token_malformed"],
      [
        "Gate assertion signed by the grant key",
        { assertionKey: grantIssuer.privateKey },
        401,
        "gate_assertion_invalid",
      ],
      [
        "Gate assertion over another body",
        { assertionBody: encoder.encode("{}") },
        401,
        "gate_assertion_invalid",
        "body_hash_mismatch",
      ],
      [
        "Gate assertion for another installation",
        { assertionOverrides: { aud: installationAudience("1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d") } },
        401,
        "gate_assertion_invalid",
        "audience_mismatch",
      ],
      [
        "Gate assertion naming a run this host never created",
        { assertionOverrides: { sub: runSubject(OTHER_RUN_ID) } },
        401,
        "grant_revoked",
        "run_unknown",
      ],
      [
        "Gate assertion over another grant's hash",
        { grantForHash: await signGrant({ jti: "99999999-9999-4999-8999-999999999999" }) },
        401,
        "gate_assertion_invalid",
        "grant_hash_mismatch",
      ],
      ["no request id", { requestId: null }, 401, "gate_assertion_invalid", "request_id_invalid"],
      [
        "a forwarded grant header",
        { headers: { "x-ravi-sandbox-grant": grant } },
        400,
        "body_invalid",
        "grant_header_present",
      ],
    ];
    for (const [label, options, status, code, reason] of cases) {
      const response = await send(options);
      expect(response.status, label).toBe(status);
      expect(errorCode(response), label).toBe(code);
      expect(response.headers["x-ravi-listener"], label).toBe("1");
      if (reason) expect(lastOutcome().reason, label).toBe(reason);
      // No refusal ever carries a token or a claim value.
      expect(response.text, label).not.toContain("eyJ");
    }
    expect(audits).toHaveLength(0);
  });

  test("a replayed Gate assertion is refused within one process and after a restart", async () => {
    const first = await start();
    const requestId = newRequestId();
    const ok = await send({ requestId });
    expect(ok.status).toBe(200);
    const replay = await send({ requestId });
    expect(replay.status).toBe(401);
    expect(errorCode(replay)).toBe("gate_assertion_invalid");
    expect(lastOutcome().reason).toBe("jti_replayed");
    // Both the accepted request and the refused replay were served once under this jti.
    expect(dbListUnacknowledgedServedJtis().map((row) => [row.jti, row.status])).toEqual([[requestId, 200]]);

    // Restart with the same state and the same start time: the persisted
    // queue, not `issued_before_start`, closes the window.
    await first.stop();
    listener = null;
    await start({}, { listenerStartedAt: first.startedAt });
    const afterRestart = await send({ requestId });
    expect(afterRestart.status).toBe(401);
    expect(lastOutcome().reason).toBe("jti_replayed");
    const fresh = await send();
    expect(fresh.status).toBe(200);
  });

  test("a revoked or expired run answers 401 grant_revoked", async () => {
    let offsetMs = 0;
    await start({}, { now: () => Date.now() + offsetMs });
    expect((await send()).status).toBe(200);
    revokeSandboxRun(TEST_RUN_ID, "operator_revoked");
    const revoked = await send();
    expect(revoked.status).toBe(401);
    expect(errorCode(revoked)).toBe("grant_revoked");
    expect(lastOutcome().reason).toBe("run_inactive");

    // A second run whose grant (and row) expire in 60 s; the listener clock then moves past it.
    const shortGrant = await signGrant({
      sub: runSubject(OTHER_RUN_ID),
      jti: "11111111-2222-4333-8444-555555555555",
      exp: nowSeconds() + 60,
    });
    createSandboxRunAuthority({
      runId: OTHER_RUN_ID,
      jti: "11111111-2222-4333-8444-555555555555",
      agentId: AGENT,
      homeTaskId: taskId,
      caps: [`mutate:task:${taskId}`, `read:task:${taskId}`],
      cmds: ["tasks.report", "tasks.show"],
      grant: shortGrant,
      org: "org_123",
      installationId: TEST_INSTALLATION_A,
      expiresAt: (nowSeconds() + 60) * 1000,
    });
    offsetMs = 120_000;
    const shifted = nowSeconds() + 120;
    const expired = await send({
      grantForHash: shortGrant,
      assertionOverrides: { sub: runSubject(OTHER_RUN_ID), iat: shifted, exp: shifted + 30 },
      access: await signAccess({ iat: shifted, exp: shifted + 300 }),
    });
    expect(expired.status).toBe(401);
    expect(errorCode(expired)).toBe("grant_revoked");
    expect(lastOutcome().reason).toBe("run_inactive");
  });

  test("binds the request to the stored grant: another run's grant or jti is 401 grant_revoked", async () => {
    await start();
    // The row says jti TEST_GRANT_JTI; the stored grant carries another jti.
    createSandboxRunAuthority({
      runId: OTHER_RUN_ID,
      jti: TEST_GRANT_JTI,
      agentId: AGENT,
      homeTaskId: taskId,
      caps: [`mutate:task:${taskId}`, `read:task:${taskId}`],
      cmds: ["tasks.report", "tasks.show"],
      grant: await signGrant({ jti: "22222222-2222-4222-8222-222222222222", sub: runSubject(OTHER_RUN_ID) }),
      org: "org_123",
      installationId: TEST_INSTALLATION_A,
      expiresAt: (nowSeconds() + 600) * 1000,
    });
    const jtiMismatch = await send({
      grantForHash: dbGetSandboxRun(OTHER_RUN_ID)!.grantJws!,
      assertionOverrides: { sub: runSubject(OTHER_RUN_ID) },
    });
    expect(jtiMismatch.status).toBe(401);
    expect(errorCode(jtiMismatch)).toBe("grant_revoked");
    expect(lastOutcome().reason).toBe("run_binding_mismatch");

    // A stored grant that no longer verifies (another installation's) is 401 grant_invalid.
    const wrongInstallation = await signGrant({
      sub: runSubject("sbr_yyyyyyyyyyyyyyyyyyyyyyyyyy"),
      aud: installationAudience("1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"),
      inst: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
      jti: "33333333-3333-4333-8333-333333333333",
    });
    createSandboxRunAuthority({
      runId: "sbr_yyyyyyyyyyyyyyyyyyyyyyyyyy",
      jti: "33333333-3333-4333-8333-333333333333",
      agentId: AGENT,
      homeTaskId: taskId,
      caps: [`mutate:task:${taskId}`],
      cmds: ["tasks.report"],
      grant: wrongInstallation,
      org: "org_123",
      installationId: TEST_INSTALLATION_A,
      expiresAt: (nowSeconds() + 600) * 1000,
    });
    const invalid = await send({
      grantForHash: wrongInstallation,
      assertionOverrides: { sub: runSubject("sbr_yyyyyyyyyyyyyyyyyyyyyyyyyy") },
    });
    expect(invalid.status).toBe(401);
    expect(errorCode(invalid)).toBe("grant_invalid");
    expect(lastOutcome().reason).toBe("audience_mismatch");
  });

  test("routes only the static allowlist: anything else is 404 before any token is read", async () => {
    await start();
    for (const path of [
      "/api/v1/agents/permissions",
      "/api/v1/tasks/watch",
      "/api/v1/tasks/comment",
      "/api/v1/_meta/registry",
      "/api/v1/tasks/_stream",
      "/api/v1/../tasks/report",
      "/api/v1/tasks/%72eport",
      "/api/v1/tasks//report",
      "/api/v1/tasks/./report",
      "/api/v1/Tasks/report",
      "/api/v1/tasks/report/",
      "/api/v1/tasks/report?x=1",
      "/healthz",
      "/",
    ]) {
      const response = await rawSocket(path);
      expect(response.status, path).toBe(404);
      expect((JSON.parse(response.text) as { error: { code: string } }).error.code, path).toBe("not_found");
    }
    expect((await rawSocket("/api/v1/tasks/report", "GET")).status).toBe(404);
    // Static but outside this run's grant.
    const notGranted = await send({ cmd: "tasks.done", body: { taskId, summary: "done" } });
    expect(notGranted.status).toBe(403);
    expect(errorCode(notGranted)).toBe("command_not_allowed");
    expect(audits).toHaveLength(0);
  });

  test("authorizes the concrete home task only", async () => {
    await start();
    const otherTask = await send({ body: { taskId: otherTaskId, message: "not mine" } });
    expect(otherTask.status).toBe(403);
    expect(errorCode(otherTask)).toBe("resource_forbidden");
    expect(lastOutcome().reason).toBe("task_mismatch");
    expect(audits).toHaveLength(0);
  });

  test("a grant cap the agent lacks is dropped, so the matching command is denied at dispatch", async () => {
    revokeSandboxRun(TEST_RUN_ID);
    dbCreateAgent({ id: "narrow", cwd: "/tmp/narrow" });
    dbUpdateAgent("narrow", {
      defaults: { runtimePermissions: { profile: "explicit-only", capabilities: [`mutate:task:${taskId}`] } },
    });
    const narrowGrant = await signGrant({
      sub: runSubject(OTHER_RUN_ID),
      jti: "44444444-4444-4444-8444-444444444444",
      agent: "narrow",
    });
    const { droppedCaps } = createSandboxRunAuthority({
      runId: OTHER_RUN_ID,
      jti: "44444444-4444-4444-8444-444444444444",
      agentId: "narrow",
      homeTaskId: taskId,
      caps: [`mutate:task:${taskId}`, `read:task:${taskId}`],
      cmds: ["tasks.report", "tasks.show"],
      grant: narrowGrant,
      org: "org_123",
      installationId: TEST_INSTALLATION_A,
      expiresAt: (nowSeconds() + 600) * 1000,
    });
    expect(droppedCaps).toEqual([`read:task:${taskId}`]);
    await start();
    const sendAsNarrow = (options: SendOptions) =>
      send({ ...options, grantForHash: narrowGrant, assertionOverrides: { sub: runSubject(OTHER_RUN_ID) } });
    const denied = await sendAsNarrow({ cmd: "tasks.show", body: { taskId } });
    expect(denied.status).toBe(403);
    expect(errorCode(denied)).toBe("resource_forbidden");
    expect(lastOutcome().reason).toBe("dispatch_denied");
    expect(audits.map((audit) => audit.event.outcome)).toEqual(["denied"]);
    const allowed = await sendAsNarrow({ cmd: "tasks.report" });
    expect(allowed.status).toBe(200);
  });

  test("validates the body: flat declared fields, `taskId` required, `cwd` refused, 2 MiB cap", async () => {
    await start();
    const cases: Array<[string, SendOptions, number, string]> = [
      ["cwd", { body: { taskId, message: "x", cwd: "/" } }, 400, "body_invalid"],
      ["unknown field", { body: { taskId, message: "x", extra: 1 } }, 400, "body_invalid"],
      ["array body", { body: [taskId] }, 400, "body_invalid"],
      ["not JSON", { bodyBytes: encoder.encode("{nope") }, 400, "body_invalid"],
      ["missing taskId", { body: { message: "x" } }, 400, "body_invalid"],
      ["taskId of the wrong type", { body: { taskId: 7, message: "x" } }, 400, "argument_invalid"],
      ["progress of the wrong type", { body: { taskId, message: "x", progress: 50 } }, 400, "argument_invalid"],
    ];
    for (const [label, options, status, code] of cases) {
      const response = await send(options);
      expect(response.status, label).toBe(status);
      expect(errorCode(response), label).toBe(code);
    }
    // A failure inside the command is the daemon's own envelope, passed through with the marker.
    const commandFailed = await send({ body: { taskId, message: "" } });
    expect(commandFailed.status).toBe(422);
    expect(commandFailed.headers["x-ravi-listener"]).toBe("1");
    expect(commandFailed.json()).toMatchObject({ success: false, error: { code: "COMMAND_FAILED" } });
    expect(lastOutcome()).toMatchObject({ status: 422, code: null });

    const huge = new Uint8Array(SANDBOX_LISTENER_MAX_BODY_BYTES + 1).fill(0x20);
    const tooLarge = await send({ bodyBytes: huge, access: null, assertion: null });
    expect(tooLarge.status).toBe(413);
    expect(errorCode(tooLarge)).toBe("payload_too_large");
    const exact = new Uint8Array(SANDBOX_LISTENER_MAX_BODY_BYTES).fill(0x20);
    const atLimit = await send({ bodyBytes: exact });
    expect(atLimit.status).toBe(400);
    expect(errorCode(atLimit)).toBe("body_invalid");
  });

  test("never reads Authorization: a valid operator context key buys nothing", async () => {
    await start();
    const admin = createRuntimeContext({
      kind: ADMIN_BOOTSTRAP_KIND,
      capabilities: [{ permission: "admin", objectType: "system", objectId: "*" }],
    });
    const response = await send({
      access: null,
      assertion: null,
      headers: { authorization: `Bearer ${admin.contextKey}` },
    });
    expect(response.status).toBe(401);
    expect(errorCode(response)).toBe("access_invalid");
    expect(audits).toHaveLength(0);
  });

  test("refuses to bind anywhere but loopback and to start without the common_name pin", async () => {
    await expect(
      startSandboxListener({ port: 0, host: "0.0.0.0", config: config(), deps: { jwksPersistDir: null } }),
    ).rejects.toThrow(/127\.0\.0\.1 only/);
    await expect(
      startSandboxListener({ port: 0, config: config({ accessClientId: "" }), deps: { jwksPersistDir: null } }),
    ).rejects.toThrow(/clientId/);
  });

  test("a JWKS cold start with the origin down is 503, never 401", async () => {
    await start({}, { fetch: fakeJwksOrigin(failingResponder).fetch });
    const response = await send();
    expect(response.status).toBe(503);
    expect(errorCode(response)).toBe("jwks_unavailable");
    expect(response.headers["x-ravi-listener"]).toBe("1");
  });

  test("the drift latch refuses everything with 503 tunnel_drift until cleared", async () => {
    const handle = await start();
    handle.setDriftLatched(true);
    expect(handle.isDriftLatched()).toBe(true);
    const latched = await send();
    expect(latched.status).toBe(503);
    expect(errorCode(latched)).toBe("tunnel_drift");
    handle.setDriftLatched(false);
    expect((await send()).status).toBe(200);
    const fromSettings = await startSandboxListener({
      port: 0,
      config: config({ driftLatched: true }),
      deps: { jwksPersistDir: null, fetch: fakeJwksOrigin(jwksByUrl).fetch },
    });
    try {
      expect((await send({ port: fromSettings.port })).status).toBe(503);
    } finally {
      await fromSettings.stop();
    }
  });

  test("rate limits per run and overall with 429 rate_limited", async () => {
    await start({}, { limits: { perRunPerMinute: 2 } });
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200);
    const limited = await send();
    expect(limited.status).toBe(429);
    expect(errorCode(limited)).toBe("rate_limited");
    expect(limited.headers["retry-after"]).toBe("1");
  });

  test("persists every served jti, accepted or refused, before the response; a failed append closes the socket", async () => {
    const appended: Array<{ jti: string; status: number; beforeResponse: boolean }> = [];
    let responded = false;
    let failAppend = false;
    await start(
      {},
      {
        appendServedJti: (input) => {
          if (failAppend) throw new Error("disk full");
          appended.push({ jti: input.jti, status: input.status, beforeResponse: !responded });
          return dbAppendServedJti(input);
        },
      },
    );
    const ok = await send();
    responded = true;
    const refused = await send({ access: null });
    const noId = await send({ requestId: null });
    expect(ok.status).toBe(200);
    expect(refused.status).toBe(401);
    expect(noId.status).toBe(401);
    expect(appended).toEqual([
      { jti: ok.requestId!, status: 200, beforeResponse: true },
      { jti: refused.requestId!, status: 401, beforeResponse: false },
    ]);
    expect(dbListUnacknowledgedServedJtis().map((row) => row.jti)).toEqual([ok.requestId!, refused.requestId!]);

    failAppend = true;
    await expect(send()).rejects.toThrow();
    expect(dbListUnacknowledgedServedJtis()).toHaveLength(2);
  });
});

/** Raw bytes on the wire, for header shapes node:http clients would not send. */
function rawWire(lines: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(listener!.port, "127.0.0.1", () => socket.write(lines));
    let data = "";
    socket.on("data", (chunk) => {
      data += chunk.toString("utf8");
    });
    socket.on("error", reject);
    socket.on("close", () => {
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(data)?.[1] ?? 0);
      resolve({ status, text: data });
    });
  });
}

// Each of these failed on 71f26661 (the 04b review probes) and passes after the fix round.
describe("sandbox listener: 04b review regressions", () => {
  test("a restart never reopens the replay window of an assertion the Gate dated ahead of our clock", async () => {
    // Gate clock 55 s ahead; listener restarted 30 s later; replay at +130 s,
    // inside the assertion's exp + 60 s grace but past servedAt + 120 s.
    let offsetMs = 0;
    const now = () => Date.now() + offsetMs;
    const first = await start({}, { now });
    const requestId = newRequestId();
    const body = encoder.encode(JSON.stringify({ taskId, message: "progress from the sandbox" }));
    const t = nowSeconds();
    const assertion = await signAssertion(
      { requestId, cmd: "tasks.report", body, grantJws: grant },
      { iat: t + 55, exp: t + 115 },
    );
    const ok = await send({ requestId, bodyBytes: body, assertion });
    expect(ok.status).toBe(200);
    expect(dbListUnacknowledgedServedJtis().map((row) => [row.jti, row.assertionExp])).toEqual([[requestId, t + 115]]);
    await first.stop();
    listener = null;

    offsetMs = 30_000;
    await start({}, { now });
    offsetMs = 130_000;
    const replay = await send({
      requestId,
      bodyBytes: body,
      assertion,
      access: await signAccess({ iat: t + 120, exp: t + 400 }),
    });
    expect(replay.status).toBe(401);
    expect(errorCode(replay)).toBe("gate_assertion_invalid");
    expect(lastOutcome().reason).toBe("jti_replayed");
    // The command ran once.
    expect(dbGetSandboxRun(TEST_RUN_ID)!.requestCount).toBe(1);
    expect(audits).toHaveLength(1);
  });

  test("a served jti without a recorded exp is preloaded for servedAt + lifetime + skew + grace", async () => {
    // A row from before `assertion_exp` existed, served 170 s ago: still inside the 180 s bound.
    const requestId = newRequestId();
    ensureSandboxSchema();
    dbAppendServedJti({ jti: requestId, runId: TEST_RUN_ID, status: 200, servedAt: Date.now() - 170_000 });
    await start({}, { listenerStartedAt: nowSeconds() - 1 });
    const replay = await send({ requestId });
    expect(replay.status).toBe(401);
    expect(lastOutcome().reason).toBe("jti_replayed");
  });

  test("2048 wrong-Host requests are marked but never queued: no overflow, the admitted jti survives", async () => {
    await start();
    const ok = await send();
    expect(ok.status).toBe(200);
    for (let i = 0; i < 2048; i += 1) {
      const refused = await raw({ path: "/", headers: { host: "evil.example", "x-ravi-request-id": newRequestId() } });
      if (refused.status !== 421 || refused.headers["x-ravi-listener"] !== "1") {
        throw new Error(`unexpected ${refused.status}`);
      }
    }
    // Routing refusals before any token is read are not queued either.
    const unrouted = await send({ path: "/api/v1/tasks/comment", cmd: "tasks.comment" });
    expect(unrouted.status).toBe(404);
    expect(unrouted.headers["x-ravi-listener"]).toBe("1");
    const unmarked = await send({ headers: { "x-ravi-gate": undefined } });
    expect(unmarked.status).toBe(404);

    expect(dbListUnacknowledgedServedJtis(4096).map((row) => row.jti)).toEqual([ok.requestId!]);
    expect(dbGetServedJtiOverflowAt()).toBeNull();
    // A refusal after the Host and routing checks is still queued.
    const refused = await send({ access: null });
    expect(refused.status).toBe(401);
    expect(dbListUnacknowledgedServedJtis(4096).map((row) => row.jti)).toEqual([ok.requestId!, refused.requestId!]);
  }, 120_000);

  test("a timed-out dispatch keeps its concurrency slot until it actually settles", async () => {
    let releaseFirst: () => void = () => {};
    const firstSettled = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let auditCalls = 0;
    await start(
      {},
      {
        limits: { dispatchTimeoutMs: 50, perRunConcurrency: 1 },
        emitAudit: async () => {
          auditCalls += 1;
          // The first dispatch hangs until released; later ones finish at once.
          if (auditCalls === 1) await firstSettled;
        },
      },
    );
    const first = await send();
    expect(first.status).toBe(504);
    expect(errorCode(first)).toBe("timeout");

    const second = await send();
    expect(second.status).toBe(429);
    expect(errorCode(second)).toBe("rate_limited");
    expect(lastOutcome().reason).toBe("concurrency");

    releaseFirst();
    await sleep(20);
    const third = await send();
    expect(third.status).toBe(200);
  });

  test("wire variants: a repeated header is its last value; Host and routing refusals are not queued", async () => {
    await start();
    const tail = (id: string) =>
      `X-Ravi-Request-Id: ${id}\r\nX-Ravi-Gate: 1\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`;
    const line = (target: string) => `POST ${target} HTTP/1.1\r\n`;
    const cases: Array<[string, (id: string) => string, number]> = [
      // Bun collapses a repeated Host to its last line.
      [
        "dupHostEvilFirst",
        (id) => `${line("/api/v1/tasks/report")}Host: evil.example\r\nHost: ${TUNNEL_HOSTNAME}\r\n${tail(id)}`,
        401,
      ],
      [
        "dupHostGoodFirst",
        (id) => `${line("/api/v1/tasks/report")}Host: ${TUNNEL_HOSTNAME}\r\nHost: evil.example\r\n${tail(id)}`,
        421,
      ],
      ["hostWithPort", (id) => `${line("/api/v1/tasks/report")}Host: ${TUNNEL_HOSTNAME}:443\r\n${tail(id)}`, 421],
      ["noHost10", (id) => `POST /api/v1/tasks/report HTTP/1.0\r\n${tail(id)}`, 421],
      [
        "absoluteForm",
        (id) => `${line(`http://${TUNNEL_HOSTNAME}/api/v1/tasks/report`)}Host: ${TUNNEL_HOSTNAME}\r\n${tail(id)}`,
        404,
      ],
      ["semicolon", (id) => `${line("/api/v1/tasks/report;x")}Host: ${TUNNEL_HOSTNAME}\r\n${tail(id)}`, 404],
      ["backslash", (id) => `${line("/api/v1/tasks\\report")}Host: ${TUNNEL_HOSTNAME}\r\n${tail(id)}`, 404],
      // A repeated routing marker collapses to "1" and passes routing.
      [
        "dupMarker",
        (id) => `${line("/api/v1/tasks/report")}Host: ${TUNNEL_HOSTNAME}\r\nX-Ravi-Gate: 1\r\n${tail(id)}`,
        401,
      ],
    ];
    const queuedExpected: string[] = [];
    for (const [name, wire, status] of cases) {
      const id = newRequestId();
      const response = await rawWire(wire(id));
      expect(response.status, name).toBe(status);
      expect(response.text.toLowerCase(), name).toContain("x-ravi-listener: 1");
      if (status === 401) queuedExpected.push(id);
    }
    // Only the requests that got past Host and routing reached the queue.
    expect(dbListUnacknowledgedServedJtis().map((row) => row.jti)).toEqual(queuedExpected);
  });

  test("an empty X-Ravi-Sandbox-Grant header is refused like a present one", async () => {
    await start();
    const empty = await send({ headers: { "x-ravi-sandbox-grant": "" } });
    expect(empty.status).toBe(400);
    expect(errorCode(empty)).toBe("body_invalid");
    expect(lastOutcome().reason).toBe("grant_header_present");
    const present = await send({ headers: { "x-ravi-sandbox-grant": grant } });
    expect(present.status).toBe(400);
    expect(errorCode(present)).toBe("body_invalid");
    expect(audits).toHaveLength(0);
  });

  test("the production audit path carries runId and requestId", async () => {
    const suppression = process.env.RAVI_SUPPRESS_AUDIT_EVENTS;
    delete process.env.RAVI_SUPPRESS_AUDIT_EVENTS;
    try {
      await start({}, { emitAudit: undefined });
      const response = await send();
      expect(response.status).toBe(200);
      const audit = natsEmits.find((emitted) => emitted.subject === "ravi._cli.cli.tasks.report");
      expect(audit?.payload).toMatchObject({
        runId: TEST_RUN_ID,
        requestId: response.requestId!,
        contextId: dbGetSandboxRun(TEST_RUN_ID)!.contextId,
        outcome: "succeeded",
      });
    } finally {
      if (suppression === undefined) delete process.env.RAVI_SUPPRESS_AUDIT_EVENTS;
      else process.env.RAVI_SUPPRESS_AUDIT_EVENTS = suppression;
    }
  });

  test("acknowledged served jtis past retention are pruned on a timer while the listener runs", async () => {
    await start({}, { servedJtiPruneIntervalMs: 20 });
    // Written after start, so only the running timer (not a start-time prune) can remove them.
    const old = newRequestId();
    const recent = newRequestId();
    const pending = newRequestId();
    dbAppendServedJti({ jti: old, runId: null, status: 200, servedAt: Date.now() - 30 * 60_000 });
    dbAppendServedJti({ jti: recent, runId: null, status: 200, servedAt: Date.now() - 60_000 });
    dbAppendServedJti({ jti: pending, runId: null, status: 200, servedAt: Date.now() - 30 * 60_000 });
    acknowledgeServedJtis([old], Date.now() - 11 * 60_000);
    acknowledgeServedJtis([recent], Date.now() - 60_000);
    await sleep(100);
    const rows = ensureSandboxSchema()
      .prepare("SELECT jti FROM sandbox_served_jtis ORDER BY served_at")
      .all() as Array<{
      jti: string;
    }>;
    expect(rows.map((row) => row.jti).sort()).toEqual([pending, recent].sort());
  });
});
