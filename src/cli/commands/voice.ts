/**
 * `ravi voice`: a voice door on every session. Spec `voice`.
 *
 * Calls bind one existing session to one speaker; the session thinks the work
 * and is the only actor. Commands validate, store and hand control to the
 * daemon's door over NATS; they never run a session turn themselves.
 */
import "reflect-metadata";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { getApprovalRequest } from "../../approval/store.js";
import { listElevenLabsVoices } from "../../audio/generator.js";
import { findContactsByTag, getContactDetails } from "../../contacts.js";
import { OWNER_CONTACT_TAG } from "../../knowledge/owner.js";
import { nats } from "../../nats.js";
import { filterAccessibleSessions, getScopeContext } from "../../permissions/scope.js";
import { createRuntimeContext, revokeRuntimeContext } from "../../runtime/context-registry.js";
import { buildSessionRelayTurnOrigin } from "../../runtime/turn-origin.js";
import { listSessions, resolveSession } from "../../router/sessions.js";
import type { SessionEntry } from "../../router/types.js";
import { inferAudioMimeType } from "../../transcribe/service.js";
import { isTriggerOwnSessionKey } from "../../triggers/authority.js";
import { errorDiagnostic } from "../../utils/error-diagnostic.js";
import {
  listOpenVoiceApprovals,
  VOICE_ACCOUNT_ID,
  VOICE_APPROVE_EMOJI,
  VOICE_CHANNEL,
  VOICE_OPERATOR_SENDER,
  VOICE_REJECT_EMOJI,
  voiceApprovalMessageId,
} from "../../voice/approvals.js";
import {
  assertCallerControlsCall,
  assertCallerMayCallSession,
  resolveVoiceCaller,
  VOICE_DEVICE_CAPABILITIES,
  VOICE_DEVICE_CONTEXT_KIND,
  VOICE_WORKER_CONTEXT_KIND,
  VoiceAuthorityError,
  type VoiceCaller,
} from "../../voice/authority.js";
import { newTurnId } from "../../voice/door.js";
import { HANDSFREE_AGENT_NAME, mintLiveKitRoomToken } from "../../voice/engines/handsfree.js";
import { checkVoiceEngines, getVoiceEngine, listVoiceEngines } from "../../voice/engines/index.js";
import { buildLiveInstructions, closeLiveSession, createLiveSession, liveApiKey } from "../../voice/engines/live.js";
import { mockEngine } from "../../voice/engines/mock.js";
import { estimateSttCostUsd, pushEngine } from "../../voice/engines/push.js";
import { emitVoiceEvent, sendVoiceControl } from "../../voice/events.js";
import {
  deleteVoiceProfile,
  getVoiceAudio,
  getVoiceCall,
  getVoiceDailyUsage,
  getVoiceDevice,
  getVoiceProfile,
  insertVoiceCall,
  insertVoiceDevice,
  lastVoiceEventSeq,
  listVoiceCalls,
  listVoiceDevices,
  listVoiceEvents,
  listVoiceProfiles,
  listVoiceTurns,
  markVoiceDeviceRevoked,
  newVoiceCallId,
  newVoiceDeviceId,
  findActiveVoiceCall,
  saveVoiceProfile,
  updateVoiceCall,
} from "../../voice/store.js";
import {
  DEFAULT_VOICE_PROFILE_ID,
  emptyVoiceUsage,
  isVoiceMode,
  VOICE_AGENT_STATES,
  VOICE_CALL_STATES,
  VOICE_DELIVERY_CLASSES,
  VOICE_EVENT_TYPES,
  VOICE_MODES,
  type VoiceCall,
  type VoiceConnectionKind,
  type VoiceDeliveryClass,
  type VoiceMode,
  type VoiceProfile,
  type VoiceSpeaker,
} from "../../voice/types.js";
import {
  CONTRACT_EXIT_POLICY,
  CONTRACT_EXIT_USAGE,
  ContractError,
  contractDryRun,
  contractFail,
} from "../agent-contract.js";
import { resolveCallerPath } from "../caller-cwd.js";
import { getContext } from "../context.js";
import { Arg, Command, CommandAccess, Group, Option } from "../decorators.js";
import { declareCommandReturns } from "./operational-return-schemas.js";
import { buildCliOffsetPagination, paginateCliItems } from "../pagination.js";
import { jsonObjectSchema, strictCliOffsetPaginationSchema } from "../return-schemas.js";

const DEVICE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_CLIP_BYTES = 25 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

function emit(
  payload: Record<string, unknown>,
  asJson: boolean | undefined,
  human: () => void,
): Record<string, unknown> {
  if (asJson) printJson(payload);
  else human();
  return payload;
}

function fail(op: string, code: string, message: string, asJson?: boolean, exitCode?: number): never {
  return contractFail(op, code, message, {
    asJson,
    ...(exitCode ? { exitCode } : {}),
    diagnostic: errorDiagnostic(message, { operation: op }),
  });
}

/** Run a command body, mapping voice authority errors to exit 3 and unknown errors to exit 1. */
async function run<T>(op: string, asJson: boolean | undefined, body: () => Promise<T> | T): Promise<T> {
  try {
    return await body();
  } catch (error) {
    if (error instanceof ContractError) throw error;
    if (error instanceof VoiceAuthorityError) fail(op, error.code, error.message, asJson, CONTRACT_EXIT_POLICY);
    fail(op, "VOICE_FAILED", error instanceof Error ? error.message : String(error), asJson);
  }
}

function requireCall(op: string, callId: string, asJson?: boolean): VoiceCall {
  const call = getVoiceCall(callId);
  if (!call) fail(op, "VOICE_CALL_NOT_FOUND", `Call ${callId} not found.`, asJson);
  return call;
}

function requireActiveCall(op: string, callId: string, asJson?: boolean): VoiceCall {
  const call = requireCall(op, callId, asJson);
  if (call.state === "ended") fail(op, "VOICE_CALL_ENDED", `Call ${callId} has ended.`, asJson);
  return call;
}

function requireOperator(op: string, caller: VoiceCaller, asJson?: boolean): void {
  if (caller.kind !== "operator") {
    fail(op, "VOICE_OPERATOR_ONLY", `${op} is for the local operator.`, asJson, CONTRACT_EXIT_POLICY);
  }
}

function parseMode(op: string, value: string | undefined, asJson?: boolean): VoiceMode | undefined {
  if (value === undefined) return undefined;
  if (!isVoiceMode(value)) {
    fail(op, "USAGE_ERROR", `--mode must be one of ${VOICE_MODES.join(", ")}.`, asJson, CONTRACT_EXIT_USAGE);
  }
  return value;
}

function parseNumber(op: string, flag: string, value: string | undefined, asJson?: boolean): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    fail(op, "USAGE_ERROR", `${flag} must be a positive number.`, asJson, CONTRACT_EXIT_USAGE);
  }
  return parsed;
}

function pageOf<T>(
  items: readonly T[],
  baseCommand: string[],
  limit: string | undefined,
  offset: string | undefined,
  options: Array<string | null> = [],
) {
  const page = paginateCliItems(items, { limit, offset });
  return {
    items: page.items,
    total: page.total,
    pagination: buildCliOffsetPagination({
      baseCommand,
      limit: page.limit,
      offset: page.offset,
      returned: page.items.length,
      total: page.total,
      options,
    }),
  };
}

function splitList(value: string | string[] | undefined): string[] {
  const parts = Array.isArray(value) ? value : value ? [value] : [];
  return [
    ...new Set(
      parts
        .flatMap((part) => part.split(","))
        .map((part) => part.trim())
        .filter(Boolean),
    ),
  ];
}

function publicCall(call: VoiceCall): Record<string, unknown> {
  return {
    id: call.id,
    sessionName: call.sessionName,
    mode: call.mode,
    engine: call.engine,
    profileId: call.profileId,
    state: call.state,
    agentState: call.agentState,
    speaker: call.speaker,
    connectionKind: call.connectionKind,
    usage: call.usage,
    ...(call.endedReason ? { endedReason: call.endedReason } : {}),
    createdAt: new Date(call.createdAt).toISOString(),
    updatedAt: new Date(call.updatedAt).toISOString(),
    ...(call.endedAt ? { endedAt: new Date(call.endedAt).toISOString() } : {}),
  };
}

