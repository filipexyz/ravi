// Turns a finished cloud meeting into local artifacts: downloads the media,
// registers the `meeting.raw` artifact, closes the `meeting.join` artifact
// that `ravi meetings join` created, and hands the result to the session that
// asked for it. Safe to run twice: a join artifact that already points at its
// raw artifact is returned as is.

import {
  appendArtifactEvent,
  attachArtifact,
  getArtifact,
  updateArtifact,
  type ArtifactRecord,
} from "../artifacts/store.js";
import {
  buildCloudMeetingSession,
  defaultCloudMeetingDir,
  downloadCloudMeetingMedia,
  type CloudMeeting,
  type CloudMeetingOrigin,
  type MeetingsCloudClient,
} from "./cloud.js";
import { notifyMeetingOwnerSession } from "./handoff.js";
import { registerMeetingRawArtifact } from "./raw-artifact.js";

const SOURCE = "ravi.meetings.cloud";

export interface CloudMeetingFinalizeResult {
  status: "finalized" | "already_finalized";
  meetingId: string;
  joinArtifactId: string | null;
  rawArtifactId: string;
  rawArtifactPath: string | null;
  transcriptSegmentCount: number;
  mediaRefCount: number;
  downloadedMediaCount: number;
  notified: boolean;
}

export interface CloudMeetingFinalizeDeps {
  fetchImpl?: typeof fetch;
  notify?: typeof notifyMeetingOwnerSession;
}

/** The local `meeting.join` artifact for a Console meeting, found through the `clientRef` the CLI sent. */
export function findCloudMeetingJoinArtifact(meeting: Pick<CloudMeeting, "id" | "clientRef">): ArtifactRecord | null {
  if (!meeting.clientRef) return null;
  const artifact = getArtifact(meeting.clientRef);
  if (!artifact || artifact.kind !== "meeting.join") return null;
  return artifact.metadata?.consoleMeetingId === meeting.id ? artifact : null;
}

export async function finalizeCloudMeeting(
  input: {
    client: MeetingsCloudClient;
    meetingId: string;
    outputDir?: string;
    video?: boolean;
    actor?: string;
    notify?: boolean;
  },
  deps: CloudMeetingFinalizeDeps = {},
): Promise<CloudMeetingFinalizeResult> {
  const meeting = await input.client.show(input.meetingId);
  const join = findCloudMeetingJoinArtifact(meeting);
  const existingRawId = typeof join?.metadata?.finalArtifactId === "string" ? join.metadata.finalArtifactId : null;
  const existingRaw = existingRawId ? getArtifact(existingRawId) : null;
  if (join && existingRaw) {
    return {
      status: "already_finalized",
      meetingId: meeting.id,
      joinArtifactId: join.id,
      rawArtifactId: existingRaw.id,
      rawArtifactPath: existingRaw.filePath ?? null,
      transcriptSegmentCount: 0,
      mediaRefCount: 0,
      downloadedMediaCount: 0,
      notified: false,
    };
  }

  const recording = await input.client.recording(meeting.id);
  const outputDir = input.outputDir ?? defaultCloudMeetingDir(meeting.id);
  const mediaRefs = await downloadCloudMeetingMedia({
    recording,
    outputDir,
    video: input.video,
    fetchImpl: deps.fetchImpl,
  });
  const session = buildCloudMeetingSession({ recording, origin: originFrom(join), mediaRefs });
  const registered = registerMeetingRawArtifact({ session, outputDir, actor: input.actor ?? SOURCE });

  let notified = false;
  if (join) {
    attachArtifact(registered.artifact.id, "artifact", join.id, "generated-by", { source: SOURCE });
    const completed = updateArtifact(
      join.id,
      {
        status: "completed",
        summary: `Meeting ended; raw artifact generated: ${registered.artifact.id}`,
        ...(session.durationMs !== undefined ? { durationMs: session.durationMs } : {}),
        metadata: {
          finalArtifactId: registered.artifact.id,
          finalArtifactPath: registered.filePath,
          cloudStatus: meeting.status,
          recordingSeconds: meeting.recordingSeconds,
        },
        output: { finalArtifactId: registered.artifact.id, finalArtifactPath: registered.filePath },
      },
      { actor: input.actor, mergeMetadata: true },
    );
    appendArtifactEvent(completed.id, {
      eventType: "completed",
      status: "completed",
      message: `Meeting raw artifact generated: ${registered.artifact.id}`,
      payload: { finalArtifactId: registered.artifact.id, consoleMeetingId: meeting.id },
      source: SOURCE,
      ...(input.actor ? { actor: input.actor } : {}),
    });
    if (input.notify !== false) {
      (deps.notify ?? notifyMeetingOwnerSession)(completed, "completed", registered.handoffMessage);
      notified = true;
    }
  }

  return {
    status: "finalized",
    meetingId: meeting.id,
    joinArtifactId: join?.id ?? null,
    rawArtifactId: registered.artifact.id,
    rawArtifactPath: registered.filePath,
    transcriptSegmentCount: session.transcriptSegments?.length ?? 0,
    mediaRefCount: mediaRefs.length,
    downloadedMediaCount: mediaRefs.filter((ref) => Boolean(ref.path)).length,
    notified,
  };
}

