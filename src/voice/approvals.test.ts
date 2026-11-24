import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createApprovalRequest } from "../approval/store.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import {
  deliverVoiceApprovalRequest,
  listOpenVoiceApprovals,
  resolveVoiceGrantorIdentity,
  voiceApprovalDigest,
  voiceApprovalMessageId,
} from "./approvals.js";
import { insertVoiceCall, insertVoiceDevice, markVoiceDeviceRevoked } from "./store.js";
import { emptyVoiceUsage } from "./types.js";

let stateDir: string | null = null;

function call(id = "vc_appr") {
  const now = Date.now();
  return insertVoiceCall({
    id,
    sessionKey: "agent:main:main",
    sessionName: "main",
    mode: "mock",
    engine: "mock",
    profileId: "default",
    state: "active",
    agentState: "listening",
    speaker: { kind: "operator", id: "operator" },
    connectionKind: "none",
    usage: emptyVoiceUsage(),
    createdAt: now,
    updatedAt: now,
  });
}

describe("voice approvals", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-voice-approvals-");
  });
  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("refuses to paint anything that is not an open approval for the call", async () => {
    const c = call();
    expect(await deliverVoiceApprovalRequest({ channel: "voice", to: c.id, text: "fake" })).toEqual({
      success: false,
      error: "VOICE_NOT_AN_APPROVAL",
    });
    expect(await deliverVoiceApprovalRequest({ channel: "voice", to: "vc_missing", text: "x" })).toEqual({
      success: false,
      error: "VOICE_CALL_NOT_ACTIVE",
    });
  });

  it("shows an open approval in the call with a digest bound to its text", async () => {
    const c = call();
    const now = Date.now();
    createApprovalRequest({
      id: "req_1",
      type: "permission",
      channel: "voice",
      accountId: "voice",
      chatId: c.id,
      createdAt: now,
      expiresAt: now + 60_000,
    });
    const result = await deliverVoiceApprovalRequest({ channel: "voice", to: c.id, text: "Rodar git push?" });
    expect(result).toEqual({ success: true, messageId: voiceApprovalMessageId(c.id, "req_1") });
    const open = listOpenVoiceApprovals(c.id);
    expect(open).toEqual([
      {
        approvalId: "req_1",
        version: 1,
        digest: voiceApprovalDigest("req_1", "Rodar git push?"),
        text: "Rodar git push?",
      },
    ]);
  });

  it("maps a paired device to its contact and refuses revoked devices", () => {
    const now = Date.now();
    insertVoiceDevice({
      id: "vd_1",
      label: "phone",
      contactId: "contact_1",
      sessions: ["main"],
      contextId: "ctx_1",
      createdAt: now,
      expiresAt: now + 60_000,
    });
    expect(resolveVoiceGrantorIdentity({ senderId: "vd_1" })).toEqual({ ownerType: "contact", ownerId: "contact_1" });
    markVoiceDeviceRevoked("vd_1");
    expect(resolveVoiceGrantorIdentity({ senderId: "vd_1" })).toBeNull();
    expect(resolveVoiceGrantorIdentity({ senderId: "vd_unknown" })).toBeNull();
  });

  it("the operator approves as the single owner contact, and fails closed without one", () => {
    expect(resolveVoiceGrantorIdentity({ senderId: "operator" })).toBeNull();
  });
});
