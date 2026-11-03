// Cloud meeting bots for the OSS CLI: `ravi meetings join` asks the Console to
// send a bot into a Google Meet call; the daemon fetches the recording once the
// inbox says it is ready.

import { z } from "zod";

import { cliApiError } from "@/server/cli/errors";
import { getConsoleFeatureAccessForOrganizationRole } from "@/server/console/feature-access";
import {
  dbMeetingKnowledgeStore,
  MEETING_RETENTION_MAX_MONTHS,
  MEETING_RETENTION_MIN_MONTHS,
  type MeetingKnowledgeStore,
} from "@/server/console/knowledge/producers/meeting";
import { findAccessibleProjectRecord, type ProjectAccessAction } from "@/server/console/project-access";

import {
  estimateMeetingCostUsd,
  evaluateMeetingAllowance,
  MEETINGS_FEATURE_KEY,
  parseMeetingLimits,
  type MeetingLimits,
} from "./limits";
import { parseGoogleMeetUrl } from "./meet-url";
import {
  createRecallClient,
  getRecallConfigFromEnv,
  RECALL_PROVIDER,
  RecallApiError,
  type RecallBot,
  type RecallClient,
  type RecallRecording,
} from "./recall";
import { dbMeetingBotStore, OPEN_MEETING_BOT_STATUSES, type MeetingBotRow, type MeetingBotStore } from "./store";
import {
  normalizeRecallChatMessages,
  normalizeRecallParticipants,
  normalizeRecallTranscript,
  type MeetingChatMessage,
  type MeetingParticipant,
  type MeetingTranscriptSegment,
} from "./transcript";

export type MeetingsWorkspace = {
  authorization?: import("../authorization/identity").AuthorizationActor["delegation"];
  user: { id: string };
  organization: { id: string };
  membership: { role: string };
};

export type MeetingsDeps = {
  store?: MeetingBotStore;
  /** null: the vendor is not configured on this Console. */
  recall?: RecallClient | null;
  featureEnabled?: (input: { organizationId: string; role: string }) => Promise<boolean>;
  resolveProject?: (
    workspace: MeetingsWorkspace,
    projectRef: string,
    action: ProjectAccessAction,
  ) => Promise<{ id: string } | null>;
  now?: () => Date;
  /** Stored transcripts, retention and capture repair (Knowledge). */
  knowledge?: MeetingKnowledgeStore;
};

export const MEETING_BOT_NAME_DEFAULT = "Ravi";
export const MEETING_LANGUAGE_DEFAULT = "pt";
const OPEN_BOT_WINDOW_MS = 24 * 3600 * 1000;
const SCHEDULE_HORIZON_MS = 30 * 24 * 3600 * 1000;

const createBodySchema = z
  .object({
    meetingUrl: z.string().min(1).max(2048),
    botName: z.string().trim().min(1).max(100).optional(),
    title: z.string().trim().min(1).max(200).optional(),
    language: z
      .string()
      .trim()
      .regex(/^(auto|[a-z]{2,3}(-[A-Za-z]{2})?)$/)
      .optional(),
    joinAt: z.string().datetime({ offset: true }).optional(),
    clientRef: z.string().trim().min(1).max(200).optional(),
    announce: z.boolean().optional(),
    maxMinutes: z.number().int().min(5).max(480).optional(),
  })
  .strict();

export type MeetingBotView = ReturnType<typeof serializeMeetingBot>;

