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
const { addVoiceDailyUsage, defaultVoiceProfile, getVoiceCall, listVoiceEvents, saveVoiceProfile } = await import(
  "../../voice/store.js"
);
const { ContractError } = await import("../agent-contract.js");
const {
  VoiceCallsCommands,
  VoiceDevicesCommands,
  VoiceEnginesCommands,
  VoiceProfilesCommands,
  setVoiceApprovalDecisionWaitForTests,
} = await import("./voice.js");

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

  it("checks the daily limit of the chosen profile only", async () => {
    saveVoiceProfile({ ...defaultVoiceProfile(), id: "spent", mode: "mock", maxDailyCostUsd: 1 });
    saveVoiceProfile({ ...defaultVoiceProfile(), id: "fresh", mode: "mock", maxDailyCostUsd: 1 });
    addVoiceDailyUsage("spent", 1, 60);
    const calls = new VoiceCallsCommands();
    const refused = await contractError(() => calls.start("main", "spent", undefined, undefined, true));
    expect(refused.code).toBe("VOICE_LIMIT_REACHED");
    const started = (await quiet(() => calls.start("main", "fresh", undefined, undefined, true))) as Record<
      string,
      unknown
    >;
    expect(getVoiceCall(String(started.callId))?.profileId).toBe("fresh");
  });

  it("activity tells the door whether the person is talking", async () => {
    const calls = new VoiceCallsCommands();
    const started = (await quiet(() => calls.start("main", undefined, "mock", undefined, true))) as Record<
      string,
      unknown
    >;
    const callId = String(started.callId);
    const result = (await quiet(() => calls.activity(callId, "speaking", true))) as Record<string, unknown>;
    expect(result).toEqual({ callId, speaking: true });
    const control = emitted.find((message) => message.topic === `ravi.voice.${callId}.ctl`);
    expect(control?.data).toMatchObject({ op: "activity", callId, speaking: true });
    const bad = await contractError(() => calls.activity(callId, "loud", true));
    expect(bad.code).toBe("USAGE_ERROR");
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
    const missing = await contractError(() => devices.pair(undefined, undefined, "main", false, true, undefined, true));
    expect(missing.code).toBe("USAGE_ERROR");
  });

  it("a person's device key is that person's credential; the worker key is no one's", async () => {
    const { createContact } = await import("../../contacts.js");
    const { dbGetContext } = await import("../../router/router-db.js");
    const { getVoiceDevice } = await import("../../voice/store.js");
    const { personCredentialContactId } = await import("../../runtime/person-credential.js");
    const person = createContact({ phone: "5511900000995", name: "Person" });
    const devices = new VoiceDevicesCommands();
    const paired = (await quiet(() => devices.pair(person.id, "phone", "main", false, true, undefined, true))) as {
      device: { id: string };
    };
    const device = getVoiceDevice(paired.device.id);
    expect(personCredentialContactId(dbGetContext(device?.contextId ?? ""))).toBe(person.id);

    const worker = (await quiet(() => devices.pair(person.id, "worker", undefined, true, true, undefined, true))) as {
      device: { id: string };
    };
    const workerDevice = getVoiceDevice(worker.device.id);
    expect(personCredentialContactId(dbGetContext(workerDevice?.contextId ?? ""))).toBeNull();
  });

  describe("configuration through the SDK", () => {
    type ProfileArgs = Partial<{
      label: string;
      mode: string;
      language: string;
      voice: string;
      sttProvider: string;
      sttModel: string;
      sttLanguage: string;
    }>;
    const create = (id: string, a: ProfileArgs = {}) =>
      new VoiceProfilesCommands().create(
        id,
        a.label,
        a.mode,
        a.language,
        a.voice,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        a.sttProvider,
        a.sttModel,
        a.sttLanguage,
        true,
      );
    const update = (id: string, a: ProfileArgs = {}) =>
      new VoiceProfilesCommands().update(
        id,
        a.label,
        a.mode,
        a.language,
        a.voice,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        a.sttProvider,
        a.sttModel,
        a.sttLanguage,
        true,
      );
    const issuedKey = (capabilities: Array<{ permission: string; objectType: string; objectId: string }>) =>
      ({
        contextId: "ctx_issued",
        context: { contextId: "ctx_issued", kind: "cli", capabilities, createdAt: Date.now() },
      }) as unknown as ToolContext;
    async function pairedDevice(profiles?: string) {
      const { createContact } = await import("../../contacts.js");
      const { dbGetContext } = await import("../../router/router-db.js");
      const { getVoiceDevice } = await import("../../voice/store.js");
      const person = createContact({ phone: `55119${Math.floor(Math.random() * 1e8)}`, name: "Person" });
      const paired = (await quiet(() =>
        new VoiceDevicesCommands().pair(person.id, "phone", "main", false, true, profiles, true),
      )) as { device: { id: string; profiles: string[] } };
      const device = getVoiceDevice(paired.device.id);
      return {
        device: paired.device,
        as: { contextId: device?.contextId, context: dbGetContext(device?.contextId ?? "") } as ToolContext,
      };
    }

    it("profiles are managed by the operator or a key issued with mutate:voice:profiles.*, never a device key", async () => {
      await quiet(() => create("calm", { mode: "mock" }));
      currentContext = issuedKey([]);
      expect((await contractError(() => create("other", { mode: "mock" }))).code).toBe("VOICE_OPERATOR_ONLY");
      currentContext = issuedKey([{ permission: "mutate", objectType: "voice", objectId: "profiles.*" }]);
      const updated = (await quiet(() => update("calm", { language: "en" }))) as { profile: { language: string } };
      expect(updated.profile.language).toBe("en");
      currentContext = undefined;
      const { as } = await pairedDevice();
      currentContext = as;
      expect((await contractError(() => update("calm", { language: "pt" }))).code).toBe("VOICE_OPERATOR_ONLY");
      expect((await contractError(() => new VoiceProfilesCommands().bind("calm", "main", true))).code).toBe(
        "VOICE_OPERATOR_ONLY",
      );
      const listed = (await quiet(() => new VoiceProfilesCommands().list(undefined, undefined, true))) as {
        profiles: Array<{ id: string }>;
      };
      expect(listed.profiles.some((profile) => profile.id === "calm")).toBe(true);
    });

    it("the gateway's own check lets a key with only mutate:voice:profiles.* run every profile write", async () => {
      const { getCommandAccessMetadata } = await import("../decorators.js");
      const { listCliCommandAccessCandidates } = await import("../command-access.js");
      const { canWithCapabilities } = await import("../../permissions/capability-snapshot.js");
      const access = getCommandAccessMetadata(VoiceProfilesCommands);
      const grant = [{ permission: "mutate", objectType: "voice", objectId: "profiles.*" }];
      for (const command of ["create", "update", "delete", "bind", "unbind"]) {
        const options = access.get(command);
        expect(options).toBeDefined();
        const candidates = listCliCommandAccessCandidates({
          group: "voice.profiles",
          command,
          access: options!,
          source: "gateway",
        } as Parameters<typeof listCliCommandAccessCandidates>[0]);
        const passes = candidates.some((c) => canWithCapabilities(grant, c.permission, c.objectType, c.objectId));
        expect({ command, passes }).toEqual({ command, passes: true });
      }
      // The grant reaches profile writes only, never other voice writes such as pairing a device.
      const devicesAccess = getCommandAccessMetadata(VoiceDevicesCommands).get("pair");
      const pairCandidates = listCliCommandAccessCandidates({
        group: "voice.devices",
        command: "pair",
        access: devicesAccess!,
        source: "gateway",
      } as Parameters<typeof listCliCommandAccessCandidates>[0]);
      expect(pairCandidates.some((c) => canWithCapabilities(grant, c.permission, c.objectType, c.objectId))).toBe(
        false,
      );
    });

    it("pairing with an empty profile list is refused instead of becoming any profile", async () => {
      const { createContact } = await import("../../contacts.js");
      const person = createContact({ phone: "5511900000777", name: "Person" });
      const error = await contractError(() =>
        new VoiceDevicesCommands().pair(person.id, "phone", "main", false, true, " , ", true),
      );
      expect(error.code).toBe("USAGE_ERROR");
    });

    it("transcription is set on the profile: provider, model and language; auto clears the provider", async () => {
      const created = (await quiet(() =>
        create("stt", { mode: "push", sttProvider: "openai", sttModel: "whisper-1", sttLanguage: "en" }),
      )) as { profile: Record<string, unknown> };
      expect(created.profile).toMatchObject({ sttProvider: "openai", sttModel: "whisper-1", sttLanguage: "en" });
      const cleared = (await quiet(() => update("stt", { sttProvider: "auto", sttModel: "" }))) as {
        profile: Record<string, unknown>;
      };
      expect(cleared.profile.sttProvider).toBeUndefined();
      expect(cleared.profile.sttModel).toBeUndefined();
      expect(cleared.profile.sttLanguage).toBe("en");
      expect((await contractError(() => update("stt", { sttProvider: "whisper" }))).code).toBe("USAGE_ERROR");

      const saved = { ...process.env };
      process.env.ELEVENLABS_API_KEY = "x";
      process.env.OPENAI_API_KEY = "x";
      delete process.env.GROQ_API_KEY;
      try {
        await quiet(() => update("stt", { sttProvider: "groq" }));
        const refused = await contractError(() =>
          new VoiceCallsCommands().start("main", "stt", undefined, undefined, true),
        );
        expect(refused.code).toBe("VOICE_ENGINE_NOT_READY");
        expect(refused.message).toContain("GROQ_API_KEY");
      } finally {
        process.env = saved;
      }

      const { createPushEngine } = await import("../../voice/engines/push.js");
      const seen: Array<Record<string, unknown>> = [];
      const engine = createPushEngine({
        env: { GROQ_API_KEY: "x" },
        transcribe: async (_buffer, _mime, options) => {
          seen.push({ ...options });
          return { text: "oi" };
        },
      });
      await engine.transcribe({
        bytes: new Uint8Array([1]),
        mime: "audio/webm",
        language: "en-US",
        stt: { provider: "openai", model: "m" },
      });
      expect(seen[0]).toEqual({ language: "en", provider: "openai", model: "m" });
    });

    it("a device starts calls only with the profiles it was paired for", async () => {
      await quiet(() => create("calm", { mode: "mock" }));
      const { device, as } = await pairedDevice("calm");
      expect(device.profiles).toEqual(["calm"]);
      currentContext = as;
      const calls = new VoiceCallsCommands();
      const refused = await contractError(() => calls.start("main", "default", undefined, undefined, true));
      expect(refused.code).toBe("VOICE_PROFILE_FORBIDDEN");
      const started = (await quiet(() => calls.start("main", undefined, undefined, undefined, true))) as Record<
        string,
        unknown
      >;
      expect(getVoiceCall(String(started.callId))?.profileId).toBe("calm");
    });

    it("a session's bound profile is used when the call names none, until unbound or deleted", async () => {
      await quiet(() => create("calm", { mode: "mock" }));
      const profiles = new VoiceProfilesCommands();
      const bound = (await quiet(() => profiles.bind("calm", "main", true))) as Record<string, unknown>;
      expect(bound).toMatchObject({ profileId: "calm", sessionName: "main" });
      const calls = new VoiceCallsCommands();
      const first = (await quiet(() => calls.start("main", undefined, undefined, undefined, true))) as Record<
        string,
        unknown
      >;
      expect(getVoiceCall(String(first.callId))?.profileId).toBe("calm");
      // No door runs here: close the call in the store, as the door would.
      const { updateVoiceCall } = await import("../../voice/store.js");
      updateVoiceCall(String(first.callId), { state: "ended", endedAt: Date.now(), endedReason: "ended" });
      expect(((await quiet(() => profiles.unbind("main", true))) as { unbound: boolean }).unbound).toBe(true);
      await quiet(() => profiles.bind("calm", "main", true));
      await quiet(() => profiles.delete("calm", true));
      const second = (await quiet(() => calls.start("main", undefined, "mock", undefined, true))) as Record<
        string,
        unknown
      >;
      expect(getVoiceCall(String(second.callId))?.profileId).toBe("default");
    });
  });

  it("engines check never needs a vendor", async () => {
    const result = (await quiet(() => new VoiceEnginesCommands().check(true))) as { checks: Array<{ engine: string }> };
    expect(result.checks.map((check) => check.engine)).toEqual(["push", "live", "handsfree", "mock"]);
  });
});
