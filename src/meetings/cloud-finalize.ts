// Turns a finished cloud meeting into local artifacts: downloads the media,
// registers the `meeting.raw` artifact, closes the `meeting.join` artifact
// that `ravi meetings join` created, and hands the result to the session that
// asked for it. Safe to run twice, or twice at once: a lock and a record in
// the meeting's state folder make one run the owner, and later runs reuse its
// artifact (adding the video when a later run asks for it).

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

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
import {
  buildMeetingRawArtifactHandoffMessage,
  registerMeetingRawArtifact,
  rewriteMeetingRawArtifact,
} from "./raw-artifact.js";

const SOURCE = "ravi.meetings.cloud";
const RECORD_FILE = "fetch.json";
const LOCK_FILE = "fetch.lock";
/** A lock older than this belongs to a run that died; the next run takes over. */
const LOCK_STALE_MS = 30 * 60_000;

export interface CloudMeetingFinalizeResult {
  /** `in_progress`: another run holds this meeting; `enriched`: an existing artifact gained its video. */
  status: "finalized" | "already_finalized" | "enriched" | "in_progress";
  meetingId: string;
  joinArtifactId: string | null;
  rawArtifactId: string | null;
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

export type CloudMeetingFetchResult =
  | ({ outcome: "finalized" } & CloudMeetingFinalizeResult)
  | { outcome: "failed"; meeting: CloudMeeting; joinArtifactId: string | null; notified: boolean }
  | { outcome: "pending"; meeting: CloudMeeting };

/**
 * What `ravi meetings fetch` and the inbox handoff do: finalize a finished
 * recording, close the join artifact of a bot that failed, or report that the
 * bot is still working.
 */
export async function fetchCloudMeeting(
  input: {
    client: MeetingsCloudClient;
    meetingId: string;
    outputDir?: string;
    video?: boolean;
    actor?: string;
    notify?: boolean;
  },
  deps: CloudMeetingFinalizeDeps = {},
): Promise<CloudMeetingFetchResult> {
  const meeting = await input.client.show(input.meetingId);
  if (meeting.status === "failed") {
    return { outcome: "failed", meeting, ...failCloudMeetingJoin(meeting, input, deps) };
  }
  if (meeting.status !== "done") return { outcome: "pending", meeting };
  return { outcome: "finalized", ...(await finalizeCloudMeeting(input, deps)) };
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
  const claimDir = defaultCloudMeetingDir(meeting.id);
  const unchanged = (status: "already_finalized" | "in_progress", raw: ArtifactRecord | null) => ({
    status,
    meetingId: meeting.id,
    joinArtifactId: join?.id ?? null,
    rawArtifactId: raw?.id ?? null,
    rawArtifactPath: raw?.filePath ?? null,
    transcriptSegmentCount: 0,
    mediaRefCount: 0,
    downloadedMediaCount: 0,
    notified: false,
  });
  if (!acquireFetchLock(claimDir)) return unchanged("in_progress", null);

  try {
    const record = readFetchRecord(claimDir);
    const joinRawId = typeof join?.metadata?.finalArtifactId === "string" ? join.metadata.finalArtifactId : null;
    const existingRaw = getArtifactOrNull(record?.rawArtifactId ?? joinRawId);
    if (existingRaw) {
      if (!input.video || (record?.video ?? hasDownloadedVideo(existingRaw))) {
        // A run that died after recording its artifact may have left the join open.
        const notified = await reconcileJoin({ input, deps, meeting, join, raw: existingRaw });
        return { ...unchanged("already_finalized", existingRaw), notified };
      }
      // Asked for the video this time: add it to the same artifact.
      const outputDir =
        record?.outputDir ??
        (typeof join?.metadata?.finalArtifactPath === "string" ? dirname(join.metadata.finalArtifactPath) : null) ??
        input.outputDir ??
        defaultCloudMeetingDir(meeting.id);
      const recording = await input.client.recording(meeting.id);
      const mediaRefs = await downloadMedia(input, recording, outputDir, deps, true);
      const session = buildCloudMeetingSession({ recording, origin: originFrom(join), mediaRefs });
      const written = rewriteMeetingRawArtifact({
        artifactId: existingRaw.id,
        session,
        outputDir,
        actor: input.actor ?? SOURCE,
      });
      writeFetchRecord(claimDir, { rawArtifactId: existingRaw.id, outputDir, video: downloadedVideo(mediaRefs) });
      const notified = await reconcileJoin({
        input,
        deps,
        meeting,
        join,
        raw: { ...existingRaw, filePath: written.filePath },
        recording,
      });
      return {
        status: "enriched",
        meetingId: meeting.id,
        joinArtifactId: join?.id ?? null,
        rawArtifactId: existingRaw.id,
        rawArtifactPath: written.filePath,
        transcriptSegmentCount: session.transcriptSegments?.length ?? 0,
        mediaRefCount: mediaRefs.length,
        downloadedMediaCount: mediaRefs.filter((ref) => Boolean(ref.path)).length,
        notified,
      };
    }

    const recording = await input.client.recording(meeting.id);
    const outputDir = input.outputDir ?? defaultCloudMeetingDir(meeting.id);
    const mediaRefs = await downloadMedia(input, recording, outputDir, deps, input.video);
    const session = buildCloudMeetingSession({ recording, origin: originFrom(join), mediaRefs });
    const registered = registerMeetingRawArtifact({ session, outputDir, actor: input.actor ?? SOURCE });
    // Recorded before anyone is told, so a later run never registers or notifies again.
    writeFetchRecord(claimDir, {
      rawArtifactId: registered.artifact.id,
      outputDir,
      video: downloadedVideo(mediaRefs),
    });

    const notified = join
      ? completeJoin({
          input,
          deps,
          meeting,
          join,
          raw: { id: registered.artifact.id, filePath: registered.filePath },
          durationMs: session.durationMs,
          handoffMessage: registered.handoffMessage,
        })
      : false;

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
  } finally {
    releaseFetchLock(claimDir);
  }
}

type FinalizeInput = { actor?: string; notify?: boolean; client: MeetingsCloudClient };

/** Closes the `meeting.join` artifact with its raw artifact and tells the owner session. */
function completeJoin(args: {
  input: FinalizeInput;
  deps: CloudMeetingFinalizeDeps;
  meeting: CloudMeeting;
  join: ArtifactRecord;
  raw: { id: string; filePath: string };
  durationMs?: number;
  handoffMessage: string;
}): boolean {
  const { input, meeting, join, raw } = args;
  attachArtifact(raw.id, "artifact", join.id, "generated-by", { source: SOURCE });
  const completed = updateArtifact(
    join.id,
    {
      status: "completed",
      summary: `Meeting ended; raw artifact generated: ${raw.id}`,
      ...(args.durationMs !== undefined ? { durationMs: args.durationMs } : {}),
      metadata: {
        finalArtifactId: raw.id,
        finalArtifactPath: raw.filePath,
        cloudStatus: meeting.status,
        recordingSeconds: meeting.recordingSeconds,
      },
      output: { finalArtifactId: raw.id, finalArtifactPath: raw.filePath },
    },
    { actor: input.actor, mergeMetadata: true },
  );
  appendArtifactEvent(completed.id, {
    eventType: "completed",
    status: "completed",
    message: `Meeting raw artifact generated: ${raw.id}`,
    payload: { finalArtifactId: raw.id, consoleMeetingId: meeting.id },
    source: SOURCE,
    ...(input.actor ? { actor: input.actor } : {}),
  });
  if (input.notify === false) return false;
  (args.deps.notify ?? notifyMeetingOwnerSession)(completed, "completed", args.handoffMessage);
  return true;
}

/** Completes a join a previous run left open after it recorded its raw artifact; a completed join is left alone. */
async function reconcileJoin(args: {
  input: FinalizeInput;
  deps: CloudMeetingFinalizeDeps;
  meeting: CloudMeeting;
  join: ArtifactRecord | null;
  raw: ArtifactRecord;
  recording?: Awaited<ReturnType<MeetingsCloudClient["recording"]>>;
}): Promise<boolean> {
  const { join, raw } = args;
  if (!join || join.status === "completed" || !raw.filePath) return false;
  const recording = args.recording ?? (await args.input.client.recording(args.meeting.id));
  const session = buildCloudMeetingSession({ recording, origin: originFrom(join) });
  const transcriptionJsonPath = raw.metadata?.transcriptionJsonPath;
  return completeJoin({
    input: args.input,
    deps: args.deps,
    meeting: args.meeting,
    join,
    raw: { id: raw.id, filePath: raw.filePath },
    durationMs: session.durationMs,
    handoffMessage: buildMeetingRawArtifactHandoffMessage({
      session: { ...session, artifactId: raw.id },
      artifact: raw,
      filePath: raw.filePath,
      ...(typeof transcriptionJsonPath === "string" ? { transcriptionJsonPath } : {}),
    }),
  });
}

function downloadMedia(
  input: { client: MeetingsCloudClient },
  recording: Awaited<ReturnType<MeetingsCloudClient["recording"]>>,
  outputDir: string,
  deps: CloudMeetingFinalizeDeps,
  video: boolean | undefined,
) {
  return downloadCloudMeetingMedia({
    recording,
    outputDir,
    consoleUrl: input.client.consoleUrl,
    download: (path, destination) => input.client.downloadMedia(path, destination, deps.fetchImpl),
    video,
  });
}

interface CloudFetchRecord {
  rawArtifactId: string;
  outputDir: string;
  video: boolean;
}

function readFetchRecord(dir: string): CloudFetchRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, RECORD_FILE), "utf8")) as Partial<CloudFetchRecord>;
    if (typeof parsed.rawArtifactId !== "string" || typeof parsed.outputDir !== "string") return null;
    return { rawArtifactId: parsed.rawArtifactId, outputDir: parsed.outputDir, video: parsed.video === true };
  } catch {
    return null;
  }
}