/**
 * The bot ended without a recording (nobody admitted it, it was removed, the
 * vendor failed). Closes the join artifact as failed and says why.
 */
export function failCloudMeetingJoin(
  meeting: Pick<CloudMeeting, "id" | "clientRef" | "failureReason" | "statusSubCode" | "title" | "meetingCode">,
  options: { actor?: string; notify?: boolean } = {},
  deps: Pick<CloudMeetingFinalizeDeps, "notify"> = {},
): { joinArtifactId: string | null; notified: boolean } {
  const join = findCloudMeetingJoinArtifact(meeting);
  if (!join || join.status === "failed" || join.status === "completed") {
    return { joinArtifactId: join?.id ?? null, notified: false };
  }
  const reason = meeting.failureReason ?? meeting.statusSubCode ?? "unknown";
  const failed = updateArtifact(
    join.id,
    {
      status: "failed",
      summary: `Meeting bot ended without a recording: ${reason}`,
      metadata: { error: reason, cloudStatus: "failed" },
      output: { error: reason },
    },
    { actor: options.actor, mergeMetadata: true },
  );
  appendArtifactEvent(failed.id, {
    eventType: "failed",
    status: "failed",
    message: `Meeting bot ended without a recording: ${reason}`,
    payload: { consoleMeetingId: meeting.id, reason },
    source: SOURCE,
    ...(options.actor ? { actor: options.actor } : {}),
  });
  let notified = false;
  if (options.notify !== false) {
    (deps.notify ?? notifyMeetingOwnerSession)(
      failed,
      "failed",
      [
        "[System] Inform: The meeting bot ended without a recording.",
        "",
        `Meeting: ${meeting.title ?? meeting.meetingCode ?? meeting.id}`,
        `Reason: ${reason}`,
        `Artifact: ${failed.id}`,
      ].join("\n"),
    );
    notified = true;
  }
  return { joinArtifactId: failed.id, notified };
}

function originFrom(join: ArtifactRecord | null): CloudMeetingOrigin | undefined {
  if (!join) return undefined;
  return {
    ...(join.sessionKey ? { originSessionKey: join.sessionKey } : {}),
    ...(join.sessionName ? { originSessionName: join.sessionName } : {}),
    ...(join.agentId ? { originAgentId: join.agentId } : {}),
    ...(join.channel ? { channel: join.channel } : {}),
    ...(join.accountId ? { accountId: join.accountId } : {}),
    ...(join.chatId ? { chatId: join.chatId } : {}),
    ...(join.threadId ? { threadId: join.threadId } : {}),
    ...(join.messageId ? { messageId: join.messageId } : {}),
  };
}
