import "reflect-metadata";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SignJWT, importPKCS8 } from "jose";
import { SessionCommands } from "../../cli/commands/sessions.js";
import { getOrCreateSession, getSession } from "../../router/sessions.js";
import { resolveSession as genericResolve } from "../../cli/session-targets.js";
import { SessionConversationCommands } from "../../cli/commands/session-conversations.js";
import { buildRegistry } from "../../cli/registry-snapshot.js";
import { BridgeStore, type Enrollment } from "../../bridge/store.js";
import { BridgeService } from "../../bridge/service.js";
import { runtimeIdentity } from "../../bridge/auth.js";
import { createGatewayHandlerContext, handleGatewayRequest } from "./server.js";
import { handleConsoleRequest } from "./console-handler.js";
import { consoleRequestDigest } from "./console-auth.js";
import { CONSOLE_PROTOCOL, CONSOLE_STREAM_PATH } from "./console-contract.js";

let dir: string, service: BridgeService, store: BridgeStore, enrollment: Enrollment;
let signer: ReturnType<typeof runtimeIdentity>, owner: string, project: string, connection: string, starts: string[];
const gateway = createGatewayHandlerContext({
  registry: buildRegistry([SessionConversationCommands, SessionCommands]),
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "console-gateway-test-"));
  signer = runtimeIdentity(dir);
  owner = randomUUID();
  project = randomUUID();
  connection = randomUUID();
  starts = [];
  store = new BridgeStore(join(dir, "private.db"));
  enrollment = {
    id: randomUUID(),
    orgId: randomUUID(),
    installationId: randomUUID(),
    runtimeId: randomUUID(),
    issuer: "https://console.invalid",
    issuerPublicKey: signer.publicKey,
    issuerKeyId: "key1",
    epoch: 1,
    active: true,
  };
  store.putEnrollment(enrollment);
  service = new BridgeService(store, enrollment.runtimeId, "test-cursor-key", {
    agents: () => [{ id: "main", name: "main" }],
    start: async (id) => {
      starts.push(id);
    },
    cancel: () => false,
  });
});
afterEach(() => {
  service.stop();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
function input(fields: Record<string, unknown> = {}): {
  projectId: string;
  requestId: string;
  createdAt: number;
  [key: string]: any;
} {
  return { projectId: project, requestId: randomUUID(), createdAt: Date.now(), ...fields };
}
async function prepare(
  command: string,
  body = input(),
  overrides: Record<string, unknown> = {},
  target?: string,
  lifetimeSeconds = 30,
) {
  const direct = command.includes(".");
  const path =
    target ?? (direct ? `/api/v1/${command.replaceAll(".", "/")}` : `/api/v1/sessions/conversations/${command}`);
  const {
    projectId: _project,
    requestId: _request,
    createdAt: _created,
    conversationId: _conversation,
    ...controlBody
  } = body;
  const method = target ? "GET" : "POST",
    raw = target ? "" : JSON.stringify(direct ? controlBody : body);
  const cmd = gateway.table.byPath.get(direct ? path : `/api/v1/sessions/conversations/${command}`)!;
  const grant = {
    protocol: CONSOLE_PROTOCOL,
    orgId: enrollment.orgId,
    installationId: enrollment.installationId,
    enrollmentId: enrollment.id,
    epoch: 1,
    projectId: project,
    connectionId: connection,
    policyRevision: 1,
    policyDigest: "a".repeat(64),
    origin: { kind: "browser", sessionId: "test-browser-session" },
    operationId: body.requestId,
    createdAt: body.createdAt,
    requestDigest: consoleRequestDigest(method, path, raw, body.requestId, body.createdAt),
    command: cmd.fullName,
    access: { kind: cmd.access!.kind, resource: cmd.access!.resource, action: cmd.access!.action },
    scope: body.conversationId ? { kind: "session", conversationId: body.conversationId } : { kind: "project" },
    agents: [{ id: "main", capabilities: [], approvalCapabilities: [] }],
    canSend: true,
    canApprove: false,
    ...overrides,
  };
  const token = await new SignJWT(grant)
    .setProtectedHeader({ alg: "EdDSA", kid: enrollment.issuerKeyId })
    .setIssuer(enrollment.issuer)
    .setSubject(owner)
    .setAudience(`ravi:${enrollment.runtimeId}:gateway:v1`)
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime(`${lifetimeSeconds}s`)
    .sign(await importPKCS8(signer.privateKey, "EdDSA"));
  const request = new Request(`http://ravi.internal${path}`, {
    method,
    body: target ? undefined : raw,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  });
  return request;
}
async function call(command: string, body = input(), overrides: Record<string, unknown> = {}) {
  return handleConsoleRequest(await prepare(command, body, overrides), connection, service, gateway);
}
async function create() {
  const response = await call("create", input({ agentId: "main" }));
  expect({ status: response.status, body: await response.clone().text() }).toMatchObject({ status: 200 });
  return ((await response.json()) as any).conversationId as string;
}

test("gateway dispatches canonical handlers; admission is durable and retries never duplicate turns", async () => {
  const id = await create(),
    request = input({ conversationId: id, text: "hello", expectedVersion: 0 });
  const first = await call("send", request);
  expect(first.status).toBe(200);
  const receipt = (await first.json()) as any;
  connection = randomUUID();
  expect(await (await call("send", request)).json()).toEqual(receipt);
  await service.tick();
  await service.tick();
  expect(starts).toEqual([receipt.turnId]);
  const altered = await call("send", { ...request, text: "changed" });
  expect(altered.status).not.toBe(200);
  expect(store.db.query("SELECT count(*) n FROM messages").get()).toEqual({ n: 1 });
});
test("rejects tampered HTTP bytes, nonce, action, origin and assertion reuse; local tokens cannot cross", async () => {
  const body = input({ agentId: "main" });
  const request = await prepare("create", body);
  const headers = request.headers;
  const tamper = new Request(request.url, {
    method: "POST",
    headers,
    body: JSON.stringify({ ...body, agentId: "other" }),
  });
  expect((await handleConsoleRequest(tamper, connection, service, gateway)).status).toBe(401);
  expect((await handleConsoleRequest(request.clone() as Request, randomUUID(), service, gateway)).status).toBe(401);
  expect((await handleConsoleRequest(request.clone() as Request, connection, service, gateway)).status).toBe(200);
  expect((await handleConsoleRequest(request, connection, service, gateway)).status).toBe(401);
  for (const overrides of [
    { access: { kind: "mutate", resource: "sessions.conversations", action: "send" } },
    { origin: { kind: "channel" } },
    { epoch: 2 },
  ])
    expect((await call("create", input({ agentId: "main" }), overrides)).status).not.toBe(200);
  const local = new Request("http://ravi.internal/api/v1/sessions/conversations/list", {
    method: "POST",
    headers: { authorization: "Bearer rctx_local" },
    body: JSON.stringify(input()),
  });
  expect((await handleConsoleRequest(local, connection, service, gateway)).status).toBe(401);
  expect((await handleGatewayRequest(await prepare("list"), gateway))!.status).toBe(401);
});
test("private ownership, project, scope and execution authority stay isolated", async () => {
  const id = await create();
  owner = randomUUID();
  expect((await call("open", input({ conversationId: id }))).status).not.toBe(200);
  expect(await (await call("list")).json()).toEqual([]);
  expect(
    (await call("open", input({ conversationId: id }), { scope: { kind: "session", conversationId: randomUUID() } }))
      .status,
  ).not.toBe(200);
});
test("project conversation commands reject a session-scoped or installation-scoped delegation", async () => {
  const id = await create();
  for (const scope of [{ kind: "session", conversationId: id }, { kind: "installation" }]) {
    for (const command of ["agents", "list", "create", "receipt"]) {
      const fields =
        command === "create" ? { agentId: "main" } : command === "receipt" ? { targetRequestId: randomUUID() } : {};
      const response = await call(command, input(fields), { scope });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: "RESOURCE_SCOPE_REQUIRED" } });
    }
  }
  expect(store.db.query("SELECT count(*) n FROM conversations").get()).toEqual({ n: 1 });
});

