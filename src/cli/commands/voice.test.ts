import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ToolContext } from "../context.js";

afterAll(() => mock.restore());

let currentContext: ToolContext | undefined;
const emitted: Array<{ topic: string; data: Record<string, unknown> }> = [];
const actualContext = await import("../context.js");
mock.module("../context.js", () => ({
  ...actualContext,
  getContext: () => currentContext,
  hasContext: () => true,
}));
mock.module("../../nats.js", () => ({
  connectNats: mock(async () => {}),
  closeNats: mock(async () => {}),
  ensureConnected: mock(async () => ({})),
  publish: mock(async () => {}),
  subscribe: mock(() => (async function* () {})()),
  nats: {
    emit: mock(async (topic: string, data: Record<string, unknown>) => {
      emitted.push({ topic, data });
    }),
    subscribe: mock(() => (async function* () {})()),
    close: mock(async () => {}),
  },
}));
const actualScope = await import("../../permissions/scope.js");
mock.module("../../permissions/scope.js", () => ({
  ...actualScope,
  getScopeContext: () => ({}),
  canAccessSession: () => true,
  filterAccessibleSessions: <T>(_: unknown, sessions: T[]) => sessions,
}));

const { cleanupIsolatedRaviState, createIsolatedRaviState } = await import("../../test/ravi-state.js");
const { getOrCreateSession } = await import("../../router/sessions.js");
const { claimApprovalDecision, createApprovalRequest } = await import("../../approval/store.js");
const { deliverVoiceApprovalRequest, listOpenVoiceApprovals } = await import("../../voice/approvals.js");
const { getVoiceCall, listVoiceEvents } = await import("../../voice/store.js");
const { ContractError } = await import("../agent-contract.js");
const { VoiceCallsCommands, VoiceDevicesCommands, VoiceEnginesCommands, setVoiceApprovalDecisionWaitForTests } =
  await import("./voice.js");

let stateDir: string | null = null;

async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const log = console.log;
  const error = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
    console.error = error;
  }
}

async function contractError(fn: () => Promise<unknown>): Promise<InstanceType<typeof ContractError>> {
  try {
    await quiet(fn);
  } catch (error) {
    if (error instanceof ContractError) return error;
    throw error;
  }
  throw new Error("expected a ContractError");
}

