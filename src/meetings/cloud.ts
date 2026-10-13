// Cloud meeting bots: the Console sends a Ravi bot into a Google Meet call and
// tells this installation, through the agent inbox, when the recording is
// ready. Transport only: the Console owns the bot runtime, the limits and the
// billing. This module turns the Console's recording into the same
// `meeting.raw` artifact the local recorder produces.
//
//   GET  /api/cli/projects/:projectRef/meetings
//   POST /api/cli/projects/:projectRef/meetings
//   GET  /api/cli/projects/:projectRef/meetings/:id
//   POST /api/cli/projects/:projectRef/meetings/:id/leave
//   GET  /api/cli/projects/:projectRef/meetings/:id/recording
//   GET  /api/cli/projects/:projectRef/meetings/:id/media/:kind?part=N

import { existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";

import { ConsoleApiClient, normalizeConsoleUrl, refreshCredentialsForStore } from "../cloud-auth/client.js";
import { CloudAuthError, classifyConsoleNetworkError, isCloudAuthError } from "../cloud-auth/errors.js";
import { deleteCloudCredentials, readCloudCredentials, writeCloudCredentials } from "../cloud-auth/storage.js";
import type { CloudCredentials } from "../cloud-auth/types.js";
import { resolveConsoleProjectRef, type ConsoleScopeResolverDeps } from "../console-scope/resolver.js";
import { inspectExecutionPlane } from "../isolation/execution-plane.js";
import { getRaviStateDir } from "../utils/paths.js";
import { GOOGLE_MEET_PROVIDER_ID, MEETING_CHANNEL_ID } from "../channels/meetings/types.js";
import type { MeetingMediaRef, MeetingSession } from "./types.js";

/** Org-level Console feature that must be on to send a cloud bot. */
export const MEETINGS_CLOUD_FEATURE = "console.meetings";
export const MEETING_CLOUD_PROVIDER_RUNTIME = "ravi-console";
export const MEETINGS_INBOX_CATEGORY = "meetings";
export const MEETING_RECORDING_READY_EVENT = "meetings.recording.ready";
export const MEETING_RECORDING_FAILED_EVENT = "meetings.recording.failed";

export type CloudMeetingStatus =
  | "requested"
  | "joining"
  | "waiting_room"
  | "in_call"
  | "recording"
  | "ended"
  | "done"
  | "failed";

export interface CloudMeeting {
  id: string;
  projectId: string | null;
  platform: string;
  meetingUrl: string;
  meetingCode: string | null;
  botName: string;
  title: string | null;
  language: string;
  clientRef: string | null;
  status: CloudMeetingStatus | string;
  statusSubCode: string | null;
  transcriptStatus: string;
  ready: boolean;
  joinAt: string | null;
  recordingStartedAt: string | null;
  endedAt: string | null;
  doneAt: string | null;
  recordingSeconds: number | null;
  maxRecordingSeconds: number;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CloudMeetingLimits {
  maxConcurrentBots: number;
  maxRecordingSeconds: number;
  monthlyBudgetUsd: number;
}

export interface CloudMeetingSegment {
  speaker: string | null;
  speakerId: string | null;
  isHost: boolean | null;
  startSeconds: number | null;
  endSeconds: number | null;
  startedAt: string | null;
  text: string;
}

export interface CloudMeetingRecording {
  meeting: CloudMeeting;
  transcript: { status: string; segments: CloudMeetingSegment[] };
  participants: Array<{ id: string; name: string | null; isHost: boolean | null }>;
  chat: Array<{
    sender: string | null;
    senderId: string | null;
    atSeconds: number | null;
    sentAt: string | null;
    to: string | null;
    text: string;
  }>;
  /** `path` is a Console path, downloaded with the same CLI credentials. */
  media: Array<{
    kind: "video" | "audio" | string;
    format: string;
    path: string;
    part: number;
    expiresAt: string | null;
  }>;
  recordings: Array<{ startedAt: string | null; completedAt: string | null; expiresAt: string | null }>;
}

export interface CloudMeetingCreateBody {
  meetingUrl: string;
  botName?: string;
  title?: string;
  language?: string;
  joinAt?: string;
  clientRef?: string;
  maxMinutes?: number;
}

export interface MeetingsCloudClientOptions {
  console?: string;
  project?: string;
}

export interface MeetingsCloudClientDeps extends ConsoleScopeResolverDeps {
  client?: ConsoleApiClient;
  readCredentials?: typeof readCloudCredentials;
  writeCredentials?: typeof writeCloudCredentials;
  deleteCredentials?: typeof deleteCloudCredentials;
}

export function meetingsApiRoot(projectRef: string): string {
  return `/api/cli/projects/${encodeURIComponent(projectRef)}/meetings`;
}

const GOOGLE_MEET_CODE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;

/** Local check before any network call; the Console validates again. */
export function normalizeGoogleMeetUrl(input: string): string | null {
  const trimmed = input.trim();
  if (GOOGLE_MEET_CODE.test(trimmed.toLowerCase())) return `https://meet.google.com/${trimmed.toLowerCase()}`;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if (url.hostname.toLowerCase() !== "meet.google.com" || url.username || url.password || url.port) return null;
  const code = url.pathname.replace(/^\/+|\/+$/g, "").toLowerCase();
  return GOOGLE_MEET_CODE.test(code) ? `https://meet.google.com/${code}` : null;
}

/** A Console client bound to one project, refreshing the access token once when it expires. */
export class MeetingsCloudClient {
  private credentials: CloudCredentials;

  constructor(
    private readonly session: {
      client: ConsoleApiClient;
      credentials: CloudCredentials;
      projectRef: string;
      write: typeof writeCloudCredentials;
      delete: typeof deleteCloudCredentials;
    },
  ) {
    this.credentials = session.credentials;
  }

  get projectRef(): string {
    return this.session.projectRef;
  }

  get consoleUrl(): string {
    return this.credentials.consoleUrl;
  }

  async create(body: CloudMeetingCreateBody): Promise<{ meeting: CloudMeeting; limits: CloudMeetingLimits | null }> {
    const payload = await this.request<{ meeting?: CloudMeeting; limits?: CloudMeetingLimits }>("POST", "", body);
    return { meeting: requireMeeting(payload?.meeting), limits: payload?.limits ?? null };
  }

  async list(limit?: number): Promise<CloudMeeting[]> {
    const query = limit ? `?limit=${encodeURIComponent(String(limit))}` : "";
    const payload = await this.request<{ meetings?: CloudMeeting[] }>("GET", query);
    return Array.isArray(payload?.meetings) ? payload.meetings.map(requireMeeting) : [];
  }

  async show(meetingId: string): Promise<CloudMeeting> {
    const payload = await this.request<{ meeting?: CloudMeeting }>("GET", `/${encodeURIComponent(meetingId)}`);
    return requireMeeting(payload?.meeting);
  }

  async leave(meetingId: string): Promise<{ meeting: CloudMeeting; left: boolean }> {
    const payload = await this.request<{ meeting?: CloudMeeting; left?: boolean }>(
      "POST",
      `/${encodeURIComponent(meetingId)}/leave`,
      {},
    );
    return { meeting: requireMeeting(payload?.meeting), left: payload?.left === true };
  }

  async recording(meetingId: string): Promise<CloudMeetingRecording> {
    const payload = await this.request<CloudMeetingRecording>("GET", `/${encodeURIComponent(meetingId)}/recording`);
    if (!payload || typeof payload !== "object" || !payload.transcript || !Array.isArray(payload.media)) {
      throw new CloudAuthError("SERVER_UNAVAILABLE", "The Console returned an unexpected meeting recording.");
    }
    return { ...payload, meeting: requireMeeting(payload.meeting) };
  }

  /** Streams one media file from a Console path into `destination`. */
  async downloadMedia(path: string, destination: string, fetchImpl: typeof fetch = fetch): Promise<void> {
    if (!path.startsWith(`${meetingsApiRoot(this.session.projectRef)}/`)) {
      throw new CloudAuthError("SERVER_UNAVAILABLE", "The Console returned a media path outside this project.");
    }
    // One signal for the whole download, body included: a stalled stream must
    // not keep a detached fetch alive forever.
    const signal = AbortSignal.timeout(MEDIA_DOWNLOAD_TIMEOUT_MS);
    const get = (token: string) =>
      fetchImpl(`${this.consoleUrl}${path}`, { headers: { Authorization: `Bearer ${token}` }, signal });
    let response: Response;
    try {
      response = await get(this.credentials.accessToken);
      if (response.status === 401) {
        this.credentials = await refreshCredentialsForStore({
          client: this.session.client,
          credentials: this.credentials,
          write: this.session.write,
          delete: this.session.delete,
        });
        response = await get(this.credentials.accessToken);
      }
    } catch (error) {
      if (error instanceof CloudAuthError) throw error;
      throw classifyConsoleNetworkError(error, inspectExecutionPlane());
    }
    if (!response.ok || !response.body) {
      throw new CloudAuthError("SERVER_UNAVAILABLE", `Meeting media download failed (${response.status}).`);
    }
    const partial = `${destination}.part`;
    // Read the body directly: under Bun, piping an errored web stream through
    // Readable.fromWeb never settles, so a reset or a timeout would hang here.
    const file = await open(partial, "w");
    try {
      try {
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) await file.write(chunk);
      } finally {
        await file.close();
      }
    } catch (error) {
      rmSync(partial, { force: true });
      throw error;
    }
    renameSync(partial, destination);
  }

  private async request<T>(method: string, relativePath: string, body?: unknown): Promise<T> {
    const path = `${meetingsApiRoot(this.session.projectRef)}${relativePath}`;
    try {
      try {
        return await this.session.client.requestJson<T>(method, path, body, this.credentials.accessToken);
      } catch (error) {
        if (!isCloudAuthError(error) || error.code !== "AUTH_EXPIRED") throw error;
      }
      this.credentials = await refreshCredentialsForStore({
        client: this.session.client,
        credentials: this.credentials,
        write: this.session.write,
        delete: this.session.delete,
      });
      return await this.session.client.requestJson<T>(method, path, body, this.credentials.accessToken);
    } catch (error) {
      if (error instanceof CloudAuthError) throw error;
      throw classifyConsoleNetworkError(error, inspectExecutionPlane());
    }
  }
}

/** Read stored credentials, resolve the Console project, and bind a client to it. */
export async function openMeetingsCloudClient(
  options: MeetingsCloudClientOptions = {},
  deps: MeetingsCloudClientDeps = {},
): Promise<MeetingsCloudClient> {
  const readCredentials = deps.readCredentials ?? readCloudCredentials;
  const credentials = readCredentials();
  if (!credentials) {
    throw new CloudAuthError("AUTH_REQUIRED", "No Ravi Cloud CLI credentials found. Run `ravi login`.");
  }
  if (options.console && normalizeConsoleUrl(options.console) !== credentials.consoleUrl) {
    const normalized = normalizeConsoleUrl(options.console);
    throw new CloudAuthError(
      "AUTH_REQUIRED",
      `No Ravi Cloud CLI credentials found for ${normalized}. Run \`ravi login --console ${normalized}\`.`,
    );
  }
  const { projectRef } = await resolveConsoleProjectRef(
    { consoleUrl: options.console, explicitProject: options.project ?? null },
    { ...deps, readCredentials },
  );
  return new MeetingsCloudClient({
    client: deps.client ?? new ConsoleApiClient({ consoleUrl: credentials.consoleUrl }),
    credentials,
    projectRef,
    write: deps.writeCredentials ?? writeCloudCredentials,
    delete: deps.deleteCredentials ?? deleteCloudCredentials,
  });
}

function requireMeeting(value: unknown): CloudMeeting {
  if (!value || typeof value !== "object" || typeof (value as { id?: unknown }).id !== "string") {
    throw new CloudAuthError("SERVER_UNAVAILABLE", "The Console returned a meeting without an id.");
  }
  return value as CloudMeeting;
}

/** Above the Console's own 800-second cap on a media response. */
const MEDIA_DOWNLOAD_TIMEOUT_MS = 15 * 60_000;

export function defaultCloudMeetingDir(meetingId: string): string {
  return join(getRaviStateDir(), "meetings", "cloud", meetingId);
}

export interface CloudMeetingOrigin {
  originSessionKey?: string;
  originSessionName?: string;
  originAgentId?: string;
  channel?: string;
  accountId?: string;
  chatId?: string;
  threadId?: string;
  messageId?: string;
}

/**
 * The Console recording as a `MeetingSession`: transcript segments with
 * speakers and offsets, participants, chat, and the media this installation
 * downloaded (or its Console link, with its expiry, when it did not).
 */
export function buildCloudMeetingSession(input: {
  recording: CloudMeetingRecording;
  origin?: CloudMeetingOrigin;
  mediaRefs?: MeetingMediaRef[];
}): MeetingSession {
  const { recording } = input;
  const { meeting } = recording;
  const startedAt =
    recording.recordings
      .map((entry) => entry.startedAt)
      .filter((value): value is string => Boolean(value))
      .sort()[0] ??
    meeting.recordingStartedAt ??
    undefined;
  const endedAt = meeting.endedAt ?? meeting.doneAt ?? undefined;
  const durationMs =
    typeof meeting.recordingSeconds === "number" ? Math.round(meeting.recordingSeconds * 1000) : undefined;
  const startMs = startedAt ? Date.parse(startedAt) : Number.NaN;

  return {
    id: `cloud-${meeting.id}`,
    provider: GOOGLE_MEET_PROVIDER_ID,
    providerMeetingId: meeting.meetingCode ?? undefined,
    title: meeting.title ?? (meeting.meetingCode ? `Google Meet ${meeting.meetingCode}` : undefined),
    url: meeting.meetingUrl,
    ...input.origin,
    meetingChannel: MEETING_CHANNEL_ID,
    startedAt,
    endedAt,
    durationMs,
    participants: recording.participants.map((participant) => ({
      id: participant.id,
      providerParticipantId: participant.id,
      displayName: participant.name ?? `Participant ${participant.id}`,
      kind: "unknown",
      ...(participant.isHost ? { role: "host" } : {}),
    })),
    transcriptSegments: recording.transcript.segments.map((segment, index) => ({
      id: `seg-${index + 1}`,
      ...(segment.speakerId ? { speakerId: segment.speakerId } : {}),
      ...(segment.speaker ? { speakerName: segment.speaker } : {}),
      ...(segment.startSeconds !== null ? { startOffsetMs: Math.round(segment.startSeconds * 1000) } : {}),
      ...(segment.endSeconds !== null ? { endOffsetMs: Math.round(segment.endSeconds * 1000) } : {}),
      ...offsetTimestamps(segment, startMs),
      text: segment.text,
      source: "provider",
    })),
    textMessages: recording.chat.map((message, index) => ({
      id: `chat-${index + 1}`,
      ...(message.senderId ? { senderId: message.senderId } : {}),
      ...(message.sender ? { senderName: message.sender } : {}),
      direction: "inbound",
      ...(message.sentAt ? { sentAt: message.sentAt } : {}),
      text: message.text,
      source: "meeting-chat",
    })),
    mediaRefs: input.mediaRefs ?? [],
    diagnostics: [
      {
        level: recording.transcript.status === "done" ? "info" : "warning",
        code: "cloud_transcript_status",
        message: `Cloud transcript status: ${recording.transcript.status}.`,
      },
    ],
    rawProvenance: {
      providerRuntime: MEETING_CLOUD_PROVIDER_RUNTIME,
      consoleMeetingId: meeting.id,
      consoleProjectId: meeting.projectId,
      botName: meeting.botName,
      language: meeting.language,
      statusSubCode: meeting.statusSubCode,
      transcriptStatus: recording.transcript.status,
    },
  };
}

function offsetTimestamps(segment: CloudMeetingSegment, recordingStartMs: number) {
  if (segment.startedAt) return { startAt: segment.startedAt };
  if (Number.isNaN(recordingStartMs) || segment.startSeconds === null) return {};
  return {
    startAt: new Date(recordingStartMs + segment.startSeconds * 1000).toISOString(),
    ...(segment.endSeconds !== null
      ? { endAt: new Date(recordingStartMs + segment.endSeconds * 1000).toISOString() }
      : {}),
  };
}

const MEDIA_MIME: Record<string, string> = { mp3: "audio/mpeg", mp4: "video/mp4" };

/**
 * Downloads the recording's media next to the artifact. Audio always; video
 * only when asked, because it is large. A failed or skipped download keeps the
 * Console link with its expiry, so nothing is silently dropped.
 */
export async function downloadCloudMeetingMedia(input: {
  recording: CloudMeetingRecording;
  outputDir: string;
  consoleUrl: string;
  download: (path: string, destination: string) => Promise<void>;
  video?: boolean;
}): Promise<MeetingMediaRef[]> {
  mkdirSync(input.outputDir, { recursive: true });
  const refs: MeetingMediaRef[] = [];
  for (const media of input.recording.media) {
    const kind = media.kind === "video" ? "video" : "audio";
    const format = media.format || (kind === "video" ? "mp4" : "mp3");
    const mimeType = MEDIA_MIME[format] ?? (kind === "video" ? "video/mp4" : "audio/mpeg");
    const linkRef: MeetingMediaRef = {
      kind,
      uri: `${input.consoleUrl}${media.path}`,
      mimeType,
      source: MEETING_CLOUD_PROVIDER_RUNTIME,
      rawProvenance: { expiresAt: media.expiresAt, downloaded: false },
    };
    if (kind === "video" && !input.video) {
      refs.push(linkRef);
      continue;
    }
    const suffix = media.part > 0 ? `-${media.part + 1}` : "";
    const path = join(input.outputDir, `${kind}${suffix}.${format}`);
    try {
      if (!existsSync(path)) await input.download(media.path, path);
      refs.push({
        kind,
        path,
        mimeType,
        sizeBytes: statSync(path).size,
        source: MEETING_CLOUD_PROVIDER_RUNTIME,
        rawProvenance: { downloaded: true },
      });
    } catch (error) {
      refs.push({
        ...linkRef,
        rawProvenance: {
          expiresAt: media.expiresAt,
          downloaded: false,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }
  return refs;
}