export function serializeMeetingBot(row: MeetingBotRow) {
  return {
    id: row.id,
    projectId: row.projectId,
    platform: row.platform,
    meetingUrl: row.meetingUrl,
    meetingCode: row.meetingCode,
    botName: row.botName,
    title: row.title,
    language: row.language,
    clientRef: row.clientRef,
    status: row.status,
    statusSubCode: row.statusSubCode,
    transcriptStatus: row.transcriptStatus,
    ready: row.status === "done" && row.readyNotifiedAt !== null,
    joinAt: iso(row.joinAt),
    recordingStartedAt: iso(row.recordingStartedAt),
    endedAt: iso(row.endedAt),
    doneAt: iso(row.doneAt),
    recordingSeconds: row.recordingSeconds,
    maxRecordingSeconds: row.maxRecordingSeconds,
    failureReason: row.failureReason,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function createMeetingBot(
  input: {
    body: unknown;
    localInstallationId: string | null;
    projectRef: string;
    requestId: string;
    workspace: MeetingsWorkspace;
  },
  deps: MeetingsDeps = {},
) {
  const parsed = createBodySchema.safeParse(input.body);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".") || "body"))];
    throw cliApiError(400, "PAYLOAD_INVALID", `Invalid meeting request: ${fields.join(", ")}.`);
  }
  const body = parsed.data;
  const meeting = parseGoogleMeetUrl(body.meetingUrl);
  if (!meeting) {
    throw cliApiError(400, "PAYLOAD_INVALID", "Only Google Meet links (https://meet.google.com/abc-defg-hij) are supported.");
  }

  const now = (deps.now ?? (() => new Date()))();
  const requestedJoinAt = body.joinAt ? new Date(body.joinAt) : null;
  if (
    requestedJoinAt &&
    (requestedJoinAt.getTime() < now.getTime() - 60_000 || requestedJoinAt.getTime() > now.getTime() + SCHEDULE_HORIZON_MS)
  ) {
    throw cliApiError(400, "PAYLOAD_INVALID", "joinAt must be now or within the next 30 days.");
  }
  // Within the minute of tolerance but not in the future: join now, not "scheduled".
  const joinAt = requestedJoinAt && requestedJoinAt.getTime() > now.getTime() ? requestedJoinAt : null;

  const project = await resolveProject(input.workspace, input.projectRef, "write", deps);
  await assertFeature(input.workspace, deps);

  const recall = recallFrom(deps);
  if (!recall) throw cliApiError(503, "SERVER_UNAVAILABLE", "Cloud meeting bots are not configured on this Console.");

  const store = deps.store ?? dbMeetingBotStore;
  const organizationId = input.workspace.organization.id;
  const limits = parseMeetingLimits(await store.limitsValueJson(organizationId));
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const openSince = new Date(now.getTime() - OPEN_BOT_WINDOW_MS);
  const [open, monthSpentUsd] = await Promise.all([
    store.openBots(organizationId, openSince),
    store.monthSpentUsd(organizationId, monthStart),
  ]);
  const allowance = evaluateMeetingAllowance({
    limits,
    openBots: open.count,
    openReservedSeconds: open.reservedSeconds,
    monthSpentUsd,
  });
  if (!allowance.allowed) throw meetingLimitError(allowance.reason, limits);
  const maxRecordingSeconds = Math.min(allowance.maxRecordingSeconds, (body.maxMinutes ?? Infinity) * 60);

  const botName = body.botName ?? MEETING_BOT_NAME_DEFAULT;
  const language = body.language ?? MEETING_LANGUAGE_DEFAULT;
  // The notice names how long the transcript is kept, only where Knowledge keeps it.
  const retentionMonths =
    body.announce === false ? null : await knowledgeFrom(deps).retentionMonths({ organizationId, projectId: project.id });
  const row = await store.insert({
    organizationId,
    projectId: project.id,
    requestedByUserId: input.workspace.user.id,
    localInstallationId: input.localInstallationId,
    provider: RECALL_PROVIDER,
    platform: meeting.platform,
    meetingUrl: meeting.url,
    meetingCode: meeting.code,
    botName,
    title: body.title ?? null,
    language,
    clientRef: body.clientRef ?? null,
    status: "requested",
    joinAt,
    maxRecordingSeconds,
  });

  // The row now holds its seat and its reserved seconds. Re-count with it
  // included: when parallel joins all passed the first check, every one that
  // sees the cap crossed backs out before any bot is sent.
  // Spend is read again too: a bot that finished in between moved its cost
  // from reserved to spent.
  const [reserved, spentNow] = await Promise.all([
    store.openBots(organizationId, openSince),
    store.monthSpentUsd(organizationId, monthStart),
  ]);
  // A cent of slack absorbs the rounding in estimateMeetingCostUsd.
  const overBudget =
    limits.monthlyBudgetUsd - spentNow - estimateMeetingCostUsd(reserved.reservedSeconds) < -0.01;
  if (reserved.count > limits.maxConcurrentBots || overBudget) {
    const reason = reserved.count > limits.maxConcurrentBots ? "concurrency" : "budget";
    await store.update(row.id, { status: "failed", failureReason: "limit_exceeded" });
    throw meetingLimitError(reason, limits);
  }

  let bot: RecallBot;
  try {
    bot = await recall.createBot({
      meetingUrl: meeting.url,
      botName,
      joinAt,
      language,
      maxRecordingSeconds,
      announcement: body.announce === false ? null : recordingAnnouncement(botName, language, retentionMonths),
      metadata: { ravi_meeting_id: row.id, ravi_organization_id: organizationId },
    });
  } catch (error) {
    const reason = error instanceof RecallApiError ? error.message : "The meeting bot provider is unavailable.";
    await store.update(row.id, { status: "failed", failureReason: reason });
    if (error instanceof RecallApiError && error.status === 507) throw cliApiError(429, "RATE_LIMITED", reason);
    if (error instanceof RecallApiError && error.status === 400) throw cliApiError(400, "PAYLOAD_INVALID", reason);
    throw cliApiError(503, "SERVER_UNAVAILABLE", reason);
  }

  const saved = await store.update(row.id, { providerBotId: bot.id, status: joinAt ? "requested" : "joining" });
  await store.audit({
    organizationId,
    actorType: "user",
    actorId: input.workspace.user.id,
    meetingBotId: saved.id,
    action: "meetings.bot.created",
    afterJson: {
      platform: saved.platform,
      meetingCode: saved.meetingCode,
      botName,
      joinAt: iso(joinAt),
      maxRecordingSeconds,
      localInstallationId: input.localInstallationId,
    },
    requestId: input.requestId,
  });
  return { meeting: serializeMeetingBot(saved), limits: allowance.limits };
}

