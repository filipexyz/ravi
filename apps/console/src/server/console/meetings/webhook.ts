// Recall status and artifact webhooks move a meeting bot through its states,
// bill it once when it finishes, and tell the local Ravi that asked for it
// when the recording can be fetched.

import type { JsonRecord } from "@/server/db/schema";

import { AGENT_INBOX_TARGET_LOCAL_INSTALLATION } from "@/server/console/agent-inbox";
import { isKnowledgeEnabledForOrganization } from "@/server/console/knowledge/enabled";
import { enqueueMeetingKnowledgeCapture } from "@/server/console/knowledge/producers/meeting";
import { scheduleKnowledgeDrain } from "@/server/console/knowledge/schedule";

import { RECALL_PROVIDER, RecallApiError, type RecallBot, type RecallClient, type RecallWebhookEvent } from "./recall";
import { dbMeetingBotStore, type MeetingBotPatch, type MeetingBotRow, type MeetingBotStore, type MeetingInboxItem } from "./store";
import { buildMeetingRecordingUsageEvents } from "./usage";

export const MEETINGS_INBOX_CATEGORY = "meetings";
export const MEETING_RECORDING_READY_EVENT = "meetings.recording.ready";
export const MEETING_RECORDING_FAILED_EVENT = "meetings.recording.failed";

type Status = MeetingBotRow["status"];

const STATUS_RANK: Record<Status, number> = {
  requested: 0,
  joining: 1,
  waiting_room: 2,
  in_call: 3,
  recording: 4,
  ended: 5,
  done: 6,
  failed: 6,
};

const BOT_EVENT_STATUS: Record<string, Status> = {
  "bot.joining_call": "joining",
  "bot.in_waiting_room": "waiting_room",
  "bot.in_call_not_recording": "in_call",
  "bot.in_call_recording": "recording",
  "bot.call_ended": "ended",
  "bot.done": "done",
  "bot.fatal": "failed",
};

export type RecallWebhookResult = {
  deliveryId: string;
  duplicate: boolean;
  matched: boolean;
  meetingId: string | null;
  status: Status | null;
  notified: "ready" | "failed" | null;
  /** The meeting's organization and project (from the updated row); null when the bot is not ours. */
  organizationId: string | null;
  projectId: string | null;
};

export async function processRecallWebhook(
  input: { deliveryId: string; event: RecallWebhookEvent; requestId: string },
  deps: { store?: MeetingBotStore; recall?: RecallClient | null; now?: () => Date } = {},
): Promise<RecallWebhookResult> {
  const store = deps.store ?? dbMeetingBotStore;
  const { event } = input;
  const unmatched = {
    deliveryId: input.deliveryId,
    duplicate: false,
    matched: false,
    meetingId: null,
    status: null,
    notified: null,
    organizationId: null,
    projectId: null,
  };

  const row = await store.findByProviderBotId(RECALL_PROVIDER, event.botId);
  // A bot id we never created (another app on the same Recall workspace) is not ours to touch.
  if (!row) return unmatched;
  if (event.metadata.ravi_meeting_id && event.metadata.ravi_meeting_id !== row.id) return unmatched;

  const fresh = await store.recordDelivery({
    organizationId: row.organizationId,
    provider: RECALL_PROVIDER,
    deliveryId: input.deliveryId,
    providerBotId: event.botId,
    eventType: event.event,
    requestId: input.requestId,
    envelope: { event: event.event, code: event.code, subCode: event.subCode },
  });
  if (!fresh) {
    return {
      ...unmatched,
      duplicate: true,
      matched: true,
      meetingId: row.id,
      status: row.status,
      organizationId: row.organizationId,
      projectId: row.projectId,
    };
  }

  try {
    return await applyRecallWebhook(row, input, store, deps);
  } catch (error) {
    // Usage and inbox writes are idempotent, so the vendor's retry of this
    // delivery may run it all again; leaving it marked as seen would drop it.
    await store.forgetDelivery(RECALL_PROVIDER, input.deliveryId);
    throw error;
  }
}