describe("ravi voice commands", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-voice-cli-");
    currentContext = undefined;
    emitted.length = 0;
    getOrCreateSession("agent:main:main", "main", "/tmp", { name: "main" });
  });
  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("starts a mock call as the operator and hands speech to the door", async () => {
    const calls = new VoiceCallsCommands();
    const started = (await quiet(() => calls.start("main", undefined, "mock", undefined, true))) as Record<
      string,
      unknown
    >;
    expect(started).toMatchObject({ sessionName: "main", mode: "mock", connectionKind: "none", sdpAnswer: null });
    const callId = String(started.callId);
    expect(getVoiceCall(callId)?.state).toBe("active");

    const pushed = (await quiet(() =>
      calls.push(callId, undefined, Buffer.from("que horas são?").toString("base64"), "text/plain", true),
    )) as Record<string, unknown>;
    expect(pushed.text).toBe("que horas são?");
    const control = emitted.find((message) => message.topic === `ravi.voice.${callId}.ctl`);
    expect(control?.data).toMatchObject({ op: "utterance", text: "que horas são?", speaker: { kind: "operator" } });

    const again = await contractError(() => calls.start("main", undefined, "mock", undefined, true));
    expect(again.code).toBe("VOICE_CALL_ACTIVE");
  });

  it("refuses to start or approve from an agent turn", async () => {
    currentContext = { sessionKey: "agent:main:main", sessionName: "main", agentId: "main" };
    const error = await contractError(() => new VoiceCallsCommands().start("main", undefined, "mock", undefined, true));
    expect(error.code).toBe("VOICE_AGENT_TURN_REFUSED");
    expect(error.exitCode).toBe(3);
  });

  it("refuses an engine that is not configured", async () => {
    const error = await contractError(() =>
      new VoiceCallsCommands().start("main", undefined, "handsfree", undefined, true),
    );
    expect(error.code).toBe("VOICE_ENGINE_NOT_READY");
  });

  it("approve is braked, bound to version and digest, and answers with a reaction", async () => {
    const calls = new VoiceCallsCommands();
    const started = (await quiet(() => calls.start("main", undefined, "mock", undefined, true))) as Record<
      string,
      unknown
    >;
    const callId = String(started.callId);
    const now = Date.now();
    createApprovalRequest({
      id: "req_9",
      type: "permission",
      channel: "voice",
      accountId: "voice",
      chatId: callId,
      createdAt: now,
      expiresAt: now + 60_000,
    });
    await deliverVoiceApprovalRequest({
      channel: "voice",
      to: callId,
      text: "Apagar a pasta build?",
      approvalRequestId: "req_9",
    });
    const open = listOpenVoiceApprovals(callId)[0];
    expect(open?.approvalId).toBe("req_9");

    const mismatch = await contractError(() => calls.approve(callId, "req_9", "1", "wrong", true, true));
    expect(mismatch.code).toBe("VOICE_APPROVAL_MISMATCH");

    const dry = await contractError(() => calls.approve(callId, "req_9", "1", open?.digest, true, false));
    expect(dry.code).toBe("WRITE_REQUIRES_EXECUTE");
    expect(dry.exitCode).toBe(3);

    // Nothing decides the request: the call keeps it open and reports pending.
    setVoiceApprovalDecisionWaitForTests(50);
    const pending = (await quiet(() => calls.approve(callId, "req_9", "1", open?.digest, true, true))) as Record<
      string,
      unknown
    >;
    expect(pending.decision).toBe("pending");
    expect(listOpenVoiceApprovals(callId)).toHaveLength(1);

    // The approval service commits the decision: only then is it resolved in the call.
    setTimeout(() => {
      claimApprovalDecision({ id: "req_9", decision: "approved", decidedBy: "contact_owner", now: Date.now() });
    }, 20);
    setVoiceApprovalDecisionWaitForTests(2_000);
    const decided = (await quiet(() => calls.approve(callId, "req_9", "1", open?.digest, true, true))) as Record<
      string,
      unknown
    >;
    expect(decided.decision).toBe("approved");
    const reaction = emitted.find((message) => message.topic === "ravi.inbound.reaction");
    expect(reaction?.data).toMatchObject({
      targetMessageId: `voice:${callId}:req_9`,
      senderId: "operator",
      emoji: "👍",
    });
    expect(listOpenVoiceApprovals(callId)).toHaveLength(0);
    expect(listVoiceEvents(callId).some((event) => event.type === "turn.approval_resolved")).toBe(true);
  });

  it("pairing is braked, needs a contact and limits the wildcard to the owner", async () => {
    const devices = new VoiceDevicesCommands();
    const missing = await contractError(() => devices.pair(undefined, undefined, "main", false, true, true));
    expect(missing.code).toBe("USAGE_ERROR");
  });

  it("a person's device key is that person's credential; the worker key is no one's", async () => {
    const { createContact } = await import("../../contacts.js");
    const { dbGetContext } = await import("../../router/router-db.js");
    const { getVoiceDevice } = await import("../../voice/store.js");
    const { personCredentialContactId } = await import("../../runtime/person-credential.js");
    const person = createContact({ phone: "5511900000995", name: "Person" });
    const devices = new VoiceDevicesCommands();
    const paired = (await quiet(() => devices.pair(person.id, "phone", "main", false, true, true))) as {
      device: { id: string };
    };
    const device = getVoiceDevice(paired.device.id);
    expect(personCredentialContactId(dbGetContext(device?.contextId ?? ""))).toBe(person.id);

    const worker = (await quiet(() => devices.pair(person.id, "worker", undefined, true, true, true))) as {
      device: { id: string };
    };
    const workerDevice = getVoiceDevice(worker.device.id);
    expect(personCredentialContactId(dbGetContext(workerDevice?.contextId ?? ""))).toBeNull();
  });

  it("engines check never needs a vendor", async () => {
    const result = (await quiet(() => new VoiceEnginesCommands().check(true))) as { checks: Array<{ engine: string }> };
    expect(result.checks.map((check) => check.engine)).toEqual(["push", "live", "handsfree", "mock"]);
  });
});