test("browser-independent invocations preserve authority and durable delivery identity", async () => {
  for (const origin of [
    { kind: "channel", connectorId: "slack-installation", conversationId: "thread", deliveryId: "message-1" },
    { kind: "automation", automationId: "daily", deliveryId: "run-1" },
  ]) {
    const request = input({ agentId: "main" });
    const first = (await (await call("create", request, { origin })).json()) as any;
    expect(first.conversationId).toBeString();
    expect(await (await call("create", request, { origin })).json()).toEqual(first);
  }
});
test("new policy revocation survives a denied command and closes active authority", async () => {
  const id = await create();
  const receipt = (await (
    await call("send", input({ conversationId: id, text: "hello", expectedVersion: 0 }))
  ).json()) as any;
  await service.tick();
  const denied = await call("renew", input({ conversationId: id }), {
    policyRevision: 2,
    policyDigest: "b".repeat(64),
    canSend: false,
  });
  expect(denied.status).not.toBe(200);
  expect((await call("renew", input({ conversationId: id }))).status).toBe(403);
  await service.tick();
  expect(store.turn(receipt.turnId)!.status).toBe("authorization_expired");
});
test("durable SSE replays only owner projection; cursor changes are signed and reads do not renew", async () => {
  const id = await create();
  const snapshot = (await (await call("open", input({ conversationId: id }))).json()) as any;
  const receipt = (await (
    await call("send", input({ conversationId: id, text: "hello", expectedVersion: 0 }))
  ).json()) as any;
  const lease = store.turn(receipt.turnId)!.lease_until;
  const body = input({ conversationId: id }),
    target = `${CONSOLE_STREAM_PATH}?${new URLSearchParams({ projectId: project, conversationId: id, cursor: snapshot.cursor })}`;
  const request = await prepare("events", body, {}, target);
  const response = await handleConsoleRequest(request, connection, service, gateway);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  const reader = response.body!.getReader(),
    first = await reader.read();
  expect(new TextDecoder().decode(first.value)).toContain("message.accepted");
  await reader.cancel();
  expect(store.turn(receipt.turnId)!.lease_until).toBe(lease);
  expect(
    store.db.query("SELECT operation FROM audit WHERE operation LIKE 'sdk.gateway.stream.%' ORDER BY id").all(),
  ).toEqual([{ operation: "sdk.gateway.stream.opened" }, { operation: "sdk.gateway.stream.closed" }]);
  const localStream = await handleGatewayRequest(
    new Request(`http://ravi.internal${target}`, { headers: { authorization: "Bearer rctx_admin" } }),
    gateway,
  );
  expect(localStream!.status).toBe(403);
  const invalid = await prepare("events", body, {}, target);
  const tamper = new Request(invalid.url + "x", { headers: invalid.headers });
  expect((await handleConsoleRequest(tamper, connection, service, gateway)).status).toBe(401);
});