export async function listMeetingBots(
  input: { projectRef: string; limit?: number; workspace: MeetingsWorkspace },
  deps: MeetingsDeps = {},
) {
  const project = await resolveProject(input.workspace, input.projectRef, "read", deps);
  const limit = Math.max(1, Math.min(input.limit ?? 20, 100));
  const rows = await (deps.store ?? dbMeetingBotStore).listForProject(input.workspace.organization.id, project.id, limit);
  return { meetings: rows.map(serializeMeetingBot) };
}

export async function showMeetingBot(
  input: { projectRef: string; meetingId: string; workspace: MeetingsWorkspace },
  deps: MeetingsDeps = {},
) {
  const row = await loadMeetingBot(input, "read", deps);
  return { meeting: serializeMeetingBot(row) };
}

export async function leaveMeetingBot(
  input: { projectRef: string; meetingId: string; requestId: string; workspace: MeetingsWorkspace },
  deps: MeetingsDeps = {},
) {
  const row = await loadMeetingBot(input, "write", deps);
  if (!(OPEN_MEETING_BOT_STATUSES as readonly string[]).includes(row.status) || !row.providerBotId) {
    return { meeting: serializeMeetingBot(row), left: false };
  }
  const recall = recallFrom(deps);
  if (!recall) throw cliApiError(503, "SERVER_UNAVAILABLE", "Cloud meeting bots are not configured on this Console.");
  try {
    await recall.leaveCall(row.providerBotId);
  } catch (error) {
    throw cliApiError(503, "SERVER_UNAVAILABLE", error instanceof RecallApiError ? error.message : "Leave failed.");
  }
  const store = deps.store ?? dbMeetingBotStore;
  await store.audit({
    organizationId: row.organizationId,
    actorType: "user",
    actorId: input.workspace.user.id,
    meetingBotId: row.id,
    action: "meetings.bot.leave_requested",
    afterJson: { status: row.status },
    requestId: input.requestId,
  });
  return { meeting: serializeMeetingBot(row), left: true };
}

