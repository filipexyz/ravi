// The recording as the system reads it, for Knowledge capture: no project
// access check (the caller is a job of the meeting's own organization), the
// part index kept on every segment, and one call clock across parts. Media and
// chat are not read: capture stores what was said, nothing else.

import { z } from "zod";

import { createRecallClient, getRecallConfigFromEnv, RecallApiError, type RecallRecording } from "./recall";
import type { MeetingsDeps } from "./service";
import { dbMeetingBotStore } from "./store";
import { normalizeRecallTranscript, type MeetingTranscriptSegment } from "./transcript";

export type SystemMeetingSegment = MeetingTranscriptSegment & { part: number; callSeconds: number | null };

export type SystemMeetingRecording = {
  status: "ok";
  meeting: { id: string; projectId: string; title: string | null; startedAt: string | null; language: string | null };
  segments: SystemMeetingSegment[];
  recordings: Array<{ startedAt: string | null; completedAt: string | null; expiresAt: string | null }>;
};

/** Thrown for a state worth retrying (the job backs off): the code travels, never a message. */
export class MeetingCaptureRetryError extends Error {
  constructor(public readonly code: "meeting_not_ready" | "meetings_vendor_unconfigured" | "meetings_vendor_unavailable") {
    super(code);
    this.name = "MeetingCaptureRetryError";
  }
}

/** Transcript states that settle later; anything else (done, failed, absent) is final. */
const PENDING_TRANSCRIPT_CODES = new Set(["processing", "pending", "queued", "in_progress"]);

export async function loadRecordingForSystem(
  input: { organizationId: string; meetingId: string },
  deps: Pick<MeetingsDeps, "store" | "recall" | "now"> = {},
): Promise<SystemMeetingRecording | { status: "not_ready" | "no_project" | "gone" | "not_found" }> {
  if (!z.string().uuid().safeParse(input.meetingId).success) return { status: "not_found" };
  const store = deps.store ?? dbMeetingBotStore;
  const row = await store.findById(input.organizationId, input.meetingId);
  if (!row) return { status: "not_found" };
  if (row.status !== "done" || !row.providerBotId) return { status: "not_ready" };
  if (!row.projectId) return { status: "no_project" };

  const recall = deps.recall !== undefined ? deps.recall : recallFromEnv();
  if (!recall) throw new MeetingCaptureRetryError("meetings_vendor_unconfigured");
  const now = (deps.now ?? (() => new Date()))();

  let recordings: RecallRecording[];
  try {
    const bot = await recall.getBot(row.providerBotId);
    // The same list (and so the same part numbers) the recording route serves.
    recordings = (bot.recordings ?? []).filter((recording) => recording.status?.code !== "deleted");
  } catch (error) {
    if (error instanceof RecallApiError && error.status === 404) return { status: "gone" };
    if (error instanceof RecallApiError) throw new MeetingCaptureRetryError("meetings_vendor_unavailable");
    throw error;
  }
  const live = recordings.map((recording) => !isExpired(recording.expires_at, now));
  if (!live.some(Boolean)) return { status: "gone" };

  const segments: SystemMeetingSegment[] = [];
  const first = recordings[0]?.started_at ? Date.parse(recordings[0].started_at) : NaN;
  const placed = recordings.length > 1 && recordings.every((recording) => Number.isFinite(recording.started_at ? Date.parse(recording.started_at) : NaN));
  try {
    for (const [part, recording] of recordings.entries()) {
      if (!live[part]) continue;
      const transcript = recording.media_shortcuts?.transcript;
      const code = transcript?.status?.code ?? null;
      const url = transcript?.data?.download_url;
      if (code === "done" && url) {
        for (const segment of normalizeRecallTranscript(await recall.downloadJson(url))) {
          segments.push({ ...segment, part, callSeconds: callSeconds(segment, recordings.length, placed, first) });
        }
      } else if (code && PENDING_TRANSCRIPT_CODES.has(code)) {
        throw new MeetingCaptureRetryError("meeting_not_ready");
      }
    }
  } catch (error) {
    if (error instanceof RecallApiError) throw new MeetingCaptureRetryError("meetings_vendor_unavailable");
    throw error;
  }

  return {
    status: "ok",
    meeting: {
      id: row.id,
      projectId: row.projectId,
      title: row.title,
      startedAt: row.recordingStartedAt?.toISOString() ?? recordings[0]?.started_at ?? null,
      language: row.language ?? null,
    },
    segments,
    recordings: recordings.map((recording) => ({
      startedAt: recording.started_at ?? null,
      completedAt: recording.completed_at ?? null,
      expiresAt: recording.expires_at ?? null,
    })),
  };
}

/**
 * Seconds on the call's clock. One part: the part's own time. Several parts:
 * the segment's absolute time against the first part's start, when every part
 * started at a known time; otherwise null, never a guess. On every input the
 * conversation can seek this equals its clock (`features/meetings/conversation.ts`).
 */
function callSeconds(segment: MeetingTranscriptSegment, partCount: number, placed: boolean, first: number): number | null {
  if (partCount <= 1) return segment.startSeconds;
  if (!placed || !segment.startedAt) return null;
  const at = Date.parse(segment.startedAt);
  return Number.isFinite(at) ? Math.max(0, (at - first) / 1000) : null;
}

function isExpired(expiresAt: string | null | undefined, now: Date) {
  if (!expiresAt) return false;
  const at = Date.parse(expiresAt);
  return Number.isFinite(at) && at <= now.getTime();
}

function recallFromEnv() {
  const config = getRecallConfigFromEnv();
  return config ? createRecallClient(config) : null;
}