async function applyRecallWebhook(
  row: MeetingBotRow,
  input: { deliveryId: string; event: RecallWebhookEvent; requestId: string },
  store: MeetingBotStore,
  deps: { recall?: RecallClient | null; now?: () => Date },
): Promise<RecallWebhookResult> {
  const { event } = input;
  const now = (deps.now ?? (() => new Date()))();
  const at = event.updatedAt ?? now;
  const patch: MeetingBotPatch = {};
  const nextStatus = BOT_EVENT_STATUS[event.event];
  const terminal = row.status === "done" || row.status === "failed";

  if (nextStatus && !terminal && STATUS_RANK[nextStatus] >= STATUS_RANK[row.status]) {
    patch.status = nextStatus;
    if (event.subCode) patch.statusSubCode = event.subCode;
  }
  if (event.event === "bot.in_call_recording" && !row.recordingStartedAt) patch.recordingStartedAt = at;
  if ((event.event === "bot.call_ended" || event.event === "bot.fatal") && !row.endedAt) patch.endedAt = at;
  if (event.event === "bot.fatal" && !terminal) patch.failureReason = event.subCode ?? "fatal";
  if (event.event === "transcript.done") patch.transcriptStatus = "done";
  if (event.event === "transcript.failed") patch.transcriptStatus = "failed";

  let finishing: "done" | "failed" | null = null;
  if (patch.status === "done") {
    patch.doneAt = at;
    patch.endedAt = row.endedAt ?? patch.endedAt ?? at;
    finishing = "done";
    Object.assign(patch, await recordingFacts(row, deps.recall ?? null));
    if (patch.recordingSeconds === 0 && !row.recordingStartedAt) {
      // Nobody let it in, or the room stayed empty: nothing was recorded.
      patch.status = "failed";
      patch.failureReason = row.statusSubCode ?? event.subCode ?? "no_recording";
      patch.transcriptStatus = "none";
      finishing = "failed";
    }
  } else if (patch.status === "failed") {
    finishing = "failed";
    Object.assign(patch, await recordingFacts(row, deps.recall ?? null));
  }

  if (finishing) {
    // Billed before the row turns terminal: a retry after a failed write still
    // sees an open bot and bills again under the same idempotency keys.
    const billed = { ...row, ...patch };
    await store.recordUsage(
      buildMeetingRecordingUsageEvents({
        organizationId: billed.organizationId,
        projectId: billed.projectId,
        meetingBotId: billed.id,
        provider: billed.provider,
        platform: billed.platform,
        recordingSeconds: billed.recordingSeconds ?? 0,
        outcome: finishing,
        endedAt: billed.endedAt ?? at,
        requestId: input.requestId,
      }),
    );
  }

  let updated = Object.keys(patch).length > 0 ? await store.update(row.id, patch) : row;

  let notified: RecallWebhookResult["notified"] = null;
  if (!updated.readyNotifiedAt) {
    const kind =
      updated.status === "failed"
        ? "failed"
        : updated.status === "done" && updated.transcriptStatus !== "pending"
          ? "ready"
          : null;
    if (kind) {
      const item = buildMeetingRecordingInboxItem(updated, kind, input.requestId);
      if (item) await store.recordInboxItem(item);
      updated = await store.update(updated.id, { readyNotifiedAt: now });
      notified = kind;
    }
  }

  return {
    deliveryId: input.deliveryId,
    duplicate: false,
    matched: true,
    meetingId: updated.id,
    status: updated.status,
    notified,
    organizationId: updated.organizationId,
    projectId: updated.projectId,
  };
}

export type MeetingKnowledgeWebhookDeps = {
  enabled?: (organizationId: string) => Promise<boolean>;
  enqueue?: typeof enqueueMeetingKnowledgeCapture;
  drain?: (requestId: string) => void;
};

/**
 * After a webhook made a recording ready: when the organization has Knowledge
 * on, queue the transcript capture (`meeting_ready:<id>`) and drain after the
 * response. Never throws: the vendor always gets its 202.
 */
export async function queueMeetingKnowledgeAfterWebhook(
  result: RecallWebhookResult,
  context: { requestId: string; title?: string | null },
  deps: MeetingKnowledgeWebhookDeps = {},
): Promise<"queued" | "skipped" | "failed"> {
  if (result.notified !== "ready" || result.status !== "done" || !result.meetingId || !result.organizationId || !result.projectId) {
    return "skipped";
  }
  try {
    if (!(await (deps.enabled ?? isKnowledgeEnabledForOrganization)(result.organizationId))) return "skipped";
    const queued = await (deps.enqueue ?? enqueueMeetingKnowledgeCapture)({
      organizationId: result.organizationId,
      projectId: result.projectId,
      meetingId: result.meetingId,
      title: context.title ?? null,
      trigger: "meeting_ready",
      requestId: context.requestId,
    });
    if (!queued.queued) return "skipped";
    (deps.drain ?? scheduleKnowledgeDrain)(context.requestId);
    return "queued";
  } catch (error) {
    console.warn("[knowledge] meeting capture was not queued from the webhook", {
      meetingId: result.meetingId,
      requestId: context.requestId,
      error: error instanceof Error ? error.name : typeof error,
    });
    return "failed";
  }
}