export type MeetingMediaKind = "video" | "audio";

export type MeetingRecordingMedia = {
  kind: MeetingMediaKind;
  format: string;
  /** Console path, fetched with the same CLI bearer; the vendor link never leaves the Console. */
  path: string;
  part: number;
  expiresAt: string | null;
};

export type MeetingRecordingResult = {
  meeting: MeetingBotView;
  transcript: { status: string; segments: MeetingTranscriptSegment[] };
  participants: MeetingParticipant[];
  chat: MeetingChatMessage[];
  media: MeetingRecordingMedia[];
  recordings: Array<{ startedAt: string | null; completedAt: string | null; expiresAt: string | null }>;
};

/**
 * The finished recording in Ravi's shape: transcript with speakers, the
 * participants, the chat, and Console paths for the mixed video and audio.
 * The vendor stays behind the Console: its links are streamed through
 * `openMeetingMedia`, never handed out, and media is never stored here.
 */
export async function getMeetingRecording(
  input: { projectRef: string; meetingId: string; workspace: MeetingsWorkspace; mediaBasePath?: string },
  deps: MeetingsDeps = {},
): Promise<MeetingRecordingResult> {
  const row = await loadMeetingBot(input, "read", deps);
  const root = input.mediaBasePath ?? `/api/cli/projects/${encodeURIComponent(input.projectRef)}/meetings`;
  return getMeetingRecordingForRow(row, `${root}/${row.id}/media`, deps);
}

/**
 * The recording of a meeting the caller was already allowed to read, with
 * media paths under `mediaBase` (`<mediaBase>/<kind>?part=<n>`).
 */
export async function getMeetingRecordingForRow(
  row: MeetingBotRow,
  mediaBase: string,
  deps: MeetingsDeps = {},
): Promise<MeetingRecordingResult> {
  const { recall, recordings } = await finishedRecordings(row, deps);
  const base = mediaBase;

  try {
    const segments: MeetingTranscriptSegment[] = [];
    const participants = new Map<string, MeetingParticipant>();
    const chat: MeetingChatMessage[] = [];
    const media: MeetingRecordingMedia[] = [];
    let transcriptStatus = recordings.length === 0 ? "none" : "done";

    for (const [part, recording] of recordings.entries()) {
      const shortcuts = recording.media_shortcuts ?? {};
      const transcriptUrl = shortcuts.transcript?.data?.download_url;
      if (shortcuts.transcript?.status?.code === "done" && transcriptUrl) {
        segments.push(...normalizeRecallTranscript(await recall.downloadJson(transcriptUrl)));
      } else {
        transcriptStatus = shortcuts.transcript?.status?.code ?? "none";
      }
      const events = shortcuts.participant_events?.data;
      if (events?.participants_download_url) {
        for (const participant of normalizeRecallParticipants(await recall.downloadJson(events.participants_download_url))) {
          participants.set(participant.id, participant);
        }
      }
      if (events?.participant_events_download_url) {
        chat.push(...normalizeRecallChatMessages(await recall.downloadJson(events.participant_events_download_url)));
      }
      for (const kind of MEDIA_KINDS) {
        const shortcut = mediaShortcut(recording, kind);
        if (!shortcut) continue;
        media.push({
          kind,
          format: shortcut.format ?? DEFAULT_MEDIA_FORMAT[kind],
          path: `${base}/${kind}?part=${part}`,
          part,
          expiresAt: recording.expires_at ?? null,
        });
      }
    }

    return {
      meeting: serializeMeetingBot(row),
      transcript: { status: transcriptStatus, segments },
      participants: [...participants.values()],
      chat,
      media,
      recordings: recordings.map((recording) => ({
        startedAt: recording.started_at ?? null,
        completedAt: recording.completed_at ?? null,
        expiresAt: recording.expires_at ?? null,
      })),
    };
  } catch (error) {
    if (error instanceof RecallApiError) throw cliApiError(503, "SERVER_UNAVAILABLE", error.message);
    throw error;
  }
}

