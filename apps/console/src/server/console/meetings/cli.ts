import { projectAuthorizationFromCli, type VerifiedCliProjectContext } from "@/server/cli/project-authorization";
// CLI envelope for cloud meeting bots (`/api/cli/projects/<projectRef>/meetings/...`):
//
//   GET  meetings                      list the project's bots
//   POST meetings                      send a bot into a Google Meet call
//   GET  meetings/:id                  one bot's state
//   POST meetings/:id/leave            ask the bot to leave now
//   GET  meetings/:id/recording        transcript, participants, chat, media paths
//   GET  meetings/:id/media/:kind      the audio or video file, streamed (?part=N)
//
// The Console UI envelope only (never the CLI bearer, which has no Knowledge gate):
//   GET  meetings/settings             how long the project keeps transcripts
//   POST meetings/settings             change it (project admin)
//   GET  meetings/:id/stored-transcript the transcript Knowledge kept
//   POST meetings/:id/transcript/delete delete it for good (project admin)
//
// and `POST /api/cli/meetings/read` (`readMeetingFromCli`), which reads one
// meeting by link from any organization the person can see it in.

import type { CliAuthContext } from "@/server/cli/auth";
import { cliApiError } from "@/server/cli/errors";
import { parseConsoleRole } from "@/server/console/workspace";

import { repairMeetingKnowledgeAfterRead } from "@/server/console/knowledge/producers/meeting";

import {
  authorizeMeetingReadFromCli,
  listMeetingAccess,
  resolvedMeetingView,
  shareMeeting,
  unshareMeeting,
  type ExternalReadDeps,
} from "./sharing";
import {
  createMeetingBot,
  deleteStoredMeetingTranscript,
  getMeetingRecording,
  getMeetingRecordingForRow,
  getMeetingSettings,
  getStoredMeetingTranscript,
  updateMeetingSettings,
  leaveMeetingBot,
  listMeetingBots,
  openMeetingMedia,
  showMeetingBot,
  type MeetingsDeps,
  type MeetingsWorkspace,
} from "./service";

/** The scopes every CLI session already has, so no daemon needs a new `ravi login`. */
export const MEETINGS_CLI_READ_SCOPES = ["console.projects.read"] as const;
export const MEETINGS_CLI_WRITE_SCOPES = ["console.projects.link"] as const;

export type MeetingsCliRequest = {
  auth: Pick<CliAuthContext, "membership" | "organization" | "scopes" | "user"> & VerifiedCliProjectContext;
  requestId: string;
  method: string;
  projectRef: string;
  segments: readonly string[];
  body: unknown;
  searchParams: URLSearchParams;
};

export type MeetingsCliResult =
  | { status: number; payload: unknown; stream?: undefined }
  | { status: number; payload?: undefined; stream: { body: ReadableStream<Uint8Array>; headers: Record<string, string> } };

export async function handleMeetingsCliRequest(
  request: MeetingsCliRequest,
  deps: MeetingsDeps & { fetchImpl?: typeof fetch } = {},
): Promise<MeetingsCliResult> {
  const method = request.method.toUpperCase();
  const write = method !== "GET";
  const scopes = write ? MEETINGS_CLI_WRITE_SCOPES : MEETINGS_CLI_READ_SCOPES;
  for (const scope of scopes) {
    if (!request.auth.scopes.includes(scope)) {
      throw cliApiError(403, "PROJECT_ACCESS_DENIED", `This CLI session lacks the ${scope} scope. Log in again to grant it.`);
    }
  }
  const role = parseConsoleRole(request.auth.membership.role);
  if (!role) throw cliApiError(403, "PROJECT_ACCESS_DENIED");
  return routeMeetingsRequest(
    {
      workspace: {
      authorization: projectAuthorizationFromCli(request.auth),
        user: { id: request.auth.user.id },
        organization: { id: request.auth.organization.id },
        membership: { role },
      },
      envelope: "cli",
      localInstallationId: request.auth.localInstallation?.id ?? null,
      mediaBasePath: `/api/cli/projects/${encodeURIComponent(request.projectRef)}/meetings`,
      requestId: request.requestId,
      method,
      projectRef: request.projectRef,
      segments: request.segments,
      body: request.body,
      searchParams: request.searchParams,
    },
    deps,
  );
}

export type MeetingsRouteRequest = {
  workspace: MeetingsWorkspace;
  /** Which envelope asks: the stored-transcript, delete and settings routes answer only the Console's. */
  envelope: "console" | "cli";
  /** The CLI's installation, so the ready item reaches its daemon; null for bots sent from the Console UI. */
  localInstallationId: string | null;
  /** Where this envelope serves media, so `media[].path` points back at the same caller's route. */
  mediaBasePath: string;
  requestId: string;
  method: string;
  projectRef: string;
  segments: readonly string[];
  body: unknown;
  searchParams: URLSearchParams;
  /** The browser's `Range` header, passed to the media stream so players can seek. */
  range?: string | null;
};

