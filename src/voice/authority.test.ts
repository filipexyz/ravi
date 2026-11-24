import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { runWithContext } from "../cli/context.js";
import { createRuntimeContext } from "../runtime/context-registry.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import {
  assertCallerControlsCall,
  assertCallerMayCallSession,
  resolveVoiceCaller,
  VOICE_DEVICE_CAPABILITIES,
  VOICE_DEVICE_CONTEXT_KIND,
  VoiceAuthorityError,
} from "./authority.js";
import { insertVoiceDevice, markVoiceDeviceRevoked } from "./store.js";
import { emptyVoiceUsage, type VoiceCall } from "./types.js";

let stateDir: string | null = null;

function pairedDevice(sessions: string[]) {
  const context = createRuntimeContext({
    kind: VOICE_DEVICE_CONTEXT_KIND,
    capabilities: VOICE_DEVICE_CAPABILITIES.map((capability) => ({ ...capability })),
    metadata: { voiceDeviceId: "vd_1" },
    ttlMs: 60_000,
  });
  insertVoiceDevice({
    id: "vd_1",
    label: "phone",
    contactId: "contact_1",
    sessions,
    contextId: context.contextId,
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  });
  return context;
}

function callFor(speakerId: string, mode: VoiceCall["mode"] = "push"): VoiceCall {
  return {
    id: "vc_1",
    sessionKey: "agent:main:main",
    sessionName: "main",
    mode,
    engine: mode,
    profileId: "default",
    state: "active",
    agentState: "listening",
    speaker: { kind: "device", id: speakerId },
    connectionKind: "none",
    usage: emptyVoiceUsage(),
    createdAt: 0,
    updatedAt: 0,
  };
}

function code(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof VoiceAuthorityError ? error.code : String(error);
  }
}

describe("voice authority", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-voice-authority-");
  });
  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("refuses agent turns", () => {
    const result = runWithContext({ sessionKey: "agent:main:main", sessionName: "main", agentId: "main" }, () =>
      code(() => resolveVoiceCaller("voice calls start")),
    );
    expect(result).toBe("VOICE_AGENT_TURN_REFUSED");
  });

  it("the local operator is the operator speaker", () => {
    const caller = runWithContext({}, () => resolveVoiceCaller("voice calls start"));
    expect(caller.kind).toBe("operator");
    expect(caller.speaker).toEqual({ kind: "operator", id: "operator" });
  });

  it("a paired device speaks as its contact, only on its sessions and its own calls", () => {
    const context = pairedDevice(["main"]);
    const caller = runWithContext({ context, contextId: context.contextId }, () =>
      resolveVoiceCaller("voice calls start"),
    );
    expect(caller.kind).toBe("device");
    expect(caller.speaker).toMatchObject({ kind: "device", id: "vd_1", contactId: "contact_1" });
    expect(code(() => assertCallerMayCallSession(caller, { name: "main", sessionKey: "agent:main:main" }))).toBeNull();
    expect(code(() => assertCallerMayCallSession(caller, { name: "ops", sessionKey: "agent:ops:main" }))).toBe(
      "VOICE_SESSION_FORBIDDEN",
    );
    expect(code(() => assertCallerControlsCall(caller, callFor("vd_1"), "approve"))).toBeNull();
    expect(code(() => assertCallerControlsCall(caller, callFor("vd_other"), "read"))).toBe("VOICE_CALL_FORBIDDEN");
  });

  it("a revoked device key is refused", () => {
    const context = pairedDevice(["main"]);
    markVoiceDeviceRevoked("vd_1");
    const result = runWithContext({ context, contextId: context.contextId }, () =>
      code(() => resolveVoiceCaller("voice calls start")),
    );
    expect(result).toBe("VOICE_DEVICE_REVOKED");
  });
});