const MEDIA_KINDS: readonly MeetingMediaKind[] = ["video", "audio"];
const DEFAULT_MEDIA_FORMAT: Record<MeetingMediaKind, string> = { video: "mp4", audio: "mp3" };
const MEDIA_CONTENT_TYPE: Record<string, string> = { mp3: "audio/mpeg", mp4: "video/mp4" };

function mediaShortcut(recording: RecallRecording, kind: MeetingMediaKind) {
  const shortcut = recording.media_shortcuts?.[kind === "video" ? "video_mixed" : "audio_mixed"];
  const url = shortcut?.data?.download_url;
  if (shortcut?.status?.code !== "done" || !url) return null;
  return { url, format: shortcut.format ?? null };
}

/**
 * One finished media file, streamed from the vendor through the Console so the
 * caller never sees where it is stored. A `Range` is passed through so a
 * player can seek; the answer is then `206` with the vendor's `content-range`.
 */
export async function openMeetingMedia(
  input: {
    projectRef: string;
    meetingId: string;
    kind: string;
    part: number;
    workspace: MeetingsWorkspace;
    range?: string | null;
    disposition?: "attachment" | "inline";
  },
  deps: MeetingsDeps & { fetchImpl?: typeof fetch } = {},
) {
  if (input.kind !== "audio" && input.kind !== "video") throw cliApiError(404, "NOT_FOUND", "Unknown media kind.");
  const row = await loadMeetingBot(input, "read", deps);
  return openMeetingMediaForRow(row, input, deps);
}

/** `openMeetingMedia` for a meeting the caller was already allowed to read. */
export async function openMeetingMediaForRow(
  row: MeetingBotRow,
  input: { kind: string; part: number; range?: string | null; disposition?: "attachment" | "inline" },
  deps: MeetingsDeps & { fetchImpl?: typeof fetch } = {},
) {
  if (input.kind !== "audio" && input.kind !== "video") throw cliApiError(404, "NOT_FOUND", "Unknown media kind.");
  const kind: MeetingMediaKind = input.kind;
  const { recordings } = await finishedRecordings(row, deps);
  const recording = Number.isInteger(input.part) && input.part >= 0 ? recordings[input.part] : undefined;
  const shortcut = recording ? mediaShortcut(recording, kind) : null;
  if (!shortcut) throw cliApiError(404, "NOT_FOUND", "This recording has no such media.");
  const range = input.range && /^bytes=(\d+-\d*|-\d+)$/.test(input.range) ? input.range : null;
  const upstream = await (deps.fetchImpl ?? fetch)(shortcut.url, range ? { headers: { range } } : undefined);
  if (upstream.status === 416) throw cliApiError(416, "PAYLOAD_INVALID", "The requested range is outside the file.");
  if (!upstream.ok || !upstream.body) {
    throw cliApiError(503, "SERVER_UNAVAILABLE", `The recording media is unavailable (${upstream.status}).`);
  }
  const format = shortcut.format ?? DEFAULT_MEDIA_FORMAT[kind];
  const headers: Record<string, string> = {
    "content-type": MEDIA_CONTENT_TYPE[format] ?? (kind === "video" ? "video/mp4" : "audio/mpeg"),
    "content-disposition": `${input.disposition ?? "attachment"}; filename="${kind}.${format}"`,
    "accept-ranges": "bytes",
  };
  const length = upstream.headers.get("content-length");
  if (length && /^\d+$/.test(length)) headers["content-length"] = length;
  const partial = range !== null && upstream.status === 206;
  const contentRange = upstream.headers.get("content-range");
  if (partial && contentRange && /^bytes \d+-\d+\/(\d+|\*)$/.test(contentRange)) headers["content-range"] = contentRange;
  return { body: upstream.body, headers, status: partial && headers["content-range"] ? 206 : 200 };
}