function callsVisibleTo(caller: VoiceCaller, calls: VoiceCall[]): VoiceCall[] {
  if (caller.kind === "operator") return calls;
  if (caller.kind === "context") return calls.filter((call) => call.callerContextId === caller.contextId);
  if (caller.kind === "worker") return calls.filter((call) => call.mode === "handsfree");
  return calls.filter((call) => call.speaker.kind === "device" && call.speaker.id === caller.device?.id);
}

function isOwnerContact(contactId: string): boolean {
  return findContactsByTag(OWNER_CONTACT_TAG).some((contact) => contact.id === contactId);
}

function turnOriginFor(caller: VoiceCaller): Record<string, unknown> {
  if (caller.kind === "operator" || caller.kind === "context") {
    return buildSessionRelayTurnOrigin("send", getContext()) as unknown as Record<string, unknown>;
  }
  // A device turn carries its key as the caller context: the runtime attributes
  // the turn to the paired contact and never widens it past the session's own agent.
  return buildSessionRelayTurnOrigin("send", { contextId: caller.contextId }) as unknown as Record<string, unknown>;
}

function callTranscript(callId: string): Array<{ role: "user" | "assistant"; text: string; seq: number }> {
  return listVoiceEvents(callId, { limit: 5000 })
    .filter((event) => event.type === "user.transcript" || event.type === "agent.transcript")
    .map((event) => ({
      role: event.type === "user.transcript" ? ("user" as const) : ("assistant" as const),
      text: String(event.data.text ?? ""),
      seq: event.seq,
    }))
    .filter((item) => item.text);
}

interface ConnectionMaterial {
  connectionKind: VoiceConnectionKind;
  sdpAnswer: string | null;
  roomUrl: string | null;
  roomToken: string | null;
  providerRef?: string;
}

async function openConnection(
  call: VoiceCall,
  profile: VoiceProfile,
  offer: string | undefined,
  seedHistory: boolean,
): Promise<ConnectionMaterial> {
  if (call.engine === "live") {
    if (!offer) return { connectionKind: "webrtc", sdpAnswer: null, roomUrl: null, roomToken: null };
    const apiKey = liveApiKey();
    if (!apiKey) throw new Error("RAVI_VOICE_OPENAI_API_KEY is not set");
    const history = seedHistory
      ? callTranscript(call.id)
          .slice(-60)
          .map((item) => ({ role: item.role, text: item.text }))
      : [];
    const created = await createLiveSession({
      apiKey,
      sdpOffer: offer,
      instructions: buildLiveInstructions({ language: profile.language, sessionLabel: call.sessionName }),
      ...(profile.liveModel ? { model: profile.liveModel } : {}),
      ...(profile.liveVoice ? { voice: profile.liveVoice } : {}),
      history,
    });
    await sendVoiceControl({ op: "live-attach", callId: call.id, providerSessionId: created.sessionId });
    return {
      connectionKind: "webrtc",
      sdpAnswer: created.sdpAnswer,
      roomUrl: null,
      roomToken: null,
      providerRef: created.sessionId,
    };
  }
  if (call.engine === "handsfree") {
    const token = await mintLiveKitRoomToken({
      room: call.id,
      identity: call.speaker.id,
      ...(call.speaker.label ? { name: call.speaker.label } : {}),
      dispatchAgent: {
        agentName: HANDSFREE_AGENT_NAME,
        metadata: JSON.stringify({ callId: call.id, language: profile.language, voice: profile.voice ?? null }),
      },
    });
    return {
      connectionKind: "room",
      sdpAnswer: null,
      roomUrl: token.roomUrl,
      roomToken: token.token,
      providerRef: call.id,
    };
  }
  return { connectionKind: "none", sdpAnswer: null, roomUrl: null, roomToken: null };
}

/**
 * The provider connect can take seconds; if the call ended meanwhile, close
 * what was just opened and refuse, so an ended call never comes back.
 */
async function refuseLateConnection(
  op: string,
  callId: string,
  material: ConnectionMaterial,
  asJson?: boolean,
): Promise<void> {
  const current = getVoiceCall(callId);
  if (current && current.state !== "ending" && current.state !== "ended") return;
  if (current?.engine === "live" && material.providerRef) {
    const apiKey = liveApiKey();
    if (apiKey) await closeLiveSession({ apiKey, sessionId: material.providerRef });
  }
  fail(op, "VOICE_CALL_ENDED", `Call ${callId} ended while it was connecting.`, asJson);
}

function readClip(
  op: string,
  input: { audioPath?: string; audioBase64?: string; mime?: string },
  asJson?: boolean,
): { bytes: Uint8Array; mime: string } {
  if (Boolean(input.audioPath) === Boolean(input.audioBase64)) {
    fail(op, "USAGE_ERROR", "Pass exactly one of --audio <file> or --audio-data <b64>.", asJson, CONTRACT_EXIT_USAGE);
  }
  if (input.audioPath) {
    const path = resolveCallerPath(input.audioPath, "read");
    const size = statSync(path).size;
    if (size > MAX_CLIP_BYTES) fail(op, "VOICE_CLIP_TOO_LARGE", "Clips are limited to 25 MB.", asJson);
    const mime = input.mime ?? inferAudioMimeType(path);
    if (!mime) fail(op, "USAGE_ERROR", "Cannot tell the audio type; pass --mime.", asJson, CONTRACT_EXIT_USAGE);
    return { bytes: new Uint8Array(readFileSync(path)), mime };
  }
  const bytes = new Uint8Array(Buffer.from(input.audioBase64 ?? "", "base64"));
  if (bytes.length === 0) fail(op, "USAGE_ERROR", "--audio-data is empty.", asJson, CONTRACT_EXIT_USAGE);
  if (bytes.length > MAX_CLIP_BYTES) fail(op, "VOICE_CLIP_TOO_LARGE", "Clips are limited to 25 MB.", asJson);
  return { bytes, mime: input.mime ?? "audio/webm" };
}

async function emitApprovalReaction(input: {
  callId: string;
  approvalId: string;
  senderId: string;
  emoji: string;
}): Promise<void> {
  await nats.emit("ravi.inbound.reaction", {
    channel: VOICE_CHANNEL,
    accountId: VOICE_ACCOUNT_ID,
    chatId: input.callId,
    targetMessageId: voiceApprovalMessageId(input.callId, input.approvalId),
    senderId: input.senderId,
    emoji: input.emoji,
    timestamp: Date.now(),
  });
}

let approvalDecisionWaitMs = 10_000;
/** Tests shorten the wait for the approval service's committed decision. */
export function setVoiceApprovalDecisionWaitForTests(ms: number): void {
  approvalDecisionWaitMs = ms;
}

type SubmittedDecision = "approved" | "rejected" | "pending";

/**
 * Answer through the regular approval path (a reaction the approval service
 * checks against the grantor gate), then report only what the service
 * committed. The call shows the request as resolved only after that; if the
 * service has not decided yet, the answer is `pending` and the request stays
 * open in the call.
 */
