/**
 * `voice/{call}`: the resumable event stream of one voice call. Opens with
 * `call.snapshot`, replays stored events after `?after=<seq>`, then follows live
 * events. Every event carries its per-call `seq`; use it as the resume cursor.
 */
import { nats } from "../../../nats.js";
import { VOICE_DEVICE_CONTEXT_KIND, VOICE_WORKER_CONTEXT_KIND } from "../../../voice/authority.js";
import { listOpenVoiceApprovals } from "../../../voice/approvals.js";
import { getVoiceCall, getVoiceDeviceByContextId, lastVoiceEventSeq, listVoiceEvents } from "../../../voice/store.js";
import { VOICE_EVENT_TYPES, type VoiceEvent, voiceSubjects } from "../../../voice/types.js";
import type { StreamChannel, StreamChannelMatch, StreamEvent, StreamRequestContext } from "./types.js";

const VOICE_EVENT_SCHEMA = {
  type: "object",
  required: ["callId", "seq", "type", "data"],
  additionalProperties: false,
  properties: {
    callId: { type: "string" },
    seq: { type: "number", description: "Per-call sequence number; resume with ?after=<seq>." },
    type: { enum: [...VOICE_EVENT_TYPES] },
    data: { type: "object", additionalProperties: {} },
    createdAt: { type: "number" },
  },
} as const;

export interface VoiceStreamDeps {
  subscribe: (signal: AbortSignal, topic: string) => AsyncIterable<{ topic: string; data: Record<string, unknown> }>;
  /** How long the live loop waits quietly before re-reading the store (default 5 s). */
  gapCheckMs?: number;
}

const VOICE_STREAM_GAP_CHECK_MS = 5_000;

const defaultDeps: VoiceStreamDeps = {
  subscribe: (signal, topic) => nats.subscribe(topic, { signal }),
};

export function createVoiceCallChannel(deps: VoiceStreamDeps = defaultDeps): StreamChannel {
  return {
    name: "voice",
    meta: {
      methodName: "voiceCall",
      pathPattern: "voice/{call}",
      description:
        "Follow one voice call: call.snapshot first, then stored events after `after`, then live events " +
        "(transcripts, agent state, work state, approvals, usage). Resume with the last `seq` seen.",
      optionsTypeName: "VoiceCallStreamOptions",
      payloadTypeName: "VoiceCallStreamPayload",
      optionsSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          after: { type: "number", description: "Replay stored events with seq greater than this." },
        },
      },
      payloadSchema: VOICE_EVENT_SCHEMA,
    },
    match(segments) {
      if (segments.length !== 2 || segments[0] !== "voice" || !segments[1]) return null;
      return {
        channelPath: `voice/${segments[1]}`,
        scope: { permission: "access", objectType: "voice-call", objectId: segments[1] },
      };
    },
    subscribe: (ctx, match) => subscribeVoiceCall(ctx, match, deps),
  };
}

export const voiceCallChannel = createVoiceCallChannel();

function deviceMayRead(ctx: StreamRequestContext, callSpeakerId: string, mode: string): boolean {
  const record = ctx.contextRecord;
  if (record?.kind === VOICE_DEVICE_CONTEXT_KIND) {
    const device = getVoiceDeviceByContextId(record.contextId);
    return Boolean(device && !device.revokedAt && device.id === callSpeakerId);
  }
  if (record?.kind === VOICE_WORKER_CONTEXT_KIND) {
    const device = getVoiceDeviceByContextId(record.contextId);
    return Boolean(device && !device.revokedAt && mode === "handsfree");
  }
  return true;
}

async function* subscribeVoiceCall(
  ctx: StreamRequestContext,
  match: StreamChannelMatch,
  deps: VoiceStreamDeps,
): AsyncIterable<StreamEvent> {
  const callId = match.scope.objectId;
  const call = getVoiceCall(callId);
  if (!call || !deviceMayRead(ctx, call.speaker.id, call.mode)) {
    yield { event: "end", data: { type: "stream.end", reason: "not_found", callId } };
    return;
  }
  const afterParam = Number(ctx.url.searchParams.get("after") ?? "0");
  let cursor = Number.isInteger(afterParam) && afterParam > 0 ? afterParam : 0;

  // Subscribe before reading the store so nothing published in between is lost.
  const local = new AbortController();
  const onAbort = () => local.abort();
  ctx.signal.addEventListener("abort", onAbort, { once: true });
  if (ctx.signal.aborted) local.abort();
  const buffered: VoiceEvent[] = [];
  const waker: { wake: (() => void) | null } = { wake: null };
  const pump = (async () => {
    try {
      for await (const item of deps.subscribe(local.signal, voiceSubjects.event(callId))) {
        buffered.push(item.data as unknown as VoiceEvent);
        waker.wake?.();
      }
    } catch {
      // no-cause: the stream ends below when the subscription drops.
    } finally {
      waker.wake?.();
    }
  })();

  try {
    yield {
      id: String(lastVoiceEventSeq(callId)),
      event: "message",
      data: {
        callId,
        seq: 0,
        type: "call.snapshot",
        data: {
          call: {
            id: call.id,
            sessionName: call.sessionName,
            mode: call.mode,
            state: call.state,
            agentState: call.agentState,
            connectionKind: call.connectionKind,
            usage: call.usage,
          },
          openApprovals: listOpenVoiceApprovals(callId),
          lastSeq: lastVoiceEventSeq(callId),
        },
        createdAt: Date.now(),
      },
    };
    for (const event of listVoiceEvents(callId, { after: cursor, limit: 5000 })) {
      cursor = event.seq;
      yield { id: String(event.seq), event: "message", data: event };
      if (event.type === "call.ended") return;
    }
    if (getVoiceCall(callId)?.state === "ended" && !buffered.length) return;
    // The subscription may register after the replay read. Events are stored
    // before they are published, so any gap (a live seq past cursor + 1, or a
    // quiet spell) is filled from the store in order.
    while (!local.signal.aborted) {
      if (buffered.length === 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, deps.gapCheckMs ?? VOICE_STREAM_GAP_CHECK_MS);
          waker.wake = () => {
            clearTimeout(timer);
            resolve();
          };
          local.signal.addEventListener("abort", () => waker.wake?.(), { once: true });
        });
        waker.wake = null;
        if (buffered.length === 0 && !local.signal.aborted) {
          for (const stored of listVoiceEvents(callId, { after: cursor, limit: 5000 })) {
            cursor = stored.seq;
            yield { id: String(stored.seq), event: "message", data: stored };
            if (stored.type === "call.ended") return;
          }
        }
        continue;
      }
      const event = buffered.shift() as VoiceEvent;
      if (typeof event?.seq !== "number" || event.seq <= cursor) continue;
      if (event.seq > cursor + 1) {
        for (const stored of listVoiceEvents(callId, { after: cursor, limit: 5000 })) {
          if (stored.seq >= event.seq) break;
          cursor = stored.seq;
          yield { id: String(stored.seq), event: "message", data: stored };
          if (stored.type === "call.ended") return;
        }
      }
      cursor = event.seq;
      yield { id: String(event.seq), event: "message", data: event };
      if (event.type === "call.ended") return;
    }
  } finally {
    local.abort();
    ctx.signal.removeEventListener("abort", onAbort);
    await pump;
  }
}