async function finishedRecordings(row: MeetingBotRow, deps: MeetingsDeps) {
  if (row.status !== "done" || !row.providerBotId) {
    throw cliApiError(409, "CONFLICT", `The recording is not ready yet (status: ${row.status}).`, {
      status: row.status,
    });
  }
  const recall = recallFrom(deps);
  if (!recall) throw cliApiError(503, "SERVER_UNAVAILABLE", "Cloud meeting bots are not configured on this Console.");
  try {
    const bot = await recall.getBot(row.providerBotId);
    const recordings = (bot.recordings ?? []).filter((recording) => recording.status?.code !== "deleted");
    return { recall, recordings };
  } catch (error) {
    if (error instanceof RecallApiError) throw cliApiError(503, "SERVER_UNAVAILABLE", error.message);
    throw error;
  }
}

/**
 * Said in the meeting chat when the bot joins, so nobody is recorded without
 * notice. With `retentionMonths` (Knowledge on) it also says how long the
 * transcript is kept and that it can be deleted.
 */
export function recordingAnnouncement(botName: string, language: string, retentionMonths: number | null = null) {
  if (language === "pt" || language.startsWith("pt-")) {
    return retentionMonths === null
      ? `${botName} entrou para gravar e transcrever esta reunião. Quem não concordar pode remover este participante.`
      : `${botName} entrou para gravar e transcrever esta reunião. A transcrição fica guardada por ${retentionMonths} meses no Ravi desta organização para consulta da equipe e pode ser apagada a pedido. Quem não concordar pode remover este participante.`;
  }
  return retentionMonths === null
    ? `${botName} joined to record and transcribe this meeting. Anyone who does not agree can remove this participant.`
    : `${botName} joined to record and transcribe this meeting. The transcript is kept for ${retentionMonths} months in this organization's Ravi so the team can look things up, and can be deleted on request. Anyone who does not agree can remove this participant.`;
}

/** The transcript Knowledge kept for a meeting, for when the recording's is gone. Project read. */
export async function getStoredMeetingTranscript(
  input: { projectRef: string; meetingId: string; workspace: MeetingsWorkspace },
  deps: MeetingsDeps = {},
) {
  const row = await loadMeetingBot(input, "read", deps);
  const stored = await knowledgeFrom(deps).storedTranscript({ organizationId: row.organizationId, meetingId: row.id });
  if (!stored || stored.segments.length === 0) throw cliApiError(404, "NOT_FOUND", "No stored transcript for this meeting.");
  return stored;
}

/** Deletes the kept transcript for good (and keeps it from being captured again). Project admin. */
export async function deleteStoredMeetingTranscript(
  input: { projectRef: string; meetingId: string; requestId: string; workspace: MeetingsWorkspace },
  deps: MeetingsDeps = {},
) {
  const row = await loadMeetingBot(input, "admin", deps);
  if (!row.projectId) throw cliApiError(404, "NOT_FOUND", "Meeting not found.");
  const { chunks } = await knowledgeFrom(deps).deleteTranscript({
    organizationId: row.organizationId,
    projectId: row.projectId,
    meetingId: row.id,
    title: row.title,
    actorUserId: input.workspace.user.id,
    requestId: input.requestId,
  });
  return { deleted: true, chunks };
}

const settingsBodySchema = z
  .object({
    transcriptRetentionMonths: z.number().int().min(MEETING_RETENTION_MIN_MONTHS).max(MEETING_RETENTION_MAX_MONTHS),
  })
  .strict();

/** How long the project keeps transcripts, and whether this person may change it. Project read. */
export async function getMeetingSettings(input: { projectRef: string; workspace: MeetingsWorkspace }, deps: MeetingsDeps = {}) {
  const project = await resolveProject(input.workspace, input.projectRef, "read", deps);
  const admin = await (deps.resolveProject ?? findAccessibleProjectRecord)(input.workspace, input.projectRef, "admin");
  const settings = await knowledgeFrom(deps).settings({ organizationId: input.workspace.organization.id, projectId: project.id });
  return { ...settings, canManage: admin !== null };
}