function writeFetchRecord(dir: string, record: CloudFetchRecord) {
  const path = join(dir, RECORD_FILE);
  writeFileSync(`${path}.tmp`, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(`${path}.tmp`, path);
}

/** Exclusive create: one run per meeting at a time, across processes. */
function acquireFetchLock(dir: string): boolean {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, LOCK_FILE);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      closeSync(openSync(path, "wx"));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (attempt > 0 || !existsSync(path) || Date.now() - statSync(path).mtimeMs < LOCK_STALE_MS) return false;
      rmSync(path, { force: true });
    }
  }
  return false;
}

function releaseFetchLock(dir: string) {
  rmSync(join(dir, LOCK_FILE), { force: true });
}

function getArtifactOrNull(id: string | null | undefined) {
  return id ? getArtifact(id) : null;
}

function downloadedVideo(refs: Array<{ kind: string; path?: string }>) {
  return refs.some((ref) => ref.kind === "video" && Boolean(ref.path));
}

function hasDownloadedVideo(raw: ArtifactRecord) {
  const refs = raw.metadata?.mediaRefs;
  return Array.isArray(refs) && downloadedVideo(refs as Array<{ kind: string; path?: string }>);
}

/**
 * The bot ended without a recording (nobody admitted it, it was removed, the
 * cloud bot failed). Closes the join artifact as failed and says why.
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
