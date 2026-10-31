import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SignJWT, importPKCS8 } from "jose";
import { BridgeStore, type Enrollment } from "./store.js";
import { BridgeService } from "./service.js";
import { requestDigest, runtimeIdentity } from "./auth.js";
import { BRIDGE_PROTOCOL, type BridgeRequest, type BridgeResult } from "./protocol.js";

let dir: string,
  store: BridgeStore,
  service: BridgeService,
  enrollment: Enrollment,
  issuer: ReturnType<typeof runtimeIdentity>;
let project: string;
let owner: string, other: string, connection: string, started: string[], cancelled: string[];
const conditional = { permission: "execute", objectType: "command", objectId: "printf bridge-test" };
function req(operation: string, fields: Record<string, unknown> = {}): BridgeRequest {
  return {
    operation,
    requestId: randomUUID(),
    createdAt: Date.now(),
    projectId: project,
    ...fields,
  } as BridgeRequest;
}
async function sign(request: BridgeRequest, subject = owner, overrides: Record<string, unknown> = {}) {
  return new SignJWT({
    protocol: BRIDGE_PROTOCOL,
    orgId: enrollment.orgId,
    installationId: enrollment.installationId,
    enrollmentId: enrollment.id,
    epoch: enrollment.epoch,
    projectId: request.projectId,
    connectionId: connection,
    requestDigest: requestDigest(request),
    agents: [{ id: "main", capabilities: [], approvalCapabilities: [conditional] }],
    policyRevision: 1,
    policyDigest: "a".repeat(64),
    canSend: true,
    canApprove: true,
    ...overrides,
  })
    .setProtectedHeader({ alg: "EdDSA", kid: enrollment.issuerKeyId })
    .setIssuer(enrollment.issuer)
    .setSubject(subject)
    .setAudience(typeof overrides.aud === "string" ? overrides.aud : `ravi:${enrollment.runtimeId}:bridge:v2`)
    .setIssuedAt()
    .setExpirationTime("30s")
    .setJti(randomUUID())
    .sign(await importPKCS8(issuer.privateKey, "EdDSA"));
}
async function call(request: BridgeRequest, subject = owner, overrides: Record<string, unknown> = {}) {
  return service.handle(request, await sign(request, subject, overrides), connection);
}
function data(result: BridgeResult): any {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  return result.data;
}
async function create() {
  return data(await call(req("conversations.create", { agentId: "main" }))).conversationId as string;
}
async function send(conversationId: string) {
  return data(await call(req("messages.send", { conversationId, text: "hello", expectedVersion: 0 })));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "human-bridge-test-"));
  issuer = runtimeIdentity(dir);
  store = new BridgeStore(join(dir, "bridge.db"));
  project = randomUUID();
  owner = randomUUID();
  other = randomUUID();
  connection = randomUUID();
  started = [];
  cancelled = [];
  enrollment = {
    id: randomUUID(),
    orgId: randomUUID(),
    installationId: randomUUID(),
    runtimeId: randomUUID(),
    issuer: "https://fleet.test",
    issuerPublicKey: issuer.publicKey,
    issuerKeyId: "k1",
    epoch: 1,
    active: true,
  };
  store.putEnrollment(enrollment);
  service = new BridgeService(store, enrollment.runtimeId, "test-cursor-secret", {
    agents: () => [{ id: "main", name: "main" }],
    start: async (id) => {
      started.push(id);
    },
    cancel: (name) => {
      cancelled.push(name);
    },
  });
});
afterEach(() => {
  service.stop();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("human bridge durable authority", () => {
  it("rejects tampering, wrong connection, audience and replay before effects", async () => {
    const request = req("conversations.create", { agentId: "main" }),
      token = await sign(request);
    expect(await service.handle({ ...request, agentId: "evil" }, token, connection)).toMatchObject({
      ok: false,
      error: "INVALID_DELEGATION",
    });
    expect(await service.handle(request, token, randomUUID())).toMatchObject({
      ok: false,
      error: "INVALID_DELEGATION",
    });
    expect(await call(request, owner, { aud: "wrong" })).toMatchObject({ ok: false, error: "INVALID_DELEGATION" });
    const first = await service.handle(request, token, connection);
    expect(first.ok).toBe(true);
    expect(await service.handle(request, token, connection)).toMatchObject({ ok: false, error: "ASSERTION_REPLAY" });
  });
  it("keeps each human's conversations, history, cursors and receipts private", async () => {
    const createRequest = req("conversations.create", { agentId: "main" });
    const id = data(await call(createRequest)).conversationId;
    const snapshot = data(await call(req("conversations.open", { conversationId: id })));
    for (const operation of ["conversations.open", "messages.list", "events.read", "lease.renew"]) {
      const fields =
        operation === "messages.list"
          ? { before: null }
          : operation === "events.read"
            ? { cursor: snapshot.cursor }
            : {};
      expect(await call(req(operation, { conversationId: id, ...fields }), other)).toMatchObject({
        ok: false,
        error: "NOT_FOUND_OR_DENIED",
      });
    }
    expect(data(await call(req("conversations.list"), other))).toEqual([]);
    expect(await call(req("requests.get", { targetRequestId: createRequest.requestId }), other)).toMatchObject({
      ok: false,
      error: "REQUEST_NOT_FOUND",
    });
  });
  it("returns the committed receipt after reconnect without a second dispatch", async () => {
    const id = await create();
    const request = req("messages.send", { conversationId: id, text: "hello", expectedVersion: 0 });
    const receipt = data(await call(request));
    connection = randomUUID();
    expect(data(await call(request))).toEqual(receipt);
    expect(data(await call(req("requests.get", { targetRequestId: request.requestId })))).toEqual(receipt);
    await service.tick();
    await service.tick();
    expect(started).toEqual([receipt.turnId]);
    expect(await call({ ...request, text: "different" } as BridgeRequest)).toMatchObject({
      ok: false,
      error: "IDEMPOTENCY_CONFLICT",
    });
    expect(data(await call(req("conversations.open", { conversationId: id }))).messages).toHaveLength(1);
  });
  it("replays journal after disconnect and rejects a cursor from another conversation", async () => {
    const id = await create();
    const before = data(await call(req("conversations.open", { conversationId: id })));
    await send(id);
    connection = randomUUID();
    const replay = data(await call(req("events.read", { conversationId: id, cursor: before.cursor })));
    expect(replay.events.map((e: any) => e.type)).toEqual(["message.accepted"]);
    const next = await create();
    expect(await call(req("events.read", { conversationId: next, cursor: replay.cursor }))).toMatchObject({
      ok: false,
      error: "RESYNC_REQUIRED",
    });
    expect(data(await call(req("events.read", { conversationId: id, cursor: replay.cursor }))).events).toEqual([]);
  });
  it("cancels a queued turn atomically and never dispatches it", async () => {
    const id = await create(),
      receipt = await send(id);
    const request = req("turns.cancel", { conversationId: id, turnId: receipt.turnId });
    const cancelledReceipt = data(await call(request));
    expect(data(await call(request))).toEqual(cancelledReceipt);
    await service.tick();
    expect(started).toEqual([]);
    expect(store.turn(receipt.turnId)!.status).toBe("cancelled");
  });
  it("enforces active-turn CAS and expires leases or changed enrollment epochs", async () => {
    const id = await create(),
      receipt = await send(id);
    await service.tick();
    expect(await call(req("messages.send", { conversationId: id, text: "again", expectedVersion: 2 }))).toMatchObject({
      ok: false,
      error: "TURN_BUSY",
    });
    store.putEnrollment({ ...enrollment, epoch: 2 });
    await service.tick();
    expect(store.turn(receipt.turnId)!.status).toBe("authorization_expired");
    expect(cancelled).toHaveLength(1);
    expect(await call(req("lease.renew", { conversationId: id }))).toMatchObject({
      ok: false,
      error: "INVALID_DELEGATION",
    });
  });
  it("requires owner, current eligibility, action digest and version for approval", async () => {
    const id = await create(),
      receipt = await send(id);
    await service.tick();
    const approvalId = randomUUID(),
      digest = requestDigest({ action: "test" });
    store.db
      .query(
        "INSERT INTO approvals(id,conversation_id,turn_id,capability,description,action_digest,expires_at) VALUES (?,?,?,?,?,?,?)",
      )
      .run(approvalId, id, receipt.turnId, JSON.stringify(conditional), "test", digest, Date.now() + 30_000);
    const request = req("approvals.decide", {
      conversationId: id,
      approvalId,
      decision: "approve",
      expectedVersion: 1,
      actionDigest: digest,
    });
    expect(await call(request, other)).toMatchObject({ ok: false, error: "NOT_FOUND_OR_DENIED" });
    expect(await call(request, owner, { canApprove: false })).toMatchObject({
      ok: false,
      error: "NOT_FOUND_OR_DENIED",
    });
    expect(await call({ ...request, actionDigest: "0".repeat(64) } as BridgeRequest)).toMatchObject({
      ok: false,
      error: "APPROVAL_STALE",
    });
    const receipt2 = data(await call(request));
    expect(receipt2.state).toBe("approved");
    expect(data(await call(request))).toEqual(receipt2);
    expect(await call({ ...request, requestId: randomUUID() })).toMatchObject({ ok: false, error: "APPROVAL_STALE" });
  });
  it("does not replay an uncertain running effect after daemon restart", async () => {
    const id = await create(),
      receipt = await send(id);
    await service.tick();
    service.start();
    await service.tick();
    expect(started).toEqual([receipt.turnId]);
    expect(store.turn(receipt.turnId)!.status).toBe("interrupted_unknown");
  });
});

// Controlled protocol/runtime authorization proof; no model is mocked as a real model response.
describe("Console is the only bridge permission authority", () => {
  const sleep = { permission: "execute", objectType: "executable", objectId: "sleep" };
  const grants = (revision: number, capabilities = [sleep], approvalCapabilities = [conditional]) => ({
    policyRevision: revision,
    policyDigest: String(revision).padStart(64, "0"),
    agents: [{ id: "main", capabilities, approvalCapabilities }],
    canSend: true,
  });
  it("applies new grants and revocations to an active turn without local policy edits, rejecting stale assertions", async () => {
    const { bridgeContextCapabilities } = await import("./authority.js");
    const id = await create(),
      receipt = await send(id);
    await service.tick();
    const context = { kind: "turn-runtime", capabilities: [], metadata: { bridgeTurnId: receipt.turnId } };
    expect(bridgeContextCapabilities(context, store)).toEqual([]);
    data(await call(req("lease.renew", { conversationId: id }), owner, grants(2)));
    expect(bridgeContextCapabilities(context, store)).toEqual([sleep]);
    const child = { ...context, kind: "cli-runtime", capabilities: [] };
    expect(bridgeContextCapabilities(child, store)).toEqual([]);
    data(await call(req("conversations.open", { conversationId: id }), owner, grants(3, [])));
    expect(bridgeContextCapabilities(context, store)).toEqual([]);
    expect(await call(req("lease.renew", { conversationId: id }), owner, grants(2))).toMatchObject({
      ok: false,
      error: "STALE_DELEGATION",
    });
    data(await call(req("lease.renew", { conversationId: id }), owner, grants(4)));
    expect(bridgeContextCapabilities(context, store)).toEqual([sleep]);
    expect(store.enrollment(enrollment.id)).toEqual(enrollment);
    data(await call(req("conversations.open", { conversationId: id }), owner, { ...grants(5), canSend: false }));
    await service.tick();
    expect(store.turn(receipt.turnId)!.status).toBe("authorization_expired");
    expect(cancelled).toHaveLength(1);
  });
  for (const revoke of [{ canSend: false }, { agents: [] }]) {
    it(`persists a newer revocation even when renewal is denied: ${JSON.stringify(revoke)}`, async () => {
      const { bridgeContextCapabilities } = await import("./authority.js");
      const id = await create();
      const receipt = await send(id);
      await service.tick();
      data(await call(req("lease.renew", { conversationId: id }), owner, grants(2)));
      const context = { kind: "turn-runtime", capabilities: [], metadata: { bridgeTurnId: receipt.turnId } };
      expect(bridgeContextCapabilities(context, store)).toEqual([sleep]);
      const denied = req("lease.renew", { conversationId: id });
      expect(await call(denied, owner, { ...grants(3), ...revoke })).toMatchObject({
        ok: false,
        error: "NOT_FOUND_OR_DENIED",
      });
      expect(bridgeContextCapabilities(context, store)).toEqual([]);
      expect(store.db.query<{ revision: number }, []>("SELECT revision FROM delegation_heads").get()!.revision).toBe(3);
      expect(await call(req("lease.renew", { conversationId: id }), owner, grants(2))).toMatchObject({
        ok: false,
        error: "STALE_DELEGATION",
      });
      await service.tick();
      expect(store.turn(receipt.turnId)!.status).toBe("authorization_expired");
      expect(cancelled).toHaveLength(1);
    });
  }
  it("fails closed at lease expiry when Console cannot deliver a revocation", async () => {
    const id = await create(),
      receipt = await send(id);
    await service.tick();
    store.db.query("UPDATE turns SET lease_until=? WHERE id=?").run(Date.now() - 1, receipt.turnId);
    await service.tick();
    expect(store.turn(receipt.turnId)!.status).toBe("authorization_expired");
    expect(cancelled).toHaveLength(1);
    data(await call(req("lease.renew", { conversationId: id }), owner, grants(2)));
    expect(store.turn(receipt.turnId)!.status).toBe("authorization_expired");
  });
  it("uses current Console eligibility for an exact action and never upgrades the next invocation", async () => {
    const { authorizeBridgeAction } = await import("./native.js");
    const id = await create(),
      receipt = await send(id);
    await service.tick();
    const c = store.conversation(id)!;
    const context = {
      kind: "turn-runtime",
      agentId: "main",
      sessionKey: c.session_key,
      sessionName: c.session_name,
      capabilities: [],
      metadata: { bridgeTurnId: receipt.turnId },
    } as any;
    const options = { context, ...conditional, eventData: { command: "printf test", toolUseId: "first" } };
    let waiting = authorizeBridgeAction(options, store);
    await new Promise((r) => setTimeout(r, 30));
    let snapshot = data(await call(req("conversations.open", { conversationId: id })));
    const approval = snapshot.approvals[0];
    expect(approval.state).toBe("pending");
    const decide = req("approvals.decide", {
      conversationId: id,
      approvalId: approval.id,
      decision: "approve",
      expectedVersion: approval.version,
      actionDigest: approval.actionDigest,
    });
    expect(await call(decide, other)).toMatchObject({ ok: false, error: "NOT_FOUND_OR_DENIED" });
    expect(await call({ ...decide, actionDigest: "f".repeat(64) } as BridgeRequest)).toMatchObject({
      ok: false,
      error: "APPROVAL_STALE",
    });
    data(await call(decide));
    expect((await waiting).approved).toBe(true);
    waiting = authorizeBridgeAction({ ...options, eventData: { command: "printf next", toolUseId: "second" } }, store);
    await new Promise((r) => setTimeout(r, 30));
    snapshot = data(await call(req("conversations.open", { conversationId: id })));
    expect(snapshot.approvals[0].state).toBe("pending");
    data(await call(req("lease.renew", { conversationId: id }), owner, grants(2, [], [])));
    expect((await waiting).allowed).toBe(false);
    expect(
      store.db
        .query<{ state: string }, [string]>("SELECT state FROM approvals WHERE id=?")
        .get(snapshot.approvals[0].id)!.state,
    ).toBe("invalidated");
  });
});

it("terminalizes failed preparation by its exact bridge turn and cancels absent native work", async () => {
  const { recordBridgeRuntimeEvent } = await import("./native.js");
  const id = await create(),
    receipt = await send(id);
  await service.tick();
  const topic = `ravi.session.${store.conversation(id)!.session_name}.runtime`;
  recordBridgeRuntimeEvent(topic, { type: "turn.failed", _bridgeTurnId: randomUUID() }, store);
  expect(store.turn(receipt.turnId)!.status).toBe("running");
  recordBridgeRuntimeEvent(topic, { type: "turn.failed", _bridgeTurnId: receipt.turnId }, store);
  expect(store.turn(receipt.turnId)!.status).toBe("failed");
  const next = await create(),
    second = await send(next);
  await service.tick();
  service.runtime.cancel = () => false;
  data(await call(req("turns.cancel", { conversationId: next, turnId: second.turnId })));
  await service.tick();
  expect(store.turn(second.turnId)!.status).toBe("cancelled");
});