async function submitApprovalDecision(
  op: string,
  caller: VoiceCaller,
  callId: string,
  approvalId: string,
  emoji: string,
  asJson?: boolean,
): Promise<SubmittedDecision> {
  await emitApprovalReaction({ callId, approvalId, senderId: approvalSender(caller), emoji });
  const deadline = Date.now() + approvalDecisionWaitMs;
  for (;;) {
    const record = getApprovalRequest(approvalId);
    if (record && record.status === "decided" && record.decision) {
      await emitVoiceEvent(callId, "turn.approval_resolved", {
        approvalId,
        decision: record.decision,
        by: caller.speaker.id,
      });
      await sendVoiceControl({ op: "approval-resolved", callId, approvalId, decision: record.decision });
      return record.decision;
    }
    if (!record || record.status !== "pending") {
      fail(op, "VOICE_APPROVAL_NOT_OPEN", `Approval ${approvalId} expired or was withdrawn.`, asJson);
    }
    if (Date.now() >= deadline) return "pending";
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function decisionLine(decision: SubmittedDecision): string {
  if (decision === "approved") return "✅ Approved.";
  if (decision === "rejected") return "❌ Denied.";
  return "⏳ Sent; the approval has not been decided yet. It stays open in the call.";
}

function approvalSender(caller: VoiceCaller): string {
  return caller.kind === "device" && caller.device ? caller.device.id : VOICE_OPERATOR_SENDER;
}

// ---------------------------------------------------------------------------
// voice targets
// ---------------------------------------------------------------------------

@Group({ name: "voice.targets", description: "Sessions this caller can talk to", scope: "open" })
export class VoiceTargetsCommands {
  @Command({ name: "list", description: "List sessions this caller can open a voice call on" })
  @CommandAccess({ kind: "read", resource: "voice", action: "targets", risk: "low" })
  async list(
    @Option({ flags: "--limit <n>", description: "Page size (default: 50, max: 500)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Items to skip (default: 0)" }) offset?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "voice targets list";
    return run(op, asJson, () => {
      const caller = resolveVoiceCaller(op);
      const callable = (session: SessionEntry) => !isTriggerOwnSessionKey(session.sessionKey);
      let sessions: SessionEntry[];
      if (caller.kind === "device") {
        const allowed = caller.device?.sessions ?? [];
        // Devices are paired to session keys, which survive a rename.
        sessions = listSessions().filter((session) => allowed.includes("*") || allowed.includes(session.sessionKey));
      } else if (caller.kind === "worker") {
        sessions = [];
      } else {
        sessions = filterAccessibleSessions(getScopeContext(), listSessions());
      }
      const targets = sessions.filter(callable).map((session) => ({
        sessionName: session.name ?? session.sessionKey,
        agentId: session.agentId ?? null,
        activeCalls: listVoiceCalls({ activeOnly: true, sessionKey: session.sessionKey, limit: "all" }).length,
      }));
      const page = pageOf(targets, ["ravi", "voice", "targets", "list"], limit, offset);
      return emit({ targets: page.items, total: page.total, pagination: page.pagination }, asJson, () => {
        if (page.items.length === 0) console.log("No sessions to call.");
        for (const target of page.items) console.log(`${target.sessionName}\t${target.agentId ?? "-"}`);
      });
    });
  }
}

// ---------------------------------------------------------------------------
// voice calls
// ---------------------------------------------------------------------------

@Group({ name: "voice.calls", description: "Voice calls on sessions", scope: "open" })
export class VoiceCallsCommands {
  @Command({ name: "start", description: "Open a voice call on an existing session" })
  @CommandAccess({ kind: "mutate", resource: "voice", action: "calls.start", risk: "medium" })
  async start(
    @Arg("session", { description: "Session name or key" }) sessionRef: string,
    @Option({ flags: "--profile <id>", description: "Voice profile (default: default)" }) profileId?: string,
    @Option({ flags: "--mode <mode>", description: "push|live|handsfree|mock (default: the profile's)" })
    modeValue?: string,
    @Option({ flags: "--offer <sdp>", description: "WebRTC SDP offer (live mode)" }) offer?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "voice calls start";
    return run(op, asJson, async () => {
      const caller = resolveVoiceCaller(op);
      const session = resolveSession(sessionRef);
      if (!session) fail(op, "VOICE_SESSION_NOT_FOUND", `Session ${sessionRef} not found.`, asJson);
      if (isTriggerOwnSessionKey(session.sessionKey)) {
        fail(op, "VOICE_SESSION_NOT_CALLABLE", "A trigger's own session only runs that trigger.", asJson);
      }
      assertCallerMayCallSession(caller, session);
      const profile = getVoiceProfile(profileId ?? DEFAULT_VOICE_PROFILE_ID);
      if (!profile) fail(op, "VOICE_PROFILE_NOT_FOUND", `Profile ${profileId} not found.`, asJson);
      const mode = parseMode(op, modeValue, asJson) ?? profile.mode;
      const check = getVoiceEngine(mode).check();
      if (!check.ready) {
        fail(op, "VOICE_ENGINE_NOT_READY", `Engine ${mode} is missing: ${check.missing.join(", ")}.`, asJson);
      }
      const daily = getVoiceDailyUsage();
      if (daily.costUsd >= profile.maxDailyCostUsd) {
        fail(op, "VOICE_LIMIT_REACHED", "Today's voice spend limit is reached.", asJson, CONTRACT_EXIT_POLICY);
      }
      const existing = findActiveVoiceCall(session.sessionKey, caller.speaker.id);
      if (existing) {
        fail(
          op,
          "VOICE_CALL_ACTIVE",
          `There is already an active call (${existing.id}) on ${existing.sessionName} for this speaker. End it first: ravi voice calls end ${existing.id}`,
          asJson,
        );
      }
      const now = Date.now();
      const speaker: VoiceSpeaker = caller.speaker;
      const call = insertVoiceCall({
        id: newVoiceCallId(),
        sessionKey: session.sessionKey,
        sessionName: session.name ?? session.sessionKey,
        ...(session.agentId ? { agentId: session.agentId } : {}),
        mode,
        engine: mode,
        profileId: profile.id,
        state: "starting",
        agentState: "idle",
        speaker,
        ...(caller.contextId ? { callerContextId: caller.contextId } : {}),
        turnOrigin: turnOriginFor(caller),
        connectionKind: getVoiceEngine(mode).connectionKind,
        usage: emptyVoiceUsage(),
        createdAt: now,
        updatedAt: now,
      });
      let material: ConnectionMaterial;
      try {
        material = await openConnection(call, profile, offer, false);
      } catch (error) {
        updateVoiceCall(call.id, { state: "ended", endedReason: "connect_failed", endedAt: Date.now() });
        await emitVoiceEvent(call.id, "call.ended", { reason: "connect_failed", usage: call.usage });
        throw error;
      }
      await refuseLateConnection(op, call.id, material, asJson);
      const waitingForOffer = mode === "live" && !material.sdpAnswer;
      const updated = updateVoiceCall(call.id, {
        state: waitingForOffer ? "starting" : "active",
        agentState: waitingForOffer ? "idle" : "listening",
        connectionKind: material.connectionKind,
        ...(material.providerRef ? { providerRef: material.providerRef } : {}),
      });
      await emitVoiceEvent(call.id, "call.state", { state: waitingForOffer ? "starting" : "active" });
      const payload = {
        callId: call.id,
        sessionName: call.sessionName,
        mode,
        profileId: profile.id,
        state: updated?.state ?? "active",
        connectionKind: material.connectionKind,
        sdpAnswer: material.sdpAnswer,
        roomUrl: material.roomUrl,
        roomToken: material.roomToken,
        lastSeq: lastVoiceEventSeq(call.id),
        capabilities: getVoiceEngine(mode).capabilities,
      };
      return emit(payload, asJson, () => {
        console.log(`📞 Call ${call.id} on ${call.sessionName} (${mode}).`);
        if (waitingForOffer)
          console.log(`Send the WebRTC offer with: ravi voice calls connect ${call.id} --offer <sdp>`);
        if (mode === "push" || mode === "mock")
          console.log(`Talk with: ravi voice calls push ${call.id} --audio <file>`);
      });
    });
  }

  @Command({ name: "connect", description: "(Re)connect the call's media: a new WebRTC offer or a fresh room token" })
  @CommandAccess({ kind: "mutate", resource: "voice", action: "calls.connect", risk: "medium" })
  async connect(
    @Arg("call", { description: "Call id" }) callId: string,
    @Option({ flags: "--offer <sdp>", description: "WebRTC SDP offer (live mode)" }) offer?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "voice calls connect";
    return run(op, asJson, async () => {
      const caller = resolveVoiceCaller(op);
      const call = requireActiveCall(op, callId, asJson);
      assertCallerControlsCall(caller, call, "control");
      if (call.engine === "live" && !offer) {
        fail(op, "USAGE_ERROR", "Live calls connect with --offer <sdp>.", asJson, CONTRACT_EXIT_USAGE);
      }
      const profile = getVoiceProfile(call.profileId) ?? (getVoiceProfile(DEFAULT_VOICE_PROFILE_ID) as VoiceProfile);
      const material = await openConnection(call, profile, offer, true);
      await refuseLateConnection(op, call.id, material, asJson);
      updateVoiceCall(call.id, {
        state: "active",
        agentState: "listening",
        connectionKind: material.connectionKind,
        ...(material.providerRef ? { providerRef: material.providerRef } : {}),
      });
      await emitVoiceEvent(call.id, "call.state", { state: "active", reconnected: true });
      const payload = {
        callId: call.id,
        connectionKind: material.connectionKind,
        sdpAnswer: material.sdpAnswer,
        roomUrl: material.roomUrl,
        roomToken: material.roomToken,
        lastSeq: lastVoiceEventSeq(call.id),
      };
      return emit(payload, asJson, () => console.log(`🔌 Call ${call.id} connected (${material.connectionKind}).`));
    });
  }

  @Command({ name: "list", description: "List voice calls" })
  @CommandAccess({ kind: "read", resource: "voice", action: "calls.list", risk: "low" })
  async list(
    @Option({ flags: "--active", description: "Only calls that have not ended" }) activeOnly?: boolean,
    @Option({ flags: "--limit <n>", description: "Page size (default: 50, max: 500)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Items to skip (default: 0)" }) offset?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "voice calls list";
    return run(op, asJson, () => {
      const caller = resolveVoiceCaller(op);
      const all = callsVisibleTo(caller, listVoiceCalls({ activeOnly: Boolean(activeOnly), limit: "all" })).map(
        publicCall,
      );
      const page = pageOf(all, ["ravi", "voice", "calls", "list"], limit, offset, [activeOnly ? "--active" : null]);
      const calls = page.items;
      return emit({ calls, total: page.total, pagination: page.pagination }, asJson, () => {
        if (calls.length === 0) console.log("No calls.");
        for (const call of calls) console.log(`${call.id}\t${call.sessionName}\t${call.mode}\t${call.state}`);
      });
    });
  }

  @Command({ name: "show", description: "Show one call, its engine and open approvals" })
  @CommandAccess({ kind: "read", resource: "voice", action: "calls.show", risk: "low" })
  async show(
    @Arg("call", { description: "Call id" }) callId: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "voice calls show";
    return run(op, asJson, () => {
      const caller = resolveVoiceCaller(op);
      const call = requireCall(op, callId, asJson);
      assertCallerControlsCall(caller, call, "read");
      const engine = getVoiceEngine(call.engine);
      const payload = {
        call: publicCall(call),
        engine: { id: engine.id, label: engine.label, capabilities: engine.capabilities },
        turns: listVoiceTurns(call.id).map((turn) => ({
          id: turn.id,
          state: turn.state,
          speaker: turn.speaker,
          createdAt: new Date(turn.createdAt).toISOString(),
        })),
        openApprovals: listOpenVoiceApprovals(call.id),
        lastSeq: lastVoiceEventSeq(call.id),
      };
      return emit(payload, asJson, () => {
        console.log(`${call.id} on ${call.sessionName}: ${call.state} (${call.mode}, ${call.agentState})`);
        console.log(`Turns: ${payload.turns.length} · Open approvals: ${payload.openApprovals.length}`);
        console.log(`Usage: US$ ${call.usage.estimatedCostUsd.toFixed(3)}`);
      });
    });
  }

  @Command({ name: "transcript", description: "What was said in the call" })
  @CommandAccess({ kind: "read", resource: "voice", action: "calls.transcript", risk: "low" })
  async transcript(
    @Arg("call", { description: "Call id" }) callId: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "voice calls transcript";
    return run(op, asJson, () => {
      const caller = resolveVoiceCaller(op);
      const call = requireCall(op, callId, asJson);
      assertCallerControlsCall(caller, call, "read");
      const lines = callTranscript(call.id);
      return emit({ callId: call.id, lines }, asJson, () => {
        for (const line of lines) console.log(`${line.role === "user" ? "🗣" : "🔊"} ${line.text}`);
      });
    });
  }

  @Command({ name: "events", description: "Stored call events after a sequence number" })
  @CommandAccess({ kind: "read", resource: "voice", action: "calls.events", risk: "low" })
  async events(
    @Arg("call", { description: "Call id" }) callId: string,
    @Option({ flags: "--after <seq>", description: "Only events after this sequence number" }) after?: string,
    @Option({ flags: "--limit <n>", description: "Maximum events (default 500)" }) limit?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "voice calls events";
    return run(op, asJson, () => {
      const caller = resolveVoiceCaller(op);
      const call = requireCall(op, callId, asJson);
      assertCallerControlsCall(caller, call, "read");
      const afterSeq = after === undefined ? 0 : Number(after);
      if (!Number.isInteger(afterSeq) || afterSeq < 0) {
        fail(op, "USAGE_ERROR", "--after must be a non-negative integer.", asJson, CONTRACT_EXIT_USAGE);
      }
      const events = listVoiceEvents(call.id, {
        after: afterSeq,
        limit: parseNumber(op, "--limit", limit, asJson) ?? 500,
      });
      return emit({ callId: call.id, events, lastSeq: lastVoiceEventSeq(call.id) }, asJson, () => {
        for (const event of events) console.log(`${event.seq}\t${event.type}\t${JSON.stringify(event.data)}`);
      });
    });
  }

  @Command({ name: "push", description: "Push-to-talk: send one recorded clip to the call" })
  @CommandAccess({ kind: "mutate", resource: "voice", action: "calls.push", risk: "medium" })
  async push(
    @Arg("call", { description: "Call id" }) callId: string,
    @Option({ flags: "--audio <file>", description: "Audio clip file" }) audioPath?: string,
    @Option({ flags: "--audio-data <b64>", description: "Audio clip as base64 (SDK and apps)" }) audioBase64?: string,
    @Option({ flags: "--mime <type>", description: "Audio type, e.g. audio/webm" }) mime?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "voice calls push";
    return run(op, asJson, async () => {
      const caller = resolveVoiceCaller(op);
      const call = requireActiveCall(op, callId, asJson);
      assertCallerControlsCall(caller, call, "speak");
      if (call.engine !== "push" && call.engine !== "mock") {
        fail(op, "VOICE_MODE_MISMATCH", `A ${call.engine} call carries audio over its own connection.`, asJson);
      }
      const clip = readClip(op, { audioPath, audioBase64, mime }, asJson);
      const profile = getVoiceProfile(call.profileId) ?? (getVoiceProfile(DEFAULT_VOICE_PROFILE_ID) as VoiceProfile);
      const engine = call.engine === "push" ? pushEngine : mockEngine;
      const heard = await engine.transcribe({ bytes: clip.bytes, mime: clip.mime, language: profile.language });
      const turnId = newTurnId();
      await sendVoiceControl({
        op: "utterance",
        callId: call.id,
        turnId,
        text: heard.text,
        speaker: { ...call.speaker },
        audioInSeconds: heard.durationSec,
        sttCostUsd: call.engine === "push" ? estimateSttCostUsd(heard.provider, heard.durationSec) : 0,
      });
      return emit({ callId: call.id, turnId: heard.text ? turnId : null, text: heard.text }, asJson, () =>
        console.log(heard.text ? `🗣 ${heard.text}` : "Nothing was heard."),
      );
    });
  }

  @Command({ name: "send", description: "Type into the call (or, for the voice worker, what it heard)" })
  @CommandAccess({ kind: "mutate", resource: "voice", action: "calls.send", risk: "medium" })
  async send(
    @Arg("call", { description: "Call id" }) callId: string,
    @Arg("text", { description: "What to say", variadic: true }) textParts: string[],
    @Option({ flags: "--guest <label>", description: "Mark the speaker as a guest (third party)" }) guest?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "voice calls send";
    return run(op, asJson, async () => {
      const caller = resolveVoiceCaller(op);
      const call = requireActiveCall(op, callId, asJson);
      assertCallerControlsCall(caller, call, "speak");
      const text = (Array.isArray(textParts) ? textParts.join(" ") : String(textParts ?? "")).trim();
      if (!text) fail(op, "USAGE_ERROR", "Nothing to say.", asJson, CONTRACT_EXIT_USAGE);
      const speaker: VoiceSpeaker = guest
        ? { kind: "guest", id: `guest:${guest.trim().slice(0, 60)}`, label: guest.trim().slice(0, 60) }
        : call.speaker;
      const turnId = newTurnId();
      await sendVoiceControl({ op: "utterance", callId: call.id, turnId, text, speaker: { ...speaker } });
      return emit({ callId: call.id, turnId, text }, asJson, () => console.log(`🗣 ${text}`));
    });
  }

  @Command({ name: "audio", description: "Fetch a synthesized clip of the call" })
  @CommandAccess({ kind: "read", resource: "voice", action: "calls.audio", risk: "low" })
  async audio(
    @Arg("call", { description: "Call id" }) callId: string,
    @Arg("item", { description: "Audio item id (from agent.transcript)" }) itemId: string,
    @Option({ flags: "--out <file>", description: "Write the clip to this file instead of returning base64" })
    out?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "voice calls audio";
    return run(op, asJson, () => {
      const caller = resolveVoiceCaller(op);
      const call = requireCall(op, callId, asJson);
      assertCallerControlsCall(caller, call, "read");
      const clip = getVoiceAudio(call.id, itemId);
      if (!clip) fail(op, "VOICE_AUDIO_NOT_FOUND", `No clip ${itemId} (clips are deleted when the call ends).`, asJson);
      if (out) {
        const path = resolveCallerPath(out, "write");
        writeFileSync(path, clip.bytes);
        return emit({ callId: call.id, item: itemId, mime: clip.mime, path, bytes: clip.bytes.length }, asJson, () =>
          console.log(`Saved ${path}`),
        );
      }
      return emit(
        {
          callId: call.id,
          item: itemId,
          mime: clip.mime,
          bytes: clip.bytes.length,
          audioBase64: Buffer.from(clip.bytes).toString("base64"),
        },
        asJson,
        () => console.log(`${itemId}: ${clip.mime}, ${clip.bytes.length} bytes (use --out <file>)`),
      );
    });
  }

  @Command({ name: "silence", description: "Stop speaking now (work keeps running)" })
  @CommandAccess({ kind: "mutate", resource: "voice", action: "calls.silence", risk: "low" })
  async silence(
    @Arg("call", { description: "Call id" }) callId: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "voice calls silence";
    return run(op, asJson, async () => {
      const caller = resolveVoiceCaller(op);
      const call = requireActiveCall(op, callId, asJson);
      assertCallerControlsCall(caller, call, "speak");
      await sendVoiceControl({ op: "silence", callId: call.id });
      return emit({ callId: call.id, silenced: true }, asJson, () => console.log("🤫"));
    });
  }

  @Command({ name: "cancel-turn", description: "Cancel one of this call's turns (never other work)" })
  @CommandAccess({ kind: "mutate", resource: "voice", action: "calls.cancel-turn", risk: "low" })
  async cancelTurn(
    @Arg("call", { description: "Call id" }) callId: string,
    @Option({ flags: "--turn <id>", description: "Turn id (from turn.accepted)" }) turnId?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "voice calls cancel-turn";
    return run(op, asJson, async () => {
      const caller = resolveVoiceCaller(op);
      const call = requireActiveCall(op, callId, asJson);
      assertCallerControlsCall(caller, call, "control");
      if (!turnId) fail(op, "USAGE_ERROR", "--turn <id> is required.", asJson, CONTRACT_EXIT_USAGE);
      const turn = listVoiceTurns(call.id).find((candidate) => candidate.id === turnId);
      if (!turn) fail(op, "VOICE_TURN_NOT_FOUND", `Turn ${turnId} is not part of call ${call.id}.`, asJson);
      await sendVoiceControl({ op: "cancel-turn", callId: call.id, turnId, actor: caller.speaker.id });
      return emit({ callId: call.id, turnId, cancelRequested: true }, asJson, () => console.log("Cancel requested."));
    });
  }

  @Command({
    name: "approve",
    description: "Approve a request shown in the call (tap only; dry-run by default; requires --execute)",
  })
  @CommandAccess({
    kind: "mutate",
    resource: "voice",
    action: "calls.approve",
    risk: "high",
    requiresConfirmation: true,
  })
  async approve(
    @Arg("call", { description: "Call id" }) callId: string,
    @Arg("approval", { description: "Approval id (from turn.approval_requested)" }) approvalId: string,
    @Option({ flags: "--version <n>", description: "Approval version shown in the call" }) version?: string,
    @Option({ flags: "--digest <d>", description: "Approval digest shown in the call" }) digest?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({
      flags: "--execute",
      description: "Actually approve; default is a dry-run that only shows the plan (exit 3)",
    })
    execute?: boolean,
  ) {
    const op = "voice calls approve";
    return run(op, asJson, async () => {
      const caller = resolveVoiceCaller(op);
      const call = requireActiveCall(op, callId, asJson);
      assertCallerControlsCall(caller, call, "approve");
      if (caller.kind !== "operator" && caller.kind !== "device") {
        fail(op, "VOICE_APPROVER_FORBIDDEN", "Only the paired person approves.", asJson, CONTRACT_EXIT_POLICY);
      }
      const approval = listOpenVoiceApprovals(call.id).find((item) => item.approvalId === approvalId);
      if (!approval) fail(op, "VOICE_APPROVAL_NOT_OPEN", `Approval ${approvalId} is not open in this call.`, asJson);
      if (String(approval.version) !== String(version ?? "") || approval.digest !== (digest ?? "")) {
        fail(
          op,
          "VOICE_APPROVAL_MISMATCH",
          "The approval changed or the version/digest is wrong. Read it again in the call.",
          asJson,
          CONTRACT_EXIT_POLICY,
        );
      }
      if (execute !== true) {
        contractDryRun(op, { callId: call.id, approvalId, text: approval.text }, { asJson });
      }
      const decision = await submitApprovalDecision(op, caller, call.id, approvalId, VOICE_APPROVE_EMOJI, asJson);
      return emit({ callId: call.id, approvalId, decision }, asJson, () => console.log(decisionLine(decision)));
    });
  }

  @Command({ name: "deny", description: "Deny a request shown in the call" })
  @CommandAccess({ kind: "mutate", resource: "voice", action: "calls.deny", risk: "low" })
  async deny(
    @Arg("call", { description: "Call id" }) callId: string,
    @Arg("approval", { description: "Approval id (from turn.approval_requested)" }) approvalId: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "voice calls deny";
    return run(op, asJson, async () => {
      const caller = resolveVoiceCaller(op);
      const call = requireActiveCall(op, callId, asJson);
      assertCallerControlsCall(caller, call, "approve");
      const approval = listOpenVoiceApprovals(call.id).find((item) => item.approvalId === approvalId);
      if (!approval) fail(op, "VOICE_APPROVAL_NOT_OPEN", `Approval ${approvalId} is not open in this call.`, asJson);
      const decision = await submitApprovalDecision(op, caller, call.id, approvalId, VOICE_REJECT_EMOJI, asJson);
      return emit({ callId: call.id, approvalId, decision }, asJson, () => console.log(decisionLine(decision)));
    });
  }

  @Command({ name: "end", description: "End the call (work already running keeps going in the session)" })
  @CommandAccess({ kind: "mutate", resource: "voice", action: "calls.end", risk: "low" })
  async end(
    @Arg("call", { description: "Call id" }) callId: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "voice calls end";
    return run(op, asJson, async () => {
      const caller = resolveVoiceCaller(op);
      const call = requireCall(op, callId, asJson);
      assertCallerControlsCall(caller, call, "control");
      if (call.state !== "ended") await sendVoiceControl({ op: "end", callId: call.id, reason: "ended" });
      return emit({ callId: call.id, ended: true }, asJson, () => console.log(`Call ${call.id} ended.`));
    });
  }
}

// ---------------------------------------------------------------------------
// voice profiles
// ---------------------------------------------------------------------------

interface ProfileFlags {
  label?: string;
  mode?: string;
  language?: string;
  voice?: string;
  ttsModel?: string;
  liveVoice?: string;
  liveModel?: string;
  delivery?: string;
  allowGuests?: boolean;
  noGuests?: boolean;
  maxCallMinutes?: string;
  maxCallCost?: string;
  maxDailyCost?: string;
}

function applyProfileFlags(op: string, base: VoiceProfile, flags: ProfileFlags, asJson?: boolean): VoiceProfile {
  const delivery = flags.delivery;
  if (delivery !== undefined && !(VOICE_DELIVERY_CLASSES as readonly string[]).includes(delivery)) {
    fail(
      op,
      "USAGE_ERROR",
      `--delivery must be one of ${VOICE_DELIVERY_CLASSES.join(", ")}.`,
      asJson,
      CONTRACT_EXIT_USAGE,
    );
  }
  return {
    ...base,
    ...(flags.label !== undefined ? { label: flags.label } : {}),
    ...(flags.mode !== undefined ? { mode: parseMode(op, flags.mode, asJson) as VoiceMode } : {}),
    ...(flags.language !== undefined ? { language: flags.language } : {}),
    ...(flags.voice !== undefined ? { voice: flags.voice } : {}),
    ...(flags.ttsModel !== undefined ? { ttsModel: flags.ttsModel } : {}),
    ...(flags.liveVoice !== undefined ? { liveVoice: flags.liveVoice } : {}),
    ...(flags.liveModel !== undefined ? { liveModel: flags.liveModel } : {}),
    ...(delivery !== undefined ? { delivery: delivery as VoiceDeliveryClass } : {}),
    ...(flags.allowGuests ? { allowGuests: true } : {}),
    ...(flags.noGuests ? { allowGuests: false } : {}),
    ...(flags.maxCallMinutes !== undefined
      ? { maxCallMinutes: parseNumber(op, "--max-call-minutes", flags.maxCallMinutes, asJson) as number }
      : {}),
    ...(flags.maxCallCost !== undefined
      ? { maxCallCostUsd: parseNumber(op, "--max-call-cost", flags.maxCallCost, asJson) as number }
      : {}),
    ...(flags.maxDailyCost !== undefined
      ? { maxDailyCostUsd: parseNumber(op, "--max-daily-cost", flags.maxDailyCost, asJson) as number }
      : {}),
    updatedAt: Date.now(),
  };
}

@Group({ name: "voice.profiles", description: "Voice profiles: mode, voice, language and spend limits", scope: "open" })
export class VoiceProfilesCommands {
  @Command({ name: "list", description: "List voice profiles" })
  @CommandAccess({ kind: "read", resource: "voice", action: "profiles.list", risk: "low" })
  async list(
    @Option({ flags: "--limit <n>", description: "Page size (default: 50, max: 500)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Items to skip (default: 0)" }) offset?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "voice profiles list";
    return run(op, asJson, () => {
      resolveVoiceCaller(op);
      const page = pageOf(listVoiceProfiles(), ["ravi", "voice", "profiles", "list"], limit, offset);
      const profiles = page.items;
      return emit({ profiles, total: page.total, pagination: page.pagination }, asJson, () => {
        for (const profile of profiles)
          console.log(`${profile.id}\t${profile.mode}\t${profile.language}\t${profile.label}`);
      });
    });
  }

  @Command({ name: "show", description: "Show one voice profile" })
  @CommandAccess({ kind: "read", resource: "voice", action: "profiles.show", risk: "low" })
  async show(
    @Arg("id", { description: "Profile id" }) id: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "voice profiles show";
    return run(op, asJson, () => {
      resolveVoiceCaller(op);
      const profile = getVoiceProfile(id);
      if (!profile) fail(op, "VOICE_PROFILE_NOT_FOUND", `Profile ${id} not found.`, asJson);
      return emit({ profile }, asJson, () => printJson(profile));
    });
  }

  @Command({ name: "create", description: "Create a voice profile" })
  @CommandAccess({ kind: "mutate", resource: "voice", action: "profiles.create", risk: "low" })
  async create(
    @Arg("id", { description: "Profile id (letters, digits, - and _)" }) id: string,
    @Option({ flags: "--label <text>", description: "Display name" }) label?: string,
    @Option({ flags: "--mode <mode>", description: "push|live|handsfree|mock" }) mode?: string,
    @Option({ flags: "--language <code>", description: "Language, e.g. pt or en" }) language?: string,
    @Option({ flags: "--voice <id>", description: "ElevenLabs voice id (push and hands-free)" }) voice?: string,
    @Option({ flags: "--tts-model <id>", description: "ElevenLabs model id" }) ttsModel?: string,
    @Option({ flags: "--live-voice <name>", description: "GPT-Live voice" }) liveVoice?: string,
    @Option({ flags: "--live-model <id>", description: "GPT-Live model" }) liveModel?: string,
    @Option({ flags: "--delivery <class>", description: "speak|when_idle|silent" }) delivery?: string,
    @Option({ flags: "--allow-guests", description: "Accept third-party speakers (speech only, never control)" })
    allowGuests?: boolean,
    @Option({ flags: "--max-call-minutes <n>", description: "End calls after this many minutes" })
    maxCallMinutes?: string,
    @Option({ flags: "--max-call-cost <usd>", description: "End a call at this estimated cost" }) maxCallCost?: string,
    @Option({ flags: "--max-daily-cost <usd>", description: "Refuse and end calls past this daily cost" })
    maxDailyCost?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "voice profiles create";
    return run(op, asJson, () => {
      requireOperator(op, resolveVoiceCaller(op), asJson);
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) {
        fail(op, "USAGE_ERROR", "Profile ids use letters, digits, - and _.", asJson, CONTRACT_EXIT_USAGE);
      }
      if (id !== DEFAULT_VOICE_PROFILE_ID && getVoiceProfile(id)) {
        fail(op, "VOICE_PROFILE_EXISTS", `Profile ${id} already exists; use update.`, asJson);
      }
      const now = Date.now();
      const base = { ...(getVoiceProfile(DEFAULT_VOICE_PROFILE_ID) as VoiceProfile), id, label: id, createdAt: now };
      const profile = saveVoiceProfile(
        applyProfileFlags(
          op,
          base,
          {
            label,
            mode,
            language,
            voice,
            ttsModel,
            liveVoice,
            liveModel,
            delivery,
            allowGuests,
            maxCallMinutes,
            maxCallCost,
            maxDailyCost,
          },
          asJson,
        ),
      );
      return emit({ profile }, asJson, () => console.log(`Profile ${profile.id} saved.`));
    });
  }

  @Command({ name: "update", description: "Update a voice profile" })
  @CommandAccess({ kind: "mutate", resource: "voice", action: "profiles.update", risk: "low" })
  async update(
    @Arg("id", { description: "Profile id" }) id: string,
    @Option({ flags: "--label <text>", description: "Display name" }) label?: string,
    @Option({ flags: "--mode <mode>", description: "push|live|handsfree|mock" }) mode?: string,
    @Option({ flags: "--language <code>", description: "Language, e.g. pt or en" }) language?: string,
    @Option({ flags: "--voice <id>", description: "ElevenLabs voice id (push and hands-free)" }) voice?: string,
    @Option({ flags: "--tts-model <id>", description: "ElevenLabs model id" }) ttsModel?: string,
    @Option({ flags: "--live-voice <name>", description: "GPT-Live voice" }) liveVoice?: string,
    @Option({ flags: "--live-model <id>", description: "GPT-Live model" }) liveModel?: string,
    @Option({ flags: "--delivery <class>", description: "speak|when_idle|silent" }) delivery?: string,
    @Option({ flags: "--allow-guests", description: "Accept third-party speakers" }) allowGuests?: boolean,
    @Option({ flags: "--no-guests", description: "Stop accepting third-party speakers" }) noGuests?: boolean,
    @Option({ flags: "--max-call-minutes <n>", description: "End calls after this many minutes" })
    maxCallMinutes?: string,
    @Option({ flags: "--max-call-cost <usd>", description: "End a call at this estimated cost" }) maxCallCost?: string,
    @Option({ flags: "--max-daily-cost <usd>", description: "Refuse and end calls past this daily cost" })
    maxDailyCost?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "voice profiles update";
    return run(op, asJson, () => {
      requireOperator(op, resolveVoiceCaller(op), asJson);
      const current = getVoiceProfile(id);
      if (!current) fail(op, "VOICE_PROFILE_NOT_FOUND", `Profile ${id} not found.`, asJson);
      const profile = saveVoiceProfile(
        applyProfileFlags(
          op,
          { ...current, createdAt: current.createdAt || Date.now() },
          {
            label,
            mode,
            language,
            voice,
            ttsModel,
            liveVoice,
            liveModel,
            delivery,
            allowGuests,
            noGuests,
            maxCallMinutes,
            maxCallCost,
            maxDailyCost,
          },
          asJson,
        ),
      );
      return emit({ profile }, asJson, () => console.log(`Profile ${profile.id} updated.`));
    });
  }

  @Command({ name: "delete", description: "Delete a voice profile" })
  @CommandAccess({ kind: "mutate", resource: "voice", action: "profiles.delete", risk: "low" })
  async delete(
    @Arg("id", { description: "Profile id" }) id: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "voice profiles delete";
    return run(op, asJson, () => {
      requireOperator(op, resolveVoiceCaller(op), asJson);
      const deleted = deleteVoiceProfile(id);
      if (!deleted) fail(op, "VOICE_PROFILE_NOT_FOUND", `Profile ${id} not found.`, asJson);
      return emit({ id, deleted: true }, asJson, () => console.log(`Profile ${id} deleted.`));
    });
  }
}

// ---------------------------------------------------------------------------
// voice voices
// ---------------------------------------------------------------------------

@Group({ name: "voice.voices", description: "Voices available for speech", scope: "open" })
export class VoiceVoicesCommands {
  @Command({ name: "list", description: "List ElevenLabs voices for push-to-talk and hands-free" })
  @CommandAccess({ kind: "read", resource: "voice", action: "voices.list", risk: "low" })
  async list(
    @Option({ flags: "--search <text>", description: "Filter by name or description" }) search?: string,
    @Option({ flags: "--limit <n>", description: "Page size (default: 50, max: 500)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Items to skip (default: 0)" }) offset?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "voice voices list";
    return run(op, asJson, async () => {
      resolveVoiceCaller(op);
      const result = await listElevenLabsVoices({
        ...(search ? { search } : {}),
        limit: 100,
      });
      const all = result.voices.map((voice) => ({
        voiceId: voice.voiceId,
        name: voice.name,
        ...(voice.category ? { category: voice.category } : {}),
        ...(voice.labels ? { labels: voice.labels } : {}),
      }));
      const page = pageOf(all, ["ravi", "voice", "voices", "list"], limit, offset, ["--search", search ?? null]);
      const voices = page.items;
      return emit({ voices, total: page.total, pagination: page.pagination }, asJson, () => {
        for (const voice of voices) console.log(`${voice.voiceId}\t${voice.name}`);
      });
    });
  }
}

// ---------------------------------------------------------------------------
// voice devices
// ---------------------------------------------------------------------------

function publicDevice(device: ReturnType<typeof getVoiceDevice>) {
  if (!device) return null;
  return {
    id: device.id,
    label: device.label,
    contactId: device.contactId,
    sessions: device.sessions,
    createdAt: new Date(device.createdAt).toISOString(),
    expiresAt: new Date(device.expiresAt).toISOString(),
    revoked: Boolean(device.revokedAt),
    ...(device.lastSeenAt ? { lastSeenAt: new Date(device.lastSeenAt).toISOString() } : {}),
  };
}

@Group({ name: "voice.devices", description: "Paired voice devices (person-bound keys)", scope: "open" })
export class VoiceDevicesCommands {
  @Command({
    name: "pair",
    description: "Pair a device for one person and issue its key (dry-run by default; requires --execute)",
  })
  @CommandAccess({
    kind: "mutate",
    resource: "voice",
    action: "devices.pair",
    risk: "high",
    requiresConfirmation: true,
  })
  async pair(
    @Option({ flags: "--contact <id>", description: "The person this device speaks for" }) contactRef?: string,
    @Option({ flags: "--label <text>", description: "Device name, e.g. 'iPhone'" }) label?: string,
    @Option({
      flags: "--session <names>",
      description: "Sessions it may call (comma-separated; '*' only for the owner)",
    })
    sessionsValue?: string | string[],
    @Option({ flags: "--worker", description: "Issue a hands-free worker key instead of a person's device key" })
    worker?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({
      flags: "--execute",
      description: "Actually pair and print the key once; default is a dry-run that only shows the plan (exit 3)",
    })
    execute?: boolean,
  ) {
    const op = "voice devices pair";
    return run(op, asJson, () => {
      requireOperator(op, resolveVoiceCaller(op), asJson);
      if (!contactRef) fail(op, "USAGE_ERROR", "--contact <id> is required.", asJson, CONTRACT_EXIT_USAGE);
      const contact = getContactDetails(contactRef);
      if (!contact) fail(op, "VOICE_CONTACT_NOT_FOUND", `Contact ${contactRef} not found.`, asJson);
      const contactId = contact.contact?.id ?? contactRef;
      const sessions = worker ? [] : splitList(sessionsValue);
      if (!worker && sessions.length === 0) {
        fail(
          op,
          "USAGE_ERROR",
          "--session <names> is required ('*' for every session, owner only).",
          asJson,
          CONTRACT_EXIT_USAGE,
        );
      }
      if (sessions.includes("*") && !isOwnerContact(contactId)) {
        fail(
          op,
          "VOICE_PAIR_WILDCARD_OWNER_ONLY",
          "Only the owner may call every session; list the sessions for this person.",
          asJson,
          CONTRACT_EXIT_POLICY,
        );
      }
      // Store the session key, not the typed name: a rename (or a new session
      // taking a released name) must not change what the device may call.
      const sessionKeys = sessions.map((name) => {
        if (name === "*") return name;
        const session = resolveSession(name);
        if (!session) fail(op, "VOICE_SESSION_NOT_FOUND", `Session ${name} not found.`, asJson);
        return session.sessionKey;
      });
      const plan = {
        contactId,
        label: label ?? (worker ? "voice worker" : "device"),
        sessions: sessionKeys,
        kind: worker ? VOICE_WORKER_CONTEXT_KIND : VOICE_DEVICE_CONTEXT_KIND,
        ttlDays: DEVICE_TTL_MS / 86_400_000,
      };
      if (execute !== true) contractDryRun(op, plan, { asJson });
      const deviceId = newVoiceDeviceId();
      const context = createRuntimeContext({
        // No agent: the key holds only voice capabilities and every voice command
        // checks the device record itself (sessions, own calls).
        kind: plan.kind,
        capabilities: VOICE_DEVICE_CAPABILITIES.map((capability) => ({ ...capability, source: "voice-device" })),
        metadata: { voiceDeviceId: deviceId, relayCallerContactId: contactId, cliName: "voice-device" },
        ttlMs: DEVICE_TTL_MS,
      });
      const device = insertVoiceDevice({
        id: deviceId,
        label: plan.label,
        contactId,
        sessions: sessionKeys,
        contextId: context.contextId,
        createdAt: context.createdAt,
        expiresAt: context.expiresAt ?? Date.now() + DEVICE_TTL_MS,
      });
      return emit({ device: publicDevice(device), contextKey: context.contextKey, shownOnce: true }, asJson, () => {
        console.log(`🔑 Device ${device.id} paired for ${contactId}.`);
        console.log(`Key (shown once; keep it in the app's secure storage): ${context.contextKey}`);
      });
    });
  }

  @Command({ name: "list", description: "List paired devices (never their keys)" })
  @CommandAccess({ kind: "read", resource: "voice", action: "devices.list", risk: "low" })
  async list(
    @Option({ flags: "--all", description: "Include revoked devices" }) all?: boolean,
    @Option({ flags: "--limit <n>", description: "Page size (default: 50, max: 500)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Items to skip (default: 0)" }) offset?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "voice devices list";
    return run(op, asJson, () => {
      const caller = resolveVoiceCaller(op);
      const visible = listVoiceDevices({ includeRevoked: Boolean(all) })
        .filter((device) => caller.kind === "operator" || device.id === caller.device?.id)
        .map(publicDevice);
      const page = pageOf(visible, ["ravi", "voice", "devices", "list"], limit, offset, [all ? "--all" : null]);
      const devices = page.items;
      return emit({ devices, total: page.total, pagination: page.pagination }, asJson, () => {
        for (const device of devices) console.log(`${device?.id}\t${device?.label}\t${device?.contactId}`);
      });
    });
  }

  @Command({ name: "revoke", description: "Revoke a device key and end its calls" })
  @CommandAccess({ kind: "mutate", resource: "voice", action: "devices.revoke", risk: "low" })
  async revoke(
    @Arg("device", { description: "Device id" }) deviceId: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "voice devices revoke";
    return run(op, asJson, async () => {
      const caller = resolveVoiceCaller(op);
      if (caller.kind !== "operator" && caller.device?.id !== deviceId) {
        fail(op, "VOICE_OPERATOR_ONLY", "A device can only revoke itself.", asJson, CONTRACT_EXIT_POLICY);
      }
      const device = getVoiceDevice(deviceId);
      if (!device) fail(op, "VOICE_DEVICE_NOT_FOUND", `Device ${deviceId} not found.`, asJson);
      revokeRuntimeContext(device.contextId, { reason: "voice_device_revoked" });
      const revoked = markVoiceDeviceRevoked(device.id);
      // The revoked record is durable: the door's sweep ends any call this
      // loop could not reach. Ask now so they end at once.
      const ended: string[] = [];
      for (const call of listVoiceCalls({ activeOnly: true, speakerId: device.id, limit: "all" })) {
        if (call.speaker.kind === "device" && call.speaker.id === device.id) {
          try {
            await sendVoiceControl({ op: "end", callId: call.id, reason: "device_revoked" });
          } catch (error) {
            // no-cause: the door's sweep ends this call from the revoked record.
            console.warn(`Call ${call.id} will end on the door's next sweep: ${errorDiagnostic(error).cause}`);
          }
          ended.push(call.id);
        }
      }
      return emit({ device: publicDevice(revoked), endedCalls: ended }, asJson, () =>
        console.log(`Device ${device.id} revoked; ${ended.length} call(s) ended.`),
      );
    });
  }
}

// ---------------------------------------------------------------------------
// voice engines
// ---------------------------------------------------------------------------

@Group({ name: "voice.engines", description: "Ears and mouth behind the voice door", scope: "open" })
export class VoiceEnginesCommands {
  @Command({ name: "list", description: "List voice engines and their capabilities" })
  @CommandAccess({ kind: "read", resource: "voice", action: "engines.list", risk: "low" })
  async list(
    @Option({ flags: "--limit <n>", description: "Page size (default: 50, max: 500)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Items to skip (default: 0)" }) offset?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "voice engines list";
    return run(op, asJson, () => {
      resolveVoiceCaller(op);
      const all = listVoiceEngines().map((engine) => ({
        id: engine.id,
        label: engine.label,
        connectionKind: engine.connectionKind,
        capabilities: engine.capabilities,
        costPerMinuteUsd: engine.costPerMinuteUsd,
      }));
      const page = pageOf(all, ["ravi", "voice", "engines", "list"], limit, offset);
      const engines = page.items;
      return emit({ engines, total: page.total, pagination: page.pagination }, asJson, () => {
        for (const engine of engines) console.log(`${engine.id}\t${engine.label}`);
      });
    });
  }

  @Command({ name: "check", description: "Show what each engine is missing (no vendor calls)" })
  @CommandAccess({ kind: "read", resource: "voice", action: "engines.check", risk: "low" })
  async check(@Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean) {
    const op = "voice engines check";
    return run(op, asJson, () => {
      resolveVoiceCaller(op);
      const checks = checkVoiceEngines();
      return emit({ checks }, asJson, () => {
        for (const check of checks) {
          console.log(
            `${check.ready ? "✅" : "❌"} ${check.engine}${check.missing.length ? ` (missing ${check.missing.join(", ")})` : ""}`,
          );
        }
      });
    });
  }
}

// ---------------------------------------------------------------------------
// Return schemas (generated SDK types)
// ---------------------------------------------------------------------------

const speakerSchema = z.object({
  kind: z.enum(["operator", "device", "guest"]),
  id: z.string(),
  contactId: z.string().optional(),
  label: z.string().optional(),
});
const usageSchema = z.object({
  audioInSeconds: z.number(),
  audioOutSeconds: z.number(),
  charactersSpoken: z.number(),
  engineSeconds: z.number(),
  estimatedCostUsd: z.number(),
});
const callSchema = z.object({
  id: z.string(),
  sessionName: z.string(),
  mode: z.enum(VOICE_MODES),
  engine: z.enum(VOICE_MODES),
  profileId: z.string(),
  state: z.enum(VOICE_CALL_STATES),
  agentState: z.enum(VOICE_AGENT_STATES),
  speaker: speakerSchema,
  connectionKind: z.enum(["none", "webrtc", "room"]),
  usage: usageSchema,
  endedReason: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  endedAt: z.string().optional(),
});
const capabilitiesSchema = z.object({
  bargeIn: z.boolean(),
  streamingAudio: z.boolean(),
  exactSpeech: z.boolean(),
  serverAudio: z.boolean(),
  needs: z.array(z.string()),
});
const approvalSchema = z.object({ approvalId: z.string(), version: z.number(), digest: z.string(), text: z.string() });
const eventSchema = z.object({
  callId: z.string(),
  seq: z.number(),
  type: z.enum(VOICE_EVENT_TYPES),
  data: jsonObjectSchema,
  createdAt: z.number(),
});
const profileSchema = z.object({
  id: z.string(),
  label: z.string(),
  mode: z.enum(VOICE_MODES),
  language: z.string(),
  voice: z.string().optional(),
  ttsModel: z.string().optional(),
  liveVoice: z.string().optional(),
  liveModel: z.string().optional(),
  delivery: z.enum(VOICE_DELIVERY_CLASSES),
  allowGuests: z.boolean(),
  maxCallMinutes: z.number(),
  maxCallCostUsd: z.number(),
  maxDailyCostUsd: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
const deviceSchema = z.object({
  id: z.string(),
  label: z.string(),
  contactId: z.string(),
  sessions: z.array(z.string()),
  createdAt: z.string(),
  expiresAt: z.string(),
  revoked: z.boolean(),
  lastSeenAt: z.string().optional(),
});
const page = strictCliOffsetPaginationSchema;
const connectionSchema = z.object({
  callId: z.string(),
  connectionKind: z.enum(["none", "webrtc", "room"]),
  sdpAnswer: z.string().nullable(),
  roomUrl: z.string().nullable(),
  roomToken: z.string().nullable(),
  lastSeq: z.number(),
});

declareCommandReturns(VoiceTargetsCommands, {
  list: z.object({
    targets: z.array(z.object({ sessionName: z.string(), agentId: z.string().nullable(), activeCalls: z.number() })),
    total: z.number(),
    pagination: page,
  }),
});

declareCommandReturns(VoiceCallsCommands, {
  start: connectionSchema.extend({
    sessionName: z.string(),
    mode: z.enum(VOICE_MODES),
    profileId: z.string(),
    state: z.string(),
    capabilities: capabilitiesSchema,
  }),
  connect: connectionSchema,
  list: z.object({ calls: z.array(callSchema), total: z.number(), pagination: page }),
  show: z.object({
    call: callSchema,
    engine: z.object({ id: z.enum(VOICE_MODES), label: z.string(), capabilities: capabilitiesSchema }),
    turns: z.array(
      z.object({
        id: z.string(),
        state: z.enum(["queued", "running", "done", "failed", "cancelled"]),
        speaker: speakerSchema,
        createdAt: z.string(),
      }),
    ),
    openApprovals: z.array(approvalSchema),
    lastSeq: z.number(),
  }),
  transcript: z.object({
    callId: z.string(),
    lines: z.array(z.object({ role: z.enum(["user", "assistant"]), text: z.string(), seq: z.number() })),
  }),
  events: z.object({ callId: z.string(), events: z.array(eventSchema), lastSeq: z.number() }),
  push: z.object({ callId: z.string(), turnId: z.string().nullable(), text: z.string() }),
  send: z.object({ callId: z.string(), turnId: z.string(), text: z.string() }),
  audio: z.object({
    callId: z.string(),
    item: z.string(),
    mime: z.string(),
    bytes: z.number(),
    audioBase64: z.string().optional(),
    path: z.string().optional(),
  }),
  silence: z.object({ callId: z.string(), silenced: z.literal(true) }),
  cancelTurn: z.object({ callId: z.string(), turnId: z.string(), cancelRequested: z.literal(true) }),
  approve: z.object({
    callId: z.string(),
    approvalId: z.string(),
    decision: z.enum(["approved", "rejected", "pending"]),
  }),
  deny: z.object({ callId: z.string(), approvalId: z.string(), decision: z.enum(["approved", "rejected", "pending"]) }),
  end: z.object({ callId: z.string(), ended: z.literal(true) }),
});

declareCommandReturns(VoiceProfilesCommands, {
  list: z.object({ profiles: z.array(profileSchema), total: z.number(), pagination: page }),
  show: z.object({ profile: profileSchema }),
  create: z.object({ profile: profileSchema }),
  update: z.object({ profile: profileSchema }),
  delete: z.object({ id: z.string(), deleted: z.literal(true) }),
});

declareCommandReturns(VoiceVoicesCommands, {
  list: z.object({
    voices: z.array(
      z.object({
        voiceId: z.string(),
        name: z.string(),
        category: z.string().optional(),
        labels: z.record(z.string(), z.string()).optional(),
      }),
    ),
    total: z.number(),
    pagination: page,
  }),
});

declareCommandReturns(VoiceDevicesCommands, {
  pair: z.object({ device: deviceSchema.nullable(), contextKey: z.string(), shownOnce: z.literal(true) }),
  list: z.object({
    devices: z.array(deviceSchema.nullable()),
    total: z.number(),
    pagination: page,
  }),
  revoke: z.object({ device: deviceSchema.nullable(), endedCalls: z.array(z.string()) }),
});

declareCommandReturns(VoiceEnginesCommands, {
  list: z.object({
    engines: z.array(
      z.object({
        id: z.enum(VOICE_MODES),
        label: z.string(),
        connectionKind: z.enum(["none", "webrtc", "room"]),
        capabilities: capabilitiesSchema,
        costPerMinuteUsd: z.number(),
      }),
    ),
    total: z.number(),
    pagination: page,
  }),
  check: z.object({
    checks: z.array(
      z.object({
        engine: z.enum(VOICE_MODES),
        ready: z.boolean(),
        missing: z.array(z.string()),
        notes: z.array(z.string()),
      }),
    ),
  }),
});