/** The routes both envelopes share: the CLI's bearer one and the Console UI's session one. */
export async function routeMeetingsRequest(
  request: MeetingsRouteRequest,
  deps: MeetingsDeps & { fetchImpl?: typeof fetch } = {},
): Promise<MeetingsCliResult> {
  const method = request.method.toUpperCase();
  const { projectRef, requestId, workspace } = request;
  const [meetingId, action, ...rest] = request.segments;
  const fromConsole = request.envelope === "console";

  // Matched before the `:id` branches, which would read "settings" as a meeting id.
  if (fromConsole && meetingId === "settings" && !action) {
    if (method === "GET") return { status: 200, payload: await getMeetingSettings({ projectRef, workspace }, deps) };
    if (method === "POST") {
      return { status: 200, payload: await updateMeetingSettings({ projectRef, body: request.body, requestId, workspace }, deps) };
    }
  }
  if (fromConsole && meetingId && action === "stored-transcript" && rest.length === 0 && method === "GET") {
    return { status: 200, payload: await getStoredMeetingTranscript({ projectRef, meetingId, workspace }, deps) };
  }
  if (fromConsole && meetingId && action === "transcript" && rest.length === 1 && rest[0] === "delete" && method === "POST") {
    return { status: 200, payload: await deleteStoredMeetingTranscript({ projectRef, meetingId, requestId, workspace }, deps) };
  }

  if (meetingId && action === "media" && rest.length === 1 && method === "GET") {
    const part = Number(request.searchParams.get("part") ?? "0");
    const stream = await openMeetingMedia(
      {
        projectRef,
        meetingId,
        kind: rest[0] ?? "",
        part,
        workspace,
        range: request.range ?? null,
        disposition: request.searchParams.get("inline") === "1" ? "inline" : "attachment",
      },
      deps,
    );
    return { status: stream.status, stream };
  }

  if (rest.length === 0) {
    if (!meetingId && method === "GET") {
      const limit = Number(request.searchParams.get("limit") ?? "");
      return { status: 200, payload: await listMeetingBots({ projectRef, workspace, limit: limit || undefined }, deps) };
    }
    if (!meetingId && method === "POST") {
      const payload = await createMeetingBot(
        { body: request.body, localInstallationId: request.localInstallationId, projectRef, requestId, workspace },
        deps,
      );
      return { status: 201, payload };
    }
    if (meetingId && !action && method === "GET") {
      return { status: 200, payload: await showMeetingBot({ projectRef, meetingId, workspace }, deps) };
    }
    if (meetingId && action === "leave" && method === "POST") {
      return { status: 200, payload: await leaveMeetingBot({ projectRef, meetingId, requestId, workspace }, deps) };
    }
    if (meetingId && action === "recording" && method === "GET") {
      const payload = await getMeetingRecording({ projectRef, meetingId, workspace, mediaBasePath: request.mediaBasePath }, deps);
      // `ravi meetings fetch` runs this: a transcript the webhook missed is captured now. Never fails the read.
      await (deps.knowledge?.repairAfterRead ?? repairMeetingKnowledgeAfterRead)({
        organizationId: workspace.organization.id,
        projectId: payload.meeting.projectId,
        meetingId: payload.meeting.id,
        title: payload.meeting.title,
        requestId,
      }).catch(() => undefined);
      return { status: 200, payload };
    }
  }
  throw cliApiError(404, "NOT_FOUND", "Unknown meetings route.");
}

export type MeetingReadCliRequest = {
  auth: Pick<CliAuthContext, "organization" | "scopes" | "user"> & { localInstallation: { id: string } | null };
  body: unknown;
  requestId: string;
};

/**
 * `POST /api/cli/meetings/read`: one meeting's transcript, participants and
 * chat by Console link or id, from the CLI session's own organization or from
 * another one the person can see the meeting in. No media paths: the text is
 * for the agent to read now, not a download.
 */
export async function readMeetingFromCli(request: MeetingReadCliRequest, deps: MeetingsDeps & ExternalReadDeps = {}) {
  for (const scope of MEETINGS_CLI_READ_SCOPES) {
    if (!request.auth.scopes.includes(scope)) {
      throw cliApiError(403, "PROJECT_ACCESS_DENIED", `This CLI session lacks the ${scope} scope. Log in again to grant it.`);
    }
  }
  const resolved = await authorizeMeetingReadFromCli(
    {
      body: request.body,
      requestId: request.requestId,
      session: {
        organizationId: request.auth.organization.id,
        userId: request.auth.user.id,
        localInstallationId: request.auth.localInstallation?.id ?? null,
      },
    },
    deps,
  );
  const { meeting: _meeting, media: _media, ...recording } = await getMeetingRecordingForRow(resolved.row, "", deps);
  return {
    ...resolvedMeetingView(resolved, { crossOrganization: resolved.crossOrganization }),
    crossOrganization: resolved.crossOrganization,
    ...recording,
  };
}

/**
 * `meetings/<id>/access` in the Console UI's envelope only: who was given the
 * meeting (`GET`), give it to one more person by email (`POST .../share`),
 * take it away (`POST .../unshare`). `null` for every other route.
 */
export async function routeMeetingSharingRequest(request: {
  workspace: MeetingsWorkspace;
  requestId: string;
  method: string;
  projectRef: string;
  segments: readonly string[];
  body: unknown;
  origin: string;
}): Promise<{ status: number; payload: unknown } | null> {
  const [meetingId, area, action, ...rest] = request.segments;
  if (!meetingId || area !== "access" || rest.length > 0) return null;
  const method = request.method.toUpperCase();
  const { projectRef, requestId, workspace } = request;
  const withUrl = <T extends { path: string }>(grant: T) => ({ ...grant, url: new URL(grant.path, request.origin).toString() });

  if (!action && method === "GET") {
    const { grants } = await listMeetingAccess({ meetingId, projectRef, workspace });
    return { status: 200, payload: { grants: grants.map(withUrl) } };
  }
  if (action === "share" && method === "POST") {
    const result = await shareMeeting({ body: request.body, meetingId, projectRef, requestId, workspace });
    return { status: result.created ? 201 : 200, payload: { ...result, grant: withUrl(result.grant) } };
  }
  if (action === "unshare" && method === "POST") {
    return { status: 200, payload: await unshareMeeting({ body: request.body, meetingId, projectRef, requestId, workspace }) };
  }
  throw cliApiError(404, "NOT_FOUND", "Unknown meetings route.");
}