test("existing session controls use durable ownership, never local administrator authority", async () => {
  const id = await create(),
    c = store.conversation(id)!;
  getOrCreateSession(c.session_key, "main", dir, { name: c.session_name });
  expect(genericResolve(c.session_key)).toBeNull();
  const body = input({ conversationId: id, nameOrKey: id, displayName: "Reviewed label" });
  const response = await call("sessions.set-display", body);
  expect({ status: response.status, body: await response.clone().text() }).toMatchObject({ status: 200 });
  expect(getSession(c.session_key)!.displayName).toBe("Reviewed label");
  expect(genericResolve(c.session_key)).toBeNull();
  const repeat = await call("sessions.set-display", body);
  expect(repeat.status).toBe(200);
  const changed = await call("sessions.set-display", { ...body, displayName: "changed" });
  expect(changed.status).toBe(403);
  expect(
    (await call("sessions.set-model", input({ conversationId: id, nameOrKey: id, model: "test", propagate: true })))
      .status,
  ).toBe(403);
  const other = await create();
  expect(
    (await call("sessions.set-display", input({ conversationId: other, nameOrKey: id, displayName: "foreign" })))
      .status,
  ).toBe(403);
  owner = randomUUID();
  expect(
    (await call("sessions.set-display", input({ conversationId: id, nameOrKey: id, displayName: "foreign" }))).status,
  ).toBe(403);
  expect(getSession(c.session_key)!.displayName).toBe("Reviewed label");
});