/**
 * Seconds recorded and the transcript state, read from the vendor's recording
 * timestamps when it answers, and from our own webhook timestamps otherwise.
 */
async function recordingFacts(row: MeetingBotRow, recall: RecallClient | null): Promise<MeetingBotPatch> {
  let bot: RecallBot | null = null;
  if (recall && row.providerBotId) {
    try {
      bot = await recall.getBot(row.providerBotId);
    } catch (error) {
      if (!(error instanceof RecallApiError)) throw error;
    }
  }
  const facts: MeetingBotPatch = {};
  if (bot) {
    const recordings = bot.recordings ?? [];
    facts.recordingSeconds = Math.round(
      recordings.reduce((sum, recording) => {
        const started = recording.started_at ? Date.parse(recording.started_at) : NaN;
        const completed = recording.completed_at ? Date.parse(recording.completed_at) : NaN;
        return Number.isFinite(started) && Number.isFinite(completed) && completed > started
          ? sum + (completed - started) / 1000
          : sum;
      }, 0),
    );
    const transcripts = recordings.map((recording) => recording.media_shortcuts?.transcript?.status?.code ?? null);
    if (transcripts.length > 0 && transcripts.every((code) => code === "done")) facts.transcriptStatus = "done";
    else if (transcripts.some((code) => code === "failed")) facts.transcriptStatus = "failed";
  } else if (row.recordingStartedAt) {
    const end = row.endedAt ?? new Date();
    facts.recordingSeconds = Math.max(0, Math.round((end.getTime() - row.recordingStartedAt.getTime()) / 1000));
  } else {
    facts.recordingSeconds = 0;
  }
  if (facts.recordingSeconds !== undefined) {
    facts.recordingSeconds = Math.min(facts.recordingSeconds, row.maxRecordingSeconds + 120);
  }
  return facts;
}

/** Goes only to the local installation that asked for the bot; ids and states, no transcript text. */
export function buildMeetingRecordingInboxItem(
  row: MeetingBotRow,
  kind: "ready" | "failed",
  requestId: string,
): MeetingInboxItem | null {
  if (!row.localInstallationId) return null;
  const ready = kind === "ready";
  const label = row.title ?? row.meetingCode ?? "meeting";
  const payloadJson: JsonRecord = {
    meetingId: row.id,
    projectId: row.projectId,
    platform: row.platform,
    meetingCode: row.meetingCode,
    title: row.title,
    clientRef: row.clientRef,
    status: row.status,
    statusSubCode: row.statusSubCode,
    transcriptStatus: row.transcriptStatus,
    recordingSeconds: row.recordingSeconds,
    failureReason: row.failureReason,
    endedAt: row.endedAt?.toISOString() ?? null,
    requestId,
  };
  return {
    actorType: "system",
    category: MEETINGS_INBOX_CATEGORY,
    dedupeKey: `meetings:bot:${row.id}:${kind}`,
    eventType: ready ? MEETING_RECORDING_READY_EVENT : MEETING_RECORDING_FAILED_EVENT,
    linksJson: { meetingId: row.id },
    organizationId: row.organizationId,
    payloadJson,
    projectId: row.projectId,
    sensitivity: "restricted",
    severity: ready ? "success" : "warning",
    sourceId: row.id,
    sourceType: "meeting_bot",
    summary: ready
      ? `The recording of ${label} is ready to fetch.`
      : `The bot for ${label} ended without a recording (${row.failureReason ?? row.statusSubCode ?? "unknown"}).`,
    targetId: row.localInstallationId,
    targetType: AGENT_INBOX_TARGET_LOCAL_INSTALLATION,
    title: ready ? "Meeting recording ready" : "Meeting recording failed",
    occurredAt: row.doneAt ?? row.endedAt ?? new Date(),
  };
}