/** `{transcriptRetentionMonths: 1..36}`; recomputes `retain_until` of the project's meeting transcripts. Project admin. */
export async function updateMeetingSettings(
  input: { projectRef: string; body: unknown; requestId: string; workspace: MeetingsWorkspace },
  deps: MeetingsDeps = {},
) {
  const parsed = settingsBodySchema.safeParse(input.body);
  if (!parsed.success) {
    throw cliApiError(
      400,
      "PAYLOAD_INVALID",
      `transcriptRetentionMonths must be a whole number from ${MEETING_RETENTION_MIN_MONTHS} to ${MEETING_RETENTION_MAX_MONTHS}.`,
    );
  }
  const project = await resolveProject(input.workspace, input.projectRef, "admin", deps);
  const knowledge = knowledgeFrom(deps);
  await knowledge.updateSettings({
    organizationId: input.workspace.organization.id,
    projectId: project.id,
    months: parsed.data.transcriptRetentionMonths,
    actorUserId: input.workspace.user.id,
    requestId: input.requestId,
  });
  const settings = await knowledge.settings({ organizationId: input.workspace.organization.id, projectId: project.id });
  return { ...settings, canManage: true };
}

function knowledgeFrom(deps: MeetingsDeps): MeetingKnowledgeStore {
  return deps.knowledge ?? dbMeetingKnowledgeStore;
}

/** One meeting of a project in the caller's own organization, with the project role `action` needs. */
export async function loadProjectMeeting(
  input: { projectRef: string; meetingId: string; workspace: MeetingsWorkspace },
  action: ProjectAccessAction,
  deps: MeetingsDeps = {},
) {
  return loadMeetingBot(input, action, deps);
}

async function loadMeetingBot(
  input: { projectRef: string; meetingId: string; workspace: MeetingsWorkspace },
  action: ProjectAccessAction,
  deps: MeetingsDeps,
) {
  const project = await resolveProject(input.workspace, input.projectRef, action, deps);
  if (!z.string().uuid().safeParse(input.meetingId).success) throw cliApiError(404, "NOT_FOUND", "Meeting not found.");
  const row = await (deps.store ?? dbMeetingBotStore).findById(input.workspace.organization.id, input.meetingId);
  if (!row || row.projectId !== project.id) throw cliApiError(404, "NOT_FOUND", "Meeting not found.");
  return row;
}

async function resolveProject(
  workspace: MeetingsWorkspace,
  projectRef: string,
  action: ProjectAccessAction,
  deps: MeetingsDeps,
) {
  const project = await (deps.resolveProject ?? findAccessibleProjectRecord)(workspace, projectRef, action);
  if (!project) throw cliApiError(403, "PROJECT_ACCESS_DENIED");
  return project;
}

async function assertFeature(workspace: MeetingsWorkspace, deps: MeetingsDeps) {
  const input = { organizationId: workspace.organization.id, role: workspace.membership.role };
  const enabled = deps.featureEnabled
    ? await deps.featureEnabled(input)
    : (await getConsoleFeatureAccessForOrganizationRole(input)).byKey[MEETINGS_FEATURE_KEY].enabled;
  if (!enabled) {
    throw cliApiError(403, "ORG_ACCESS_DENIED", "Cloud meeting recording (console.meetings) is not enabled for this organization.");
  }
}

function recallFrom(deps: MeetingsDeps): RecallClient | null {
  if (deps.recall !== undefined) return deps.recall;
  const config = getRecallConfigFromEnv();
  return config ? createRecallClient(config) : null;
}

function iso(value: Date | null | undefined) {
  return value ? value.toISOString() : null;
}

function meetingLimitError(reason: "feature_unavailable" | "concurrency" | "budget", limits: MeetingLimits) {
  return cliApiError(
    429,
    "RATE_LIMITED",
    reason === "concurrency"
      ? `This organization already has ${limits.maxConcurrentBots} meeting bots running.`
      : "This organization reached its monthly meeting recording budget.",
    { reason },
  );
}