test("pre-dispatch audit failure rolls back admission and allows a safe retry", async () => {
  const id = await create(),
    c = store.conversation(id)!;
  getOrCreateSession(c.session_key, "main", dir, { name: c.session_name });
  const before = getSession(c.session_key)!.displayName;
  store.db.exec(
    "CREATE TRIGGER fail_audit_insert BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT, 'fixture failure'); END",
  );
  const body = input({ conversationId: id, nameOrKey: id, displayName: "Safe retry" });
  const first = await call("sessions.set-display", body);
  expect(first.status).toBe(403);
  expect(await first.json()).toMatchObject({ effectState: "none" });
  expect(getSession(c.session_key)!.displayName).toBe(before);
  expect(store.db.query("SELECT count(*) n FROM gateway_receipts").get()).toEqual({ n: 0 });
  store.db.exec("DROP TRIGGER fail_audit_insert");
  expect((await call("sessions.set-display", body)).status).toBe(200);
  expect(getSession(c.session_key)!.displayName).toBe("Safe retry");
});

test("ordinary runtime authority rejects Console-only routes before body parsing or dispatch", async () => {
  const localGateway = createGatewayHandlerContext({
    registry: buildRegistry([SessionConversationCommands]),
    auth: {
      resolveContext: () => ({
        contextId: "ctx_local_admin",
        contextKey: "rctx_local_admin",
        kind: "turn-runtime",
        agentId: "main",
        capabilities: [{ permission: "admin", objectType: "system", objectId: "*" }],
        metadata: { authorityMode: "delegated" },
        createdAt: Date.now(),
      }),
    },
  });
  for (const [path, command] of localGateway.table.byPath) {
    expect(command.access?.consoleOnly).toBe(true);
    const response = await handleGatewayRequest(
      new Request(`http://ravi.internal${path}`, {
        method: "POST",
        headers: { authorization: "Bearer rctx_local_admin" },
        body: "invalid json",
      }),
      localGateway,
    );
    expect(response!.status).toBe(403);
    expect(await response!.json()).toMatchObject({ error: "ConsoleAuthorityRequired" });
  }
  expect(store.db.query("SELECT count(*) n FROM conversations").get()).toEqual({ n: 0 });
});

test("post-effect audit failure stays uncertain and retry cannot repeat the handler", async () => {
  const id = await create(),
    c = store.conversation(id)!;
  getOrCreateSession(c.session_key, "main", dir, { name: c.session_name });
  store.db.exec(
    "CREATE TRIGGER fail_audit_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT, 'fixture failure'); END",
  );
  const body = input({ conversationId: id, nameOrKey: id, displayName: "Effect happened" });
  const first = await call("sessions.set-display", body);
  expect(first.status).toBe(503);
  expect(await first.json()).toMatchObject({ effectState: "unknown" });
  expect(getSession(c.session_key)!.displayName).toBe("Effect happened");
  store.db.exec("DROP TRIGGER fail_audit_update");
  const independent = await call(
    "sessions.set-display",
    input({ conversationId: id, nameOrKey: id, displayName: "Later independent change" }),
  );
  expect(independent.status).toBe(200);
  const retry = await call("sessions.set-display", body);
  expect(retry.status).toBe(503);
  expect(await retry.json()).toMatchObject({ error: { code: "EXECUTION_UNKNOWN" }, effectState: "unknown" });
  expect(getSession(c.session_key)!.displayName).toBe("Later independent change");
});

test("canonical conversation list paginates authorized rows before exposing results", async () => {
  await create();
  await create();
  await create();
  const all = (await (await call("list")).json()) as unknown[];
  expect(all).toHaveLength(3);
  expect(await (await call("list", input({ limit: 1, offset: 1 }))).json()).toEqual(all.slice(1, 2));
  expect((await call("list", input({ limit: 101 }))).status).toBe(400);
  expect(await (await call("list", input({ limit: 1 }), { agents: [] })).json()).toEqual([]);
  owner = randomUUID();
  expect(await (await call("list", input({ limit: 1, offset: 0 }))).json()).toEqual([]);
});

test("delegations cannot extend their lifetime or inject local context metadata", async () => {
  for (const ttl of [31, -1]) {
    const request = await prepare("create", input({ agentId: "main" }), {}, undefined, ttl);
    expect((await handleConsoleRequest(request, connection, service, gateway)).status).toBe(401);
  }
  for (const fields of [
    { cwd: "/tmp" },
    { authorityMode: "local-operator" },
    { contextKey: "rctx_admin" },
    { parentContextId: "admin" },
  ]) {
    expect((await call("create", input({ agentId: "main", ...fields }))).status).not.toBe(200);
  }
  expect(store.db.query("SELECT count(*) n FROM conversations").get()).toEqual({ n: 0 });
});
