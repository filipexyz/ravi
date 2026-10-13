import "reflect-metadata";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, mkdirSync } from "node:fs";
import { delimiter, join } from "node:path";
import { z } from "zod";
import {
  ContractError,
  CONTRACT_EXIT_USAGE,
  contractFail,
  pickFields,
  renderContractError,
  suggestSimilar,
} from "../agent-contract.js";
import { cloudErrorToContractError } from "../cloud-error-contract.js";
import { isCloudAuthError } from "../../cloud-auth/errors.js";
import {
  MEETING_CLOUD_PROVIDER_RUNTIME,
  normalizeGoogleMeetUrl,
  openMeetingsCloudClient,
  type CloudMeeting,
  type CloudMeetingCreateBody,
  type MeetingsCloudClient,
} from "../../meetings/cloud.js";
import { fetchCloudMeeting } from "../../meetings/cloud-finalize.js";
import { Arg, CliOnly, Command, CommandAccess, Group, Option, Returns } from "../decorators.js";
import { fail, getContext } from "../context.js";
import { buildCliOffsetPagination, paginateCliItems } from "../pagination.js";
import {
  appendArtifactEvent,
  attachArtifact,
  createArtifact,
  getArtifact,
  updateArtifact,
} from "../../artifacts/store.js";
import {
  looseObjectSchema,
  meetingProfileInitReturnSchema,
  meetingProfileReturnSchema,
  meetingProfilesListReturnSchema,
  meetingProfilesValidateReturnSchema,
  meetingVoiceRuntimesReturnSchema,
} from "./operational-return-schemas.js";
import { finalizeGoogleMeetRecorderRun } from "../../meetings/google-meet/recorder-run.js";
import { notifyMeetingOwnerSession, spawnDetachedCli } from "../../meetings/handoff.js";
import {
  DEFAULT_MEETING_VOICE_RUNTIME_ID,
  listMeetingVoiceRuntimeCandidates,
  resolveMeetingVoiceRuntime,
  type MeetingVoiceRuntimeDecision,
} from "../../meetings/voice-runtime.js";
import {
  initMeetingProfile,
  listMeetingProfiles,
  publicMeetingProfile,
  resolveMeetingProfile,
  validateMeetingProfiles,
  type ResolvedMeetingProfile,
} from "../../meetings/profiles.js";
import {
  RAVI_MEET_RESOLVED_PROFILE_ENV,
  buildMeetingResolvedProfile,
  publicMeetingResolvedProfile,
  readMeetingResolvedProfile,
  writeMeetingResolvedProfile,
  type BuildMeetingResolvedProfileInput,
  type MeetingResolvedProfile,
} from "../../meetings/resolved-profile.js";
import { getAgent } from "../../router/config.js";
import { getAgentCwd } from "../../router/resolver.js";
import { getOrCreateSession, updateSessionContext } from "../../router/sessions.js";
import { getRaviStateDir } from "../../utils/paths.js";
import { GOOGLE_MEET_PROVIDER_ID, MEETING_CHANNEL_ID } from "../../channels/meetings/types.js";

const DEFAULT_GOOGLE_MEET_CAPTURE_MODE = "webrtc-tap" as const;

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

const nullableStringSchema = z.string().nullable();

const meetingFinalizeReturnSchema = z
  .object({
    artifactId: z.string(),
    artifactPath: z.string(),
    handoffMessage: z.string(),
    transcriptSegmentCount: z.number(),
    mediaRefCount: z.number(),
    diagnosticCount: z.number(),
    session: z
      .object({
        id: z.string(),
        provider: z.string(),
        providerMeetingId: nullableStringSchema,
        title: nullableStringSchema,
        startedAt: nullableStringSchema,
        endedAt: nullableStringSchema,
      })
      .strict(),
  })
  .strict();

function contextDefaults() {
  const ctx = getContext();
  return {
    sessionKey: ctx?.sessionKey,
    sessionName: ctx?.sessionName,
    agentId: ctx?.agentId,
    channel: ctx?.source?.channel,
    accountId: ctx?.source?.accountId,
    chatId: ctx?.source?.chatId,
    threadId: ctx?.source?.threadId,
    messageId: process.env.RAVI_MESSAGE_ID,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * MEETING_PROFILE_NOT_FOUND envelope (Manual v2): suggestions come from the
 * LOCAL meeting-profile catalog (`listMeetingProfiles`), a cheap local read.
 * Resolve errors on profiles that DO exist keep the legacy fail() path.
 */
function failMeetingProfileNotFound(op: string, profileId: string, asJson?: boolean): never {
  const candidates = listMeetingProfiles().flatMap((profile) => [profile.id, profile.label]);
  contractFail(op, "MEETING_PROFILE_NOT_FOUND", `Meeting profile not found: ${profileId}`, {
    asJson,
    details: {
      suggestedAction: "List meeting profiles with `ravi meetings profiles list --json`",
      suggestions: suggestSimilar(profileId, candidates),
    },
  });
}

function meetingProfileExists(profileId: string): boolean {
  try {
    return listMeetingProfiles().some((profile) => profile.id === profileId);
  } catch {
    return false;
  }
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findExecutableOnPath(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

function resolveGoogleMeetRecorderExecutable(): string {
  const configured = process.env.RAVI_GOOGLE_MEET_RECORDER_BIN?.trim();
  if (configured) return configured;

  const onPath = findExecutableOnPath("meet-record");
  if (onPath) return onPath;

  fail(
    "Google Meet recorder provider is unavailable. Install the provider executable on PATH or set RAVI_GOOGLE_MEET_RECORDER_BIN.",
  );
}

function pushOption(args: string[], flag: string, value?: string): void {
  if (!value?.trim()) return;
  args.push(flag, value);
}

function pushFlag(args: string[], flag: string, enabled?: boolean): void {
  if (enabled) args.push(flag);
}

function mergeEnvOverrides(...overrides: Array<NodeJS.ProcessEnv | undefined>): NodeJS.ProcessEnv | undefined {
  const merged = Object.assign({}, ...overrides.filter(Boolean));
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function buildGoogleMeetJoinArgs(input: {
  url: string;
  name?: string;
  out?: string;
  profileDir?: string;
  duration?: string;
  maxDuration?: string;
  emptyGrace?: string;
  capture?: string;
  skipFinalize?: boolean;
}): string[] {
  const args = ["--url", input.url, "--until-empty", "--out", input.out?.trim() || "~/.ravi/meetings/runs"];
  pushOption(args, "--name", input.name);
  pushOption(args, "--profile-dir", input.profileDir);
  pushOption(args, "--duration", input.duration);
  pushOption(args, "--max-duration", input.maxDuration);
  pushOption(args, "--empty-grace", input.emptyGrace);
  pushOption(args, "--capture", input.capture ?? DEFAULT_GOOGLE_MEET_CAPTURE_MODE);
  if (input.skipFinalize) args.push("--no-ravi-finalize-artifact");
  return args;
}

function buildGoogleMeetJoinWorkerArgs(input: {
  provider: string;
  url: string;
  name?: string;
  out?: string;
  profileDir?: string;
  duration?: string;
  maxDuration?: string;
  emptyGrace?: string;
  capture?: string;
  voiceRuntime?: string;
  live?: boolean;
  liveAgentId?: string;
  liveContext?: string;
  includeSessionContext?: boolean;
  skipFinalize?: boolean;
  artifactId: string;
}): string[] {
  const args = ["meetings", "join", "--provider", input.provider, "--url", input.url];
  pushOption(args, "--name", input.name);
  pushOption(args, "--out", input.out);
  pushOption(args, "--profile-dir", input.profileDir);
  pushOption(args, "--duration", input.duration);
  pushOption(args, "--max-duration", input.maxDuration);
  pushOption(args, "--empty-grace", input.emptyGrace);
  pushOption(args, "--capture", input.capture ?? DEFAULT_GOOGLE_MEET_CAPTURE_MODE);
  pushOption(args, "--voice-runtime", input.voiceRuntime);
  pushOption(args, "--agent", input.liveAgentId);
  pushOption(args, "--context", input.liveContext);
  pushFlag(args, "--include-session-context", input.includeSessionContext);
  pushFlag(args, "--live", input.live);
  pushFlag(args, "--skip-finalize", input.skipFinalize);
  args.push("--artifact-id", input.artifactId, "--async-worker", "--json");
  return args;
}

interface GoogleMeetJoinRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function runGoogleMeetProviderCommand(
  command: string,
  args: string[],
  captureOutput: boolean,
  envOverrides?: NodeJS.ProcessEnv,
): Promise<GoogleMeetJoinRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: envOverrides ? { ...process.env, ...envOverrides } : process.env,
      stdio: captureOutput ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let stdout = "";
    let stderr = "";
    if (captureOutput) {
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });
    }
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}

function runGoogleMeetRecorder(
  command: string,
  args: string[],
  asJson: boolean,
  envOverrides?: NodeJS.ProcessEnv,
): Promise<GoogleMeetJoinRunResult> {
  return runGoogleMeetProviderCommand(command, asJson ? [...args, "--json"] : args, asJson, envOverrides);
}

function buildGoogleMeetLoginArgs(input: {
  profileDir?: string;
  browserChannel?: string;
  url?: string;
  viewport?: string;
}): string[] {
  const args = ["login"];
  pushOption(args, "--profile-dir", input.profileDir);
  pushOption(args, "--browser-channel", input.browserChannel);
  pushOption(args, "--url", input.url);
  pushOption(args, "--viewport", input.viewport);
  return args;
}

function parseRecorderJson(stdout: string): unknown | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace < 0 || lastBrace < firstBrace) return undefined;
  return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
}

function recordFromUnknown(value: unknown): Record<string, any> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : undefined;
}

function summarizeRecorderMetadata(metadata: unknown): Record<string, unknown> | undefined {
  const record = recordFromUnknown(metadata);
  if (!record) return undefined;
  return {
    status: record.status ?? null,
    admissionStatus: record.admissionStatus ?? null,
    runDir: record.artifacts?.runDir ?? null,
    metadataPath: record.artifacts?.metadataPath ?? null,
    artifactId: record.raviArtifact?.artifactId ?? null,
    artifactPath: record.raviArtifact?.artifactPath ?? null,
    transcriptSegmentCount: record.raviArtifact?.transcriptSegmentCount ?? null,
    mediaRefCount: record.raviArtifact?.mediaRefCount ?? null,
    diagnosticCount: record.raviArtifact?.diagnosticCount ?? null,
  };
}

function extractRecorderArtifact(metadata: unknown): {
  status?: string;
  artifactId?: string;
  artifactPath?: string;
  handoffMessage?: string;
  transcriptSegmentCount?: number;
  mediaRefCount?: number;
  diagnosticCount?: number;
  error?: string;
} {
  const record = recordFromUnknown(metadata);
  const raviArtifact = recordFromUnknown(record?.raviArtifact);
  if (!raviArtifact) return {};
  return {
    ...(typeof raviArtifact.status === "string" ? { status: raviArtifact.status } : {}),
    ...(typeof raviArtifact.artifactId === "string" ? { artifactId: raviArtifact.artifactId } : {}),
    ...(typeof raviArtifact.artifactPath === "string" ? { artifactPath: raviArtifact.artifactPath } : {}),
    ...(typeof raviArtifact.handoffMessage === "string" ? { handoffMessage: raviArtifact.handoffMessage } : {}),
    ...(typeof raviArtifact.transcriptSegmentCount === "number"
      ? { transcriptSegmentCount: raviArtifact.transcriptSegmentCount }
      : {}),
    ...(typeof raviArtifact.mediaRefCount === "number" ? { mediaRefCount: raviArtifact.mediaRefCount } : {}),
    ...(typeof raviArtifact.diagnosticCount === "number" ? { diagnosticCount: raviArtifact.diagnosticCount } : {}),
    ...(typeof raviArtifact.error === "string" ? { error: raviArtifact.error } : {}),
  };
}

function buildMeetingJoinTitle(url: string): string {
  const trimmed = url.trim();
  const meetCode = extractGoogleMeetCode(trimmed);
  return `Google Meet ${meetCode ?? trimmed}`.slice(0, 200);
}

function extractGoogleMeetCode(url: string): string | undefined {
  return url
    .trim()
    .match(/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})/i)?.[1]
    ?.toLowerCase();
}

function safeSessionToken(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "meeting"
  );
}

function timestampToken(now = new Date()): string {
  return now
    .toISOString()
    .replaceAll(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z")
    .toLowerCase();
}

function meetingIdFromUrl(url: string): string {
  const code = extractGoogleMeetCode(url);
  if (code) return code;
  return `url-${createHash("sha256").update(url.trim()).digest("hex").slice(0, 12)}`;
}

interface NativeMeetingRuntimeSessionPlan {
  sessionKey: string;
  sessionName: string;
  agentId: string;
  provider: "google-meet";
  providerMeetingId: string;
  title: string;
  bridgeDir: string;
  created: boolean;
}

function nativeMeetingRuntimeFromResolvedProfile(
  profile: MeetingResolvedProfile | undefined,
  url: string,
): NativeMeetingRuntimeSessionPlan | undefined {
  const sessionName = profile?.session.name?.trim();
  const sessionKey = profile?.session.key?.trim();
  const agentId = profile?.session.agentId?.trim();
  if (!sessionName || !sessionKey || !agentId || !profile?.session.nativeRuntime) return undefined;
  const providerMeetingId = profile.session.providerMeetingId?.trim() || meetingIdFromUrl(url);
  return {
    sessionKey,
    sessionName,
    agentId,
    provider: GOOGLE_MEET_PROVIDER_ID,
    providerMeetingId,
    title: buildMeetingJoinTitle(url),
    bridgeDir: profile.session.bridgeDir?.trim() || join(getRaviStateDir(), "meetings", "bridges", sessionName),
    created: false,
  };
}

function buildNativeMeetingRuntimeSessionPlan(input: {
  url: string;
  agentId: string;
  origin: ReturnType<typeof contextDefaults>;
  create: boolean;
}): NativeMeetingRuntimeSessionPlan {
  const agent = getAgent(input.agentId);
  if (!agent) fail(`Live meeting agent is not registered in Ravi: ${input.agentId}`);

  const providerMeetingId = meetingIdFromUrl(input.url);
  const sessionSuffix = timestampToken();
  const sessionName = `meet-${GOOGLE_MEET_PROVIDER_ID}-${safeSessionToken(providerMeetingId)}-${sessionSuffix}`;
  const sessionKey = `agent:${input.agentId}:meet:${GOOGLE_MEET_PROVIDER_ID}:${providerMeetingId}:${sessionSuffix}`;
  const title = buildMeetingJoinTitle(input.url);
  const bridgeDir = join(getRaviStateDir(), "meetings", "bridges", sessionName);

  if (input.create) {
    mkdirSync(join(bridgeDir, "outbound"), { recursive: true });
    getOrCreateSession(sessionKey, input.agentId, getAgentCwd(agent), {
      name: sessionName,
      chatType: "group",
      channel: MEETING_CHANNEL_ID,
      accountId: GOOGLE_MEET_PROVIDER_ID,
      groupId: providerMeetingId,
      subject: title,
      displayName: title,
      lastChannel: MEETING_CHANNEL_ID,
      lastAccountId: GOOGLE_MEET_PROVIDER_ID,
      lastTo: providerMeetingId,
    });
    updateSessionContext(sessionKey, {
      channelId: MEETING_CHANNEL_ID,
      channelName: "Meet",
      isGroup: true,
      groupId: providerMeetingId,
      groupName: title,
    });
  }

  return {
    sessionKey,
    sessionName,
    agentId: input.agentId,
    provider: GOOGLE_MEET_PROVIDER_ID,
    providerMeetingId,
    title,
    bridgeDir,
    created: input.create,
  };
}

function publicNativeMeetingRuntimeSession(
  session: NativeMeetingRuntimeSessionPlan | undefined,
): Record<string, unknown> | null {
  if (!session) return null;
  return {
    sessionKey: session.sessionKey,
    sessionName: session.sessionName,
    agentId: session.agentId,
    provider: session.provider,
    providerMeetingId: session.providerMeetingId,
    title: session.title,
    bridgeDir: session.bridgeDir,
    created: session.created,
  };
}

function publicVoiceRuntimeDecision(decision: MeetingVoiceRuntimeDecision): Record<string, unknown> {
  return {
    enabled: decision.enabled,
    runtimeId: decision.runtimeId,
    runnable: decision.runnable,
    reason: decision.reason,
    availability: decision.candidate?.availability ?? null,
    kind: decision.candidate?.kind ?? null,
    defaultModel: decision.candidate?.defaultModel ?? null,
    docsUrl: decision.candidate?.docsUrl ?? null,
  };
}

function firstTrimmed(...values: Array<string | null | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function buildResolvedProfileInput(input: {
  provider: "google-meet";
  meetingProfile?: ResolvedMeetingProfile;
  sessionKey?: string | null;
  sessionName?: string | null;
  agentId?: string | null;
  contextId?: string;
  nativeMeetingRuntime?: NativeMeetingRuntimeSessionPlan;
  chromeProfileDir?: string;
  browserChannel?: string;
  voiceRuntimeDecision: MeetingVoiceRuntimeDecision;
  initialPrompt?: string;
  initialPromptDelay?: string;
  live: boolean;
  liveContext?: string;
  includeSessionContext?: boolean;
  liveTools?: string;
  toolManifestPath?: string;
  toolCount?: number | null;
  out?: string;
  capture?: string;
}): BuildMeetingResolvedProfileInput {
  return {
    provider: input.provider,
    profile: input.meetingProfile,
    sessionKey: input.sessionKey ?? input.nativeMeetingRuntime?.sessionKey,
    sessionName: input.sessionName ?? undefined,
    agentId: input.agentId ?? undefined,
    contextId: input.contextId,
    nativeRuntime: input.voiceRuntimeDecision.enabled,
    providerMeetingId: input.nativeMeetingRuntime?.providerMeetingId,
    bridgeDir: input.nativeMeetingRuntime?.bridgeDir,
    chromeProfileDir: input.chromeProfileDir,
    browserChannel: input.meetingProfile?.chrome.browserChannel,
    voiceRuntimeId: input.voiceRuntimeDecision.runtimeId,
    voiceRuntimeEnabled: input.voiceRuntimeDecision.enabled,
    initialPrompt: input.initialPrompt,
    initialPromptDelay: input.initialPromptDelay,
    liveEnabled: input.live,
    liveContext: input.liveContext,
    includeSessionContext: input.includeSessionContext,
    liveTools: input.liveTools,
    toolManifestPath: input.toolManifestPath,
    toolCount: input.toolCount,
    out: input.out,
    capture: input.capture,
  };
}

const MEETINGS_CLOUD_SOURCE = "ravi.meetings.cloud";
/** The Console lists at most this many bots per project, newest first. */
const CLOUD_MEETINGS_WINDOW = 100;

/** Turns Console errors into the CLI contract envelope, rendered once. */
async function withMeetingsCloud<T>(op: string, asJson: boolean | undefined, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ContractError || !isCloudAuthError(error)) throw error;
    const contract = cloudErrorToContractError(op, error);
    renderContractError(contract, asJson);
    throw contract;
  }
}

function openCloudClient(op: string, project: string | undefined, asJson: boolean | undefined) {
  return withMeetingsCloud(op, asJson, () => openMeetingsCloudClient({ project: project?.trim() || undefined }));
}

/** Seconds from --max-duration as whole minutes inside the Console's 5-480 window. */
function cloudMaxMinutes(maxDuration: string | undefined, asJson: boolean | undefined): number | undefined {
  if (!maxDuration) return undefined;
  const seconds = Number(maxDuration);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    contractFail("meetings join", "INVALID_ARGUMENT", "--max-duration must be a positive number of seconds.", {
      asJson,
      exitCode: CONTRACT_EXIT_USAGE,
    });
  }
  return Math.min(480, Math.max(5, Math.ceil(seconds / 60)));
}

function publicCloudMeeting(meeting: CloudMeeting) {
  return {
    id: meeting.id,
    status: meeting.status,
    statusSubCode: meeting.statusSubCode,
    meetingUrl: meeting.meetingUrl,
    meetingCode: meeting.meetingCode,
    botName: meeting.botName,
    title: meeting.title,
    clientRef: meeting.clientRef,
    ready: meeting.ready,
    joinAt: meeting.joinAt,
    recordingStartedAt: meeting.recordingStartedAt,
    endedAt: meeting.endedAt,
    recordingSeconds: meeting.recordingSeconds,
    maxRecordingSeconds: meeting.maxRecordingSeconds,
    failureReason: meeting.failureReason,
    createdAt: meeting.createdAt,
  };
}

function printCloudMeetingLine(meeting: CloudMeeting): void {
  const label = meeting.title ?? meeting.meetingCode ?? meeting.meetingUrl;
  const minutes =
    typeof meeting.recordingSeconds === "number" ? ` ${Math.round(meeting.recordingSeconds / 60)} min` : "";
  console.log(`${meeting.id}  ${meeting.status.padEnd(12)} ${label}${minutes}`);
}

/**
 * `ravi meetings join` without --local: asks the Console for a cloud bot and
 * records a `meeting.join` artifact that the inbox handoff closes when the
 * recording is ready (or the bot fails).
 */
async function joinWithCloudBot(input: {
  url: string;
  name?: string;
  maxDuration?: string;
  project?: string;
  dryRun: boolean;
  asJson?: boolean;
}) {
  const op = "meetings join";
  const meetingUrl = normalizeGoogleMeetUrl(input.url);
  if (!meetingUrl) {
    contractFail(
      op,
      "INVALID_ARGUMENT",
      "The cloud bot joins Google Meet links only (https://meet.google.com/abc-defg-hij).",
      {
        asJson: input.asJson,
        exitCode: CONTRACT_EXIT_USAGE,
        details: { suggestedAction: "Pass a Google Meet link, or use --local" },
      },
    );
  }
  const maxMinutes = cloudMaxMinutes(input.maxDuration, input.asJson);
  const request: CloudMeetingCreateBody = {
    meetingUrl,
    ...(input.name ? { botName: input.name } : {}),
    ...(maxMinutes ? { maxMinutes } : {}),
  };

  if (input.dryRun) {
    const payload = {
      mode: "dry-run",
      runtime: "cloud",
      provider: GOOGLE_MEET_PROVIDER_ID,
      providerRuntime: MEETING_CLOUD_PROVIDER_RUNTIME,
      project: input.project?.trim() || null,
      request,
    };
    if (input.asJson) printJson(payload);
    else {
      console.log("Cloud meeting bot request validated; nothing was sent.");
      console.log(`Meeting: ${meetingUrl}`);
      if (input.name) console.log(`Bot name: ${input.name}`);
      if (maxMinutes) console.log(`Max minutes: ${maxMinutes}`);
    }
    return payload;
  }

  const client = await openCloudClient(op, input.project, input.asJson);
  const ctx = contextDefaults();
  const artifact = createArtifact({
    kind: "meeting.join",
    status: "pending",
    title: buildMeetingJoinTitle(meetingUrl),
    summary: "Cloud meeting bot requested",
    provider: GOOGLE_MEET_PROVIDER_ID,
    command: "ravi meetings join",
    ...ctx,
    metadata: {
      providerRuntime: MEETING_CLOUD_PROVIDER_RUNTIME,
      cloud: true,
      consoleProjectRef: client.projectRef,
    },
    lineage: {
      source: "ravi meetings join",
      provider: GOOGLE_MEET_PROVIDER_ID,
      providerRuntime: MEETING_CLOUD_PROVIDER_RUNTIME,
    },
    input: { url: meetingUrl, options: { ...request, project: client.projectRef } },
    tags: ["meeting", "meeting-join", GOOGLE_MEET_PROVIDER_ID, "cloud"],
  });

  let created: Awaited<ReturnType<MeetingsCloudClient["create"]>>;
  try {
    created = await withMeetingsCloud(op, input.asJson, () => client.create({ ...request, clientRef: artifact.id }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updateArtifact(
      artifact.id,
      { status: "failed", summary: `Cloud meeting bot request failed: ${message}`, metadata: { error: message } },
      { actor: ctx.agentId, mergeMetadata: true },
    );
    appendArtifactEvent(artifact.id, {
      eventType: "failed",
      status: "failed",
      message: `Cloud meeting bot request failed: ${message}`,
      source: MEETINGS_CLOUD_SOURCE,
      ...(ctx.agentId ? { actor: ctx.agentId } : {}),
    });
    throw error;
  }

  const { meeting, limits } = created;
  const running = updateArtifact(
    artifact.id,
    {
      status: "running",
      summary: `Cloud meeting bot ${meeting.status}`,
      metadata: { consoleMeetingId: meeting.id, cloudStatus: meeting.status },
    },
    { actor: ctx.agentId, mergeMetadata: true },
  );
  appendArtifactEvent(artifact.id, {
    eventType: "cloud_bot_requested",
    status: "running",
    message: `Cloud meeting bot ${meeting.status}: ${meeting.id}`,
    payload: { consoleMeetingId: meeting.id, status: meeting.status, maxRecordingSeconds: meeting.maxRecordingSeconds },
    source: MEETINGS_CLOUD_SOURCE,
    ...(ctx.agentId ? { actor: ctx.agentId } : {}),
  });

  const payload = {
    success: true,
    runtime: "cloud",
    artifact_id: running.id,
    artifactId: running.id,
    kind: running.kind,
    status: running.status,
    meeting: publicCloudMeeting(meeting),
    limits,
    hint: "No polling needed: when the recording is ready this installation builds the meeting.raw artifact and informs the owner session.",
    events: `ravi artifacts events ${running.id}`,
    leave: `ravi meetings leave ${meeting.id}`,
  };
  if (input.asJson) printJson(payload);
  else {
    console.log(`Cloud meeting bot ${meeting.status}: ${meeting.id}`);
    console.log(`Artifact: ${running.id}`);
    console.log(`Leave: ravi meetings leave ${meeting.id}`);
  }
  return payload;
}

@Group({
  name: "meetings",
  description: "Meeting artifact and provider operations",
  scope: "open",
})
export class MeetingsCommands {
  // Declared UNBRAKED: login opens an interactive human-driven Google login
  // in a local browser profile — the human at the browser IS the confirmation
  // step, and a dry-run gate would only break that flow. No external write
  // happens without the human completing it.
  @Command({
    name: "login",
    description: "Open Google login for the persistent Google Meet recorder browser profile",
  })
  @CommandAccess({ kind: "mutate", resource: "meetings", action: "login", risk: "medium" })
  @CliOnly()
  @Returns(looseObjectSchema)
  async login(
    @Option({ flags: "--provider <provider>", description: "Meeting provider id. Currently: google-meet" })
    provider?: string,
    @Option({ flags: "--profile-dir <dir>", description: "Persistent browser profile directory" }) profileDir?: string,
    @Option({ flags: "--browser-channel <channel>", description: "Playwright Chromium channel" })
    browserChannel?: string,
    @Option({ flags: "--url <url>", description: "Optional Meet URL to open after Google account login" }) url?: string,
    @Option({ flags: "--viewport <size>", description: "Browser viewport, e.g. 1280x720" }) viewport?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const selectedProvider = provider?.trim() || "google-meet";
    if (selectedProvider !== "google-meet") fail(`Unsupported meeting provider: ${selectedProvider}.`);

    const command = resolveGoogleMeetRecorderExecutable();
    const args = buildGoogleMeetLoginArgs({ profileDir, browserChannel, url, viewport });
    const result = await runGoogleMeetProviderCommand(command, args, Boolean(asJson));
    if (result.exitCode !== 0) {
      const details = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
      throw new Error(
        `Google Meet provider login exited with code ${result.exitCode}.${details ? `\n${details}` : ""}`,
      );
    }

    const payload = {
      provider: selectedProvider,
      providerRuntime: "google-meet-recorder",
      profileDir: profileDir?.trim() || "~/.ravi/meet-recorder/chrome-profile",
      browserChannel: browserChannel?.trim() || "chrome",
      url: url?.trim() || null,
      viewport: viewport?.trim() || "1280x720",
      args,
      exitCode: result.exitCode,
      ...(asJson
        ? {
            stdout: result.stdout.trim() || null,
            stderr: result.stderr.trim() || null,
          }
        : {}),
    };

    if (asJson) {
      printJson(payload);
    }
    return payload;
  }

  // Manual v2 write-brake EQUIVALENT: `join` keeps its pre-existing
  // `--dry-run` flag (not renamed to --execute) as the inspect-before-acting
  // path — it validates the provider invocation, prints args/env and joins
  // nothing. The default is a real join because joining is the whole point of
  // the op and it is visible/interruptible (the bot appears as a participant
  // and can be removed), unlike an irreversible external write.
  @Command({
    name: "join",
    description: "Join a meeting through a native Ravi meeting provider",
  })
  @CommandAccess({ kind: "mutate", resource: "meetings", action: "join", risk: "high" })
  @CliOnly()
  @Returns(looseObjectSchema)
  async join(
    @Option({ flags: "--provider <provider>", description: "Meeting provider id. Currently: google-meet" })
    provider?: string,
    @Option({ flags: "--url <url>", description: "Meeting URL" }) url?: string,
    @Option({ flags: "--name <name>", description: "Visible meeting participant name" }) name?: string,
    @Option({ flags: "--out <dir>", description: "Recorder output base directory" }) out?: string,
    @Option({ flags: "--profile-dir <dir>", description: "Persistent browser profile directory" }) profileDir?: string,
    @Option({ flags: "--duration <seconds>", description: "Recorder duration hint" }) duration?: string,
    @Option({ flags: "--max-duration <seconds>", description: "Hard cap while waiting for the meeting to end" })
    maxDuration?: string,
    @Option({ flags: "--empty-grace <seconds>", description: "Seconds to wait after the meeting appears empty" })
    emptyGrace?: string,
    @Option({ flags: "--capture <mode>", description: "Capture mode passed to the provider" }) capture?: string,
    @Option({
      flags: "--initial-prompt <text>",
      description: "Initial prompt for the native Ravi meeting session after join",
    })
    initialPrompt?: string,
    @Option({ flags: "--initial-prompt-delay <seconds>", description: "Delay before --initial-prompt is spoken" })
    initialPromptDelay?: string,
    @Option({
      flags: "--voice-runtime <id>",
      description: `Voice runtime for live meeting mode. Current ready default: ${DEFAULT_MEETING_VOICE_RUNTIME_ID}`,
    })
    voiceRuntime?: string,
    @Option({ flags: "--agent <id>", description: "Registered Ravi agent id for live meeting mode" })
    liveAgentId?: string,
    @Option({ flags: "--context <text>", description: "Freeform context injected into the live meeting agent prompt" })
    liveContext?: string,
    @Option({
      flags: "--include-session-context",
      description: "Inject recent Ravi session history into the live meeting prompt",
    })
    includeSessionContext?: boolean,
    @Option({ flags: "--live", description: "Enable native Ravi live agent mode" })
    live?: boolean,
    @Option({ flags: "--skip-finalize", description: "Skip final meeting.raw artifact registration" })
    skipFinalize?: boolean,
    @Option({ flags: "--sync", description: "Wait for provider completion before returning" })
    syncMode?: boolean,
    @Option({ flags: "--artifact-id <id>", description: "Internal artifact id for async worker continuation" })
    artifactId?: string,
    @Option({ flags: "--async-worker", description: "Internal background worker mode" })
    asyncWorker?: boolean,
    @Option({ flags: "--dry-run", description: "Validate and print provider invocation without joining" })
    dryRun?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--tools <names>", description: "Comma-separated Ravi tool names allowlist for live mode" })
    liveTools?: string,
    @Option({ flags: "--profile <id>", description: "Reusable meeting profile id" })
    meetingProfileId?: string,
    @Option({
      flags: "--local",
      description: "Run the recorder in Chrome on this machine instead of sending the cloud bot",
    })
    local?: boolean,
    @Option({ flags: "--project <ref>", description: "Console project for the cloud bot (default: linked project)" })
    project?: string,
  ) {
    const requestedMeetingProfileId = meetingProfileId?.trim();
    let meetingProfile: ResolvedMeetingProfile | undefined;
    if (requestedMeetingProfileId) {
      try {
        meetingProfile = resolveMeetingProfile(requestedMeetingProfileId);
      } catch (error) {
        if (!meetingProfileExists(requestedMeetingProfileId)) {
          failMeetingProfileNotFound("meetings join", requestedMeetingProfileId, asJson);
        }
        fail(errorMessage(error));
      }
    }

    const selectedProvider = firstTrimmed(provider, meetingProfile?.provider) || "google-meet";
    if (selectedProvider !== "google-meet") fail(`Unsupported meeting provider: ${selectedProvider}.`);
    if (!url?.trim()) fail("Missing --url <url>.");
    if (artifactId && !asyncWorker) fail("--artifact-id is reserved for internal meeting async workers.");
    if (asyncWorker && !artifactId) fail("--artifact-id is required in meeting async worker mode.");

    // The cloud bot is the default. The local recorder runs with --local, for
    // its own worker, and for live mode, which needs Ravi's voice in the call.
    const runsLocally = Boolean(
      local ||
        asyncWorker ||
        live ||
        meetingProfile?.live.enabled ||
        process.env[RAVI_MEET_RESOLVED_PROFILE_ENV]?.trim(),
    );
    if (!runsLocally) {
      const localOnly = Object.entries({
        "--out": out,
        "--profile-dir": profileDir,
        "--duration": duration,
        "--empty-grace": emptyGrace,
        "--capture": capture,
        "--initial-prompt": initialPrompt,
        "--initial-prompt-delay": initialPromptDelay,
        "--voice-runtime": voiceRuntime,
        "--agent": liveAgentId,
        "--context": liveContext,
        "--include-session-context": includeSessionContext,
        "--tools": liveTools,
        "--skip-finalize": skipFinalize,
        "--sync": syncMode,
      })
        .filter(([, value]) => value !== undefined && value !== false)
        .map(([flag]) => flag);
      if (localOnly.length > 0) {
        contractFail(
          "meetings join",
          "LOCAL_RECORDER_OPTION",
          `${localOnly.join(", ")} only appl${localOnly.length === 1 ? "ies" : "y"} to the local recorder.`,
          {
            asJson,
            exitCode: CONTRACT_EXIT_USAGE,
            details: { options: localOnly, suggestedAction: "Add --local, or drop these options to use the cloud bot" },
          },
        );
      }
      return joinWithCloudBot({
        url: url.trim(),
        name: firstTrimmed(name, meetingProfile?.defaults.name),
        maxDuration: firstTrimmed(maxDuration, meetingProfile?.defaults.maxDuration),
        project,
        dryRun: Boolean(dryRun),
        asJson,
      });
    }
    if (project?.trim()) fail("--project applies to the cloud bot; drop it with --local.");

    const command = resolveGoogleMeetRecorderExecutable();
    const ctx = contextDefaults();
    const inheritedResolvedProfilePath = process.env[RAVI_MEET_RESOLVED_PROFILE_ENV]?.trim();
    let inheritedResolvedProfile: MeetingResolvedProfile | undefined;
    if (inheritedResolvedProfilePath) {
      try {
        inheritedResolvedProfile = readMeetingResolvedProfile(inheritedResolvedProfilePath);
      } catch (error) {
        fail(`Failed to read ${RAVI_MEET_RESOLVED_PROFILE_ENV}: ${errorMessage(error)}`);
      }
    }
    const shouldRunAsync = syncMode !== true && asyncWorker !== true && dryRun !== true;
    const effectiveName = firstTrimmed(name, meetingProfile?.defaults.name);
    const effectiveOut = firstTrimmed(out, meetingProfile?.defaults.out);
    const effectiveProfileDir = firstTrimmed(profileDir, meetingProfile?.chrome.profileDir);
    const effectiveDuration = firstTrimmed(duration, meetingProfile?.defaults.duration);
    const effectiveMaxDuration = firstTrimmed(maxDuration, meetingProfile?.defaults.maxDuration);
    const effectiveEmptyGrace = firstTrimmed(emptyGrace, meetingProfile?.defaults.emptyGrace);
    const effectiveCapture = firstTrimmed(capture, meetingProfile?.defaults.capture);
    const liveMode = Boolean(live ?? meetingProfile?.live.enabled ?? inheritedResolvedProfile?.live.enabled);
    const profileLiveTools =
      meetingProfile?.live.tools && meetingProfile.live.tools.length > 0
        ? meetingProfile.live.tools.join(",")
        : undefined;
    const effectiveLiveTools = firstTrimmed(liveTools, profileLiveTools);
    const effectiveLiveAgentId = firstTrimmed(liveAgentId, meetingProfile?.live.agentId);
    const effectiveLiveContext = firstTrimmed(liveContext, meetingProfile?.live.context);
    const effectiveIncludeSessionContext = includeSessionContext ?? meetingProfile?.live.includeSessionContext;
    const effectiveInitialPromptInput = firstTrimmed(initialPrompt, meetingProfile?.live.initialPrompt);
    const effectiveInitialPromptDelay = firstTrimmed(initialPromptDelay, meetingProfile?.live.initialPromptDelay);
    const effectiveVoiceRuntime = firstTrimmed(voiceRuntime, meetingProfile?.voice.runtime);
    const voiceRuntimeDecision = resolveMeetingVoiceRuntime({
      requested: effectiveVoiceRuntime,
      live: liveMode,
    });
    if (!voiceRuntimeDecision.runnable && voiceRuntimeDecision.error) {
      fail(voiceRuntimeDecision.error);
    }
    const liveAgentForNativeRuntime = firstTrimmed(
      effectiveLiveAgentId,
      inheritedResolvedProfile?.session.agentId,
      liveMode ? ctx.agentId : undefined,
    );
    if (liveMode && !liveAgentForNativeRuntime) {
      fail("Live meeting mode requires --agent <id> or a current Ravi agent context.");
    }
    const nativeMeetingRuntime =
      liveMode && inheritedResolvedProfile
        ? nativeMeetingRuntimeFromResolvedProfile(inheritedResolvedProfile, url.trim())
        : liveMode
          ? buildNativeMeetingRuntimeSessionPlan({
              url: url.trim(),
              agentId: liveAgentForNativeRuntime!,
              origin: ctx,
              create: !dryRun,
            })
          : undefined;
    const effectiveInitialPrompt = effectiveInitialPromptInput;
    const explicitLiveTools = effectiveLiveTools;
    if (explicitLiveTools === "all" || explicitLiveTools === "*") {
      fail("Live meeting --tools must be an explicit allowlist. `all` and `*` are not allowed.");
    }
    const shouldUseResolvedProfileContract = Boolean(
      inheritedResolvedProfile ||
        meetingProfile ||
        voiceRuntimeDecision.enabled ||
        effectiveProfileDir ||
        effectiveInitialPrompt ||
        effectiveInitialPromptDelay,
    );
    const resolvedProfileInput =
      !inheritedResolvedProfile && shouldUseResolvedProfileContract
        ? buildResolvedProfileInput({
            provider: selectedProvider,
            meetingProfile,
            sessionKey: nativeMeetingRuntime?.sessionKey ?? ctx.sessionKey,
            sessionName: nativeMeetingRuntime?.sessionName ?? ctx.sessionName ?? ctx.sessionKey,
            agentId: nativeMeetingRuntime?.agentId ?? liveAgentForNativeRuntime ?? ctx.agentId,
            contextId: getContext()?.context?.contextId,
            nativeMeetingRuntime,
            chromeProfileDir: effectiveProfileDir,
            voiceRuntimeDecision,
            initialPrompt: effectiveInitialPrompt,
            initialPromptDelay: effectiveInitialPromptDelay,
            live: liveMode,
            liveContext: effectiveLiveContext,
            includeSessionContext: effectiveIncludeSessionContext,
            liveTools: explicitLiveTools,
            toolManifestPath: undefined,
            toolCount: null,
            out: effectiveOut,
            capture: effectiveCapture,
          })
        : undefined;
    const resolvedMeetingProfile:
      | { profile: MeetingResolvedProfile; path: string | null; public: Record<string, unknown> }
      | undefined = inheritedResolvedProfile
      ? {
          profile: inheritedResolvedProfile,
          path: inheritedResolvedProfilePath!,
          public: publicMeetingResolvedProfile(inheritedResolvedProfile, inheritedResolvedProfilePath),
        }
      : resolvedProfileInput
        ? dryRun
          ? (() => {
              const profile = buildMeetingResolvedProfile(resolvedProfileInput);
              return { profile, path: null, public: publicMeetingResolvedProfile(profile, null) };
            })()
          : (() => {
              const written = writeMeetingResolvedProfile({
                ...resolvedProfileInput,
                label: `meeting-live-${Date.now()}`,
              });
              return { ...written, public: publicMeetingResolvedProfile(written.profile, written.path) };
            })()
        : undefined;
    const resolvedProfileEnv = resolvedMeetingProfile?.path
      ? { [RAVI_MEET_RESOLVED_PROFILE_ENV]: resolvedMeetingProfile.path }
      : undefined;
    const envOverrides = mergeEnvOverrides(resolvedProfileEnv);
    const providerUsesResolvedProfile = Boolean(resolvedMeetingProfile);
    const args = buildGoogleMeetJoinArgs({
      url: url.trim(),
      name: effectiveName,
      out: effectiveOut,
      profileDir: providerUsesResolvedProfile ? undefined : effectiveProfileDir,
      duration: effectiveDuration,
      maxDuration: effectiveMaxDuration,
      emptyGrace: effectiveEmptyGrace,
      capture: providerUsesResolvedProfile ? undefined : effectiveCapture,
      skipFinalize,
    });

    const basePayload = {
      provider: selectedProvider,
      providerRuntime: "google-meet-recorder",
      meetingProfile: meetingProfile ? publicMeetingProfile(meetingProfile) : null,
      voiceRuntime: publicVoiceRuntimeDecision(voiceRuntimeDecision),
      nativeMeetingSession: publicNativeMeetingRuntimeSession(nativeMeetingRuntime),
      resolvedMeetingProfile: resolvedMeetingProfile?.public ?? null,
      voiceRuntimePreflight: null,
      mode: dryRun ? "dry-run" : "foreground",
      args,
    };
    const optionsPayload = {
      provider: selectedProvider,
      providerRuntime: "google-meet-recorder",
      url: url.trim(),
      meetingProfile: meetingProfile ? publicMeetingProfile(meetingProfile) : null,
      meetingProfileId: meetingProfile?.id ?? null,
      name: effectiveName ?? null,
      out: effectiveOut ?? "~/.ravi/meetings/runs",
      profileDir: effectiveProfileDir ?? null,
      duration: effectiveDuration ?? null,
      maxDuration: effectiveMaxDuration ?? null,
      emptyGrace: effectiveEmptyGrace ?? null,
      capture: effectiveCapture ?? null,
      live: liveMode,
      liveAgentId: nativeMeetingRuntime?.agentId ?? liveAgentForNativeRuntime ?? null,
      liveAgentSessionName: nativeMeetingRuntime?.sessionName ?? null,
      nativeMeetingSession: publicNativeMeetingRuntimeSession(nativeMeetingRuntime),
      liveContext: effectiveLiveContext ?? null,
      includeSessionContext: Boolean(effectiveIncludeSessionContext),
      initialPromptChars: effectiveInitialPrompt?.length ?? null,
      initialPromptDelay: effectiveInitialPromptDelay ?? null,
      voiceRuntime: publicVoiceRuntimeDecision(voiceRuntimeDecision),
      resolvedMeetingProfile: resolvedMeetingProfile?.public ?? null,
      voiceRuntimePreflight: null,
      liveTools: explicitLiveTools || null,
      skipFinalize: Boolean(skipFinalize),
      async: shouldRunAsync || asyncWorker === true,
    };
    const baseArtifactInput = {
      kind: "meeting.join",
      status: "pending",
      title: buildMeetingJoinTitle(url),
      summary: `Meeting join queued for ${selectedProvider}`,
      provider: selectedProvider,
      command: "ravi meetings join",
      ...ctx,
      metadata: {
        providerRuntime: "google-meet-recorder",
        async: shouldRunAsync || asyncWorker === true,
        skipFinalize: Boolean(skipFinalize),
        meetingProfile: meetingProfile ? publicMeetingProfile(meetingProfile) : null,
        meetingProfileId: meetingProfile?.id ?? null,
        live: liveMode,
        liveAgentId: nativeMeetingRuntime?.agentId ?? liveAgentForNativeRuntime ?? null,
        liveAgentSessionName: nativeMeetingRuntime?.sessionName ?? null,
        nativeMeetingSession: publicNativeMeetingRuntimeSession(nativeMeetingRuntime),
        liveContext: effectiveLiveContext ?? null,
        includeSessionContext: Boolean(effectiveIncludeSessionContext),
        initialPromptChars: effectiveInitialPrompt?.length ?? null,
        initialPromptDelay: effectiveInitialPromptDelay ?? null,
        voiceRuntime: publicVoiceRuntimeDecision(voiceRuntimeDecision),
        resolvedMeetingProfile: resolvedMeetingProfile?.public ?? null,
        voiceRuntimePreflight: null,
        liveTools: explicitLiveTools || null,
        chromeProfileDir: effectiveProfileDir ?? null,
      },
      lineage: {
        source: "ravi meetings join",
        provider: selectedProvider,
        providerRuntime: "google-meet-recorder",
      },
      input: {
        url: url.trim(),
        options: optionsPayload,
      },
      tags: ["meeting", "meeting-join", selectedProvider],
    };

    if (dryRun) {
      const dryRunEnv = {
        ...(resolvedMeetingProfile
          ? { [RAVI_MEET_RESOLVED_PROFILE_ENV]: resolvedMeetingProfile.path ?? "[dry-run:not-written]" }
          : {}),
      };
      const dryRunPayload = {
        ...basePayload,
        ...(Object.keys(dryRunEnv).length > 0 ? { env: dryRunEnv } : {}),
      };
      if (asJson) printJson(dryRunPayload);
      else {
        console.log("Meeting provider invocation validated.");
        console.log(`Provider: ${selectedProvider}`);
        console.log(`Args: ${args.join(" ")}`);
        if (resolvedMeetingProfile) {
          console.log(`${RAVI_MEET_RESOLVED_PROFILE_ENV}: ${resolvedMeetingProfile.path ?? "[dry-run:not-written]"}`);
        }
      }
      return dryRunPayload;
    }

    if (shouldRunAsync) {
      const artifact = createArtifact(baseArtifactInput);
      appendArtifactEvent(artifact.id, {
        eventType: "queued",
        status: "pending",
        message: "Meeting join queued",
        payload: { options: optionsPayload },
        source: "ravi.meetings",
        ...(ctx.agentId ? { actor: ctx.agentId } : {}),
      });

      const workerArgs = buildGoogleMeetJoinWorkerArgs({
        provider: selectedProvider,
        url: url.trim(),
        name: effectiveName,
        out: effectiveOut,
        profileDir: providerUsesResolvedProfile ? undefined : effectiveProfileDir,
        duration: effectiveDuration,
        maxDuration: effectiveMaxDuration,
        emptyGrace: effectiveEmptyGrace,
        capture: providerUsesResolvedProfile ? undefined : effectiveCapture,
        voiceRuntime: providerUsesResolvedProfile
          ? undefined
          : (voiceRuntimeDecision.runtimeId ?? effectiveVoiceRuntime),
        live: providerUsesResolvedProfile ? false : liveMode,
        liveAgentId: providerUsesResolvedProfile ? undefined : liveAgentForNativeRuntime,
        liveContext: providerUsesResolvedProfile ? undefined : effectiveLiveContext,
        includeSessionContext: providerUsesResolvedProfile ? false : effectiveIncludeSessionContext,
        skipFinalize,
        artifactId: artifact.id,
      });
      const pid = spawnDetachedCli(workerArgs, envOverrides);
      appendArtifactEvent(artifact.id, {
        eventType: "worker_started",
        status: "pending",
        message: `Background meeting worker started${pid ? ` (pid ${pid})` : ""}`,
        payload: { pid: pid ?? null },
        source: "ravi.meetings",
        ...(ctx.agentId ? { actor: ctx.agentId } : {}),
      });

      const queuedPayload = {
        success: true,
        artifact_id: artifact.id,
        artifactId: artifact.id,
        kind: artifact.kind,
        status: artifact.status,
        hint: "No polling needed: the meeting job emits lifecycle events and the owner session is informed when the meeting.raw artifact is generated.",
        events: `ravi artifacts events ${artifact.id}`,
        ...(pid ? { workerPid: pid } : {}),
      };
      if (asJson) printJson(queuedPayload);
      else {
        console.log(`Meeting join queued: ${artifact.id}`);
        console.log(`Events: ravi artifacts events ${artifact.id}`);
      }
      return queuedPayload;
    }

    if (asyncWorker) {
      const primaryArtifact = getArtifact(artifactId!);
      if (!primaryArtifact) fail(`Artifact not found: ${artifactId}`);

      const runningArtifact = updateArtifact(
        primaryArtifact.id,
        {
          status: "running",
          summary: `Meeting join running for ${selectedProvider}`,
          metadata: baseArtifactInput.metadata,
          lineage: baseArtifactInput.lineage,
          input: baseArtifactInput.input,
        },
        { actor: ctx.agentId, mergeMetadata: true, mergeLineage: true },
      );
      appendArtifactEvent(runningArtifact.id, {
        eventType: "started",
        status: "running",
        message: "Meeting join started",
        payload: { options: optionsPayload },
        source: "ravi.meetings",
        ...(ctx.agentId ? { actor: ctx.agentId } : {}),
      });

      const startedAt = Date.now();
      try {
        const result = await runGoogleMeetRecorder(command, args, true, envOverrides);
        if (result.exitCode !== 0) {
          const details = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
          throw new Error(`Google Meet provider exited with code ${result.exitCode}.${details ? `\n${details}` : ""}`);
        }

        const recorderMetadata = parseRecorderJson(result.stdout);
        const recorder = summarizeRecorderMetadata(recorderMetadata);
        const finalArtifact = extractRecorderArtifact(recorderMetadata);
        if (!skipFinalize) {
          if (finalArtifact.status === "failed") {
            throw new Error(`Meeting raw artifact finalize failed: ${finalArtifact.error ?? "unknown error"}`);
          }
          if (!finalArtifact.artifactId) {
            throw new Error("Meeting completed, but no meeting.raw artifact was registered.");
          }
        }
        if (finalArtifact.artifactId) {
          attachArtifact(finalArtifact.artifactId, "artifact", runningArtifact.id, "generated-by", {
            source: "ravi.meetings.join",
          });
        }

        const durationMs = Date.now() - startedAt;
        const completedArtifact = updateArtifact(
          runningArtifact.id,
          {
            status: "completed",
            summary: finalArtifact.artifactId
              ? `Meeting ended; raw artifact generated: ${finalArtifact.artifactId}`
              : "Meeting join completed",
            durationMs,
            metadata: {
              recorder: recorder ?? null,
              finalArtifactId: finalArtifact.artifactId ?? null,
              finalArtifactPath: finalArtifact.artifactPath ?? null,
            },
            metrics: { durationMs },
            output: {
              exitCode: result.exitCode,
              recorder: recorder ?? null,
              finalArtifact,
            },
          },
          { actor: ctx.agentId, mergeMetadata: true, mergeMetrics: true },
        );
        appendArtifactEvent(completedArtifact.id, {
          eventType: "completed",
          status: "completed",
          message: finalArtifact.artifactId
            ? `Meeting raw artifact generated: ${finalArtifact.artifactId}`
            : "Meeting join completed",
          payload: {
            finalArtifactId: finalArtifact.artifactId ?? null,
            finalArtifactPath: finalArtifact.artifactPath ?? null,
            recorder,
          },
          source: "ravi.meetings",
          ...(ctx.agentId ? { actor: ctx.agentId } : {}),
        });

        if (finalArtifact.handoffMessage) {
          notifyMeetingOwnerSession(completedArtifact, "completed", finalArtifact.handoffMessage);
        } else {
          notifyMeetingOwnerSession(
            completedArtifact,
            "completed",
            [
              "[System] Inform: Meeting join completed.",
              "",
              `Artifact: ${completedArtifact.id}`,
              finalArtifact.artifactId
                ? `Meeting raw artifact: ${finalArtifact.artifactId}`
                : "Meeting raw artifact: -",
              finalArtifact.artifactPath ? `Path: ${finalArtifact.artifactPath}` : "Path: -",
            ].join("\n"),
          );
        }

        const payload = {
          ...basePayload,
          mode: "completed",
          artifactId: completedArtifact.id,
          finalArtifactId: finalArtifact.artifactId ?? null,
          finalArtifactPath: finalArtifact.artifactPath ?? null,
          exitCode: result.exitCode,
          recorder,
        };
        if (asJson) printJson(payload);
        return payload;
      } catch (error) {
        const message = errorMessage(error);
        const failedArtifact = updateArtifact(
          runningArtifact.id,
          {
            status: "failed",
            summary: `Meeting join failed: ${message}`,
            durationMs: Date.now() - startedAt,
            metadata: { error: message },
            metrics: { durationMs: Date.now() - startedAt },
            output: { error: message },
          },
          { actor: ctx.agentId, mergeMetadata: true, mergeMetrics: true },
        );
        appendArtifactEvent(failedArtifact.id, {
          eventType: "failed",
          status: "failed",
          message,
          payload: { error: message },
          source: "ravi.meetings",
          ...(ctx.agentId ? { actor: ctx.agentId } : {}),
        });
        notifyMeetingOwnerSession(
          failedArtifact,
          "failed",
          ["[System] Inform: Meeting join failed.", "", `Artifact: ${failedArtifact.id}`, `Error: ${message}`].join(
            "\n",
          ),
        );
        throw error;
      }
    }

    const result = await runGoogleMeetRecorder(command, args, Boolean(asJson), envOverrides);
    if (result.exitCode !== 0) {
      const details = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
      throw new Error(`Google Meet provider exited with code ${result.exitCode}.${details ? `\n${details}` : ""}`);
    }

    const recorderMetadata = asJson ? parseRecorderJson(result.stdout) : undefined;
    const payload = {
      ...basePayload,
      mode: "completed",
      exitCode: result.exitCode,
      recorder: summarizeRecorderMetadata(recorderMetadata),
    };

    if (asJson) {
      printJson(payload);
    }
    return payload;
  }

  // Declared UNBRAKED: finalize only registers a LOCAL meeting.raw artifact
  // from an already-completed local run dir — no external side effect, and the
  // registration is inspectable/reversible through the artifacts surface.
  @Command({
    name: "finalize",
    description: "Finalize a completed meeting recorder run into a Ravi meeting.raw artifact",
  })
  @CommandAccess({ kind: "mutate", resource: "meetings", action: "finalize", risk: "medium" })
  @Returns(meetingFinalizeReturnSchema)
  async finalize(
    @Option({ flags: "--run-dir <dir>", description: "Completed meet-recorder run directory" }) runDir?: string,
    @Option({ flags: "--title <title>", description: "Optional meeting title override" }) title?: string,
    @Option({ flags: "--no-post-transcribe", description: "Skip post-call audio transcription" })
    noPostTranscribe?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    if (!runDir?.trim()) fail("Missing --run-dir <dir>.");
    const ctx = contextDefaults();
    const result = await finalizeGoogleMeetRecorderRun({
      runDir,
      actor: ctx.agentId ?? "ravi-meet-recorder",
      title: title?.trim() || undefined,
      postTranscribe: !noPostTranscribe,
      originSessionKey: ctx.sessionKey,
      originSessionName: ctx.sessionName,
      originAgentId: ctx.agentId,
      channel: ctx.channel,
      accountId: ctx.accountId,
      chatId: ctx.chatId,
      threadId: ctx.threadId,
      messageId: ctx.messageId,
    });
    const payload = {
      artifactId: result.artifactId,
      artifactPath: result.artifactPath,
      handoffMessage: result.handoffMessage,
      transcriptSegmentCount: result.transcriptSegments.length,
      mediaRefCount: result.mediaRefs.length,
      diagnosticCount: result.diagnostics.length,
      session: {
        id: result.session.id,
        provider: result.session.provider,
        providerMeetingId: result.session.providerMeetingId ?? null,
        title: result.session.title ?? null,
        startedAt: result.session.startedAt ?? null,
        endedAt: result.session.endedAt ?? null,
      },
    };

    if (asJson) {
      printJson(payload);
    } else {
      console.log(`Meeting artifact registered: ${result.artifactId}`);
      console.log(`Path: ${result.artifactPath}`);
      console.log(`Transcript segments: ${result.transcriptSegments.length}`);
      console.log(`Media refs: ${result.mediaRefs.length}`);
    }
    return payload;
  }

  // Read-only: lists the project's cloud bots, newest first. The Console
  // returns at most its 100 newest; --offset pages inside that window.
  @Command({ name: "list", description: "List the project's cloud meeting bots" })
  @CommandAccess({ kind: "read", resource: "meetings", action: "list", risk: "low" })
  @CliOnly()
  @Returns(looseObjectSchema)
  async list(
    @Option({ flags: "--project <ref>", description: "Console project (default: linked project)" }) project?: string,
    @Option({ flags: "--limit <n>", description: "Page size (default: 20, max: 100)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Number of newer bots to skip (default: 0)" }) offset?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "meetings list";
    const client = await openCloudClient(op, project, asJson);
    const meetings = await withMeetingsCloud(op, asJson, () => client.list(CLOUD_MEETINGS_WINDOW));
    const page = paginateCliItems(meetings, { limit, offset }, { defaultLimit: 20, maxLimit: CLOUD_MEETINGS_WINDOW });
    const items = page.items.map(publicCloudMeeting);
    const pagination = buildCliOffsetPagination({
      baseCommand: ["ravi", "meetings", "list", ...(project?.trim() ? ["--project", project.trim()] : [])],
      limit: page.limit,
      offset: page.offset,
      returned: items.length,
      total: page.total,
    });
    const payload = { project: client.projectRef, total: page.total, pagination, items, meetings: items };
    if (asJson) printJson(payload);
    else if (items.length === 0) console.log("No cloud meeting bots yet.");
    else for (const meeting of page.items) printCloudMeetingLine(meeting);
    return payload;
  }

  @Command({ name: "show", description: "Show one cloud meeting bot" })
  @CommandAccess({ kind: "read", resource: "meetings", action: "show", risk: "low" })
  @CliOnly()
  @Returns(looseObjectSchema)
  async show(
    @Arg("meetingId", { description: "Cloud meeting id (from join or list)" }) meetingId: string,
    @Option({ flags: "--project <ref>", description: "Console project (default: linked project)" }) project?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "meetings show";
    const client = await openCloudClient(op, project, asJson);
    const meeting = await withMeetingsCloud(op, asJson, () => client.show(meetingId));
    const payload = { meeting: publicCloudMeeting(meeting) };
    if (asJson) printJson(payload);
    else {
      printCloudMeetingLine(meeting);
      if (meeting.failureReason) console.log(`Reason: ${meeting.failureReason}`);
    }
    return payload;
  }

  // Declared UNBRAKED: leaving only reduces what the bot does (it stops
  // recording and leaves the call); nothing new is sent or exposed.
  @Command({ name: "leave", description: "Ask a cloud meeting bot to leave the call now" })
  @CommandAccess({ kind: "mutate", resource: "meetings", action: "leave", risk: "low" })
  @CliOnly()
  @Returns(looseObjectSchema)
  async leave(
    @Arg("meetingId", { description: "Cloud meeting id (from join or list)" }) meetingId: string,
    @Option({ flags: "--project <ref>", description: "Console project (default: linked project)" }) project?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "meetings leave";
    const client = await openCloudClient(op, project, asJson);
    const result = await withMeetingsCloud(op, asJson, () => client.leave(meetingId));
    const payload = { left: result.left, meeting: publicCloudMeeting(result.meeting) };
    if (asJson) printJson(payload);
    else console.log(result.left ? `Leaving: ${meetingId}` : `Not in a call (${result.meeting.status}): ${meetingId}`);
    return payload;
  }

  // Declared UNBRAKED: fetch only downloads a finished recording and
  // registers LOCAL artifacts; it is idempotent and changes nothing remote.
  @Command({
    name: "fetch",
    description: "Download a finished cloud recording into a meeting.raw artifact",
  })
  @CommandAccess({ kind: "mutate", resource: "meetings", action: "fetch", risk: "medium" })
  @CliOnly()
  @Returns(looseObjectSchema)
  async fetch(
    @Arg("meetingId", { description: "Cloud meeting id (from join, list or the inbox item)" }) meetingId: string,
    @Option({ flags: "--project <ref>", description: "Console project (default: linked project)" }) project?: string,
    @Option({ flags: "--out <dir>", description: "Where to save media (default ~/.ravi/meetings/cloud/<id>)" })
    out?: string,
    @Option({ flags: "--video", description: "Also download the video" }) video?: boolean,
    @Option({ flags: "--no-notify", description: "Do not inform the session that asked for the meeting" })
    noNotify?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "meetings fetch";
    const client = await openCloudClient(op, project, asJson);
    const ctx = contextDefaults();
    const result = await withMeetingsCloud(op, asJson, () =>
      fetchCloudMeeting({
        client,
        meetingId,
        outputDir: out?.trim() || undefined,
        video: Boolean(video),
        actor: ctx.agentId ?? MEETINGS_CLOUD_SOURCE,
        notify: !noNotify,
      }),
    );
    const payload =
      result.outcome === "pending"
        ? { outcome: result.outcome, meeting: publicCloudMeeting(result.meeting) }
        : result.outcome === "failed"
          ? {
              outcome: result.outcome,
              meeting: publicCloudMeeting(result.meeting),
              joinArtifactId: result.joinArtifactId,
              notified: result.notified,
            }
          : result;
    if (asJson) printJson(payload);
    else if (result.outcome === "pending") console.log(`Not finished yet (${result.meeting.status}): ${meetingId}`);
    else if (result.outcome === "failed") {
      console.log(
        `The bot ended without a recording: ${result.meeting.failureReason ?? result.meeting.statusSubCode ?? "unknown"}`,
      );
    } else if (result.status === "in_progress") {
      console.log(`Another fetch of this meeting is running: ${meetingId}`);
    } else {
      const verb =
        result.status === "already_finalized"
          ? "already registered"
          : result.status === "enriched"
            ? "updated with the video"
            : "registered";
      console.log(`Meeting artifact ${verb}: ${result.rawArtifactId}`);
      if (result.rawArtifactPath) console.log(`Path: ${result.rawArtifactPath}`);
      console.log(`Transcript segments: ${result.transcriptSegmentCount}`);
    }
    return payload;
  }

  @Command({
    name: "voice-runtimes",
    description: "List meeting voice runtime candidates and current recommendation",
  })
  @CommandAccess({ kind: "read", resource: "meetings", action: "voice-runtimes", risk: "low" })
  @Returns(meetingVoiceRuntimesReturnSchema)
  voiceRuntimes(@Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean) {
    const candidates = listMeetingVoiceRuntimeCandidates();
    const payload = {
      defaultRuntimeId: DEFAULT_MEETING_VOICE_RUNTIME_ID,
      recommendation:
        "Start Google Meet live mode with ravi-native. Keep Pipecat and LiveKit as planned adapters behind the same meeting channel/runtime boundary.",
      candidates,
    };

    if (asJson) {
      printJson(payload);
    } else {
      console.log(`Default meeting voice runtime: ${DEFAULT_MEETING_VOICE_RUNTIME_ID}`);
      for (const candidate of candidates) {
        console.log(`${candidate.id}: ${candidate.availability} (${candidate.kind})`);
      }
    }
    return payload;
  }
}

@Group({
  name: "meetings.profiles",
  description: "Inspect and scaffold reusable meeting profiles",
  scope: "open",
})
export class MeetingProfileCommands {
  @Command({ name: "list", description: "List resolved meeting profiles" })
  @CommandAccess({ kind: "read", resource: "meetings.profiles", action: "list", risk: "low" })
  @Returns(meetingProfilesListReturnSchema)
  list(
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--limit <n>", description: "Page size (default: 50, max: 500)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Number of matching profiles to skip (default: 0)" }) offset?: string,
    @Option({ flags: "--fields <a,b,c>", description: "Compact mode: keep only these fields of each item" })
    fields?: string,
  ) {
    const profiles = listMeetingProfiles();
    const page = paginateCliItems(profiles, { limit, offset });
    const pageProfiles = page.items;
    const publicProfiles = pickFields(pageProfiles.map(publicMeetingProfile), fields);
    const pagination = buildCliOffsetPagination({
      fields,
      baseCommand: ["ravi", "meetings", "profiles", "list"],
      limit: page.limit,
      offset: page.offset,
      returned: pageProfiles.length,
      total: page.total,
    });
    const payload = {
      total: page.total,
      pagination,
      items: publicProfiles,
      profiles: publicProfiles,
    };

    if (asJson) {
      printJson(payload);
    } else {
      console.log(
        `Meeting profiles: ${pageProfiles.length} returned of ${page.total}, limit ${page.limit}, offset ${page.offset}`,
      );
      for (const profile of pageProfiles) {
        console.log(`${profile.id}: ${profile.label} (${profile.sourceKind})`);
      }
      if (pagination.nextCommand) {
        console.log("\nNext page:");
        console.log(`  ${pagination.nextCommand}`);
      }
    }
    return payload;
  }

  @Command({ name: "show", description: "Show one resolved meeting profile" })
  @CommandAccess({ kind: "read", resource: "meetings.profiles", action: "show", risk: "low" })
  @Returns(meetingProfileReturnSchema)
  show(
    @Arg("profileId", { description: "Meeting profile id" }) profileId: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    let profile: ResolvedMeetingProfile;
    try {
      profile = resolveMeetingProfile(profileId);
    } catch (error) {
      if (!meetingProfileExists(profileId)) {
        failMeetingProfileNotFound("meetings profiles show", profileId, asJson);
      }
      fail(errorMessage(error));
    }
    const payload = publicMeetingProfile(profile);

    if (asJson) {
      printJson(payload);
    } else {
      console.log(`Meeting profile: ${profile.id}`);
      console.log(`Label: ${profile.label}`);
      console.log(`Source: ${profile.sourceKind} :: ${profile.source}`);
      console.log(`Provider: ${profile.provider}`);
      console.log(`Voice runtime: ${profile.voice.runtime}`);
      console.log(`Chrome profile: ${profile.chrome.profileDir ?? "-"}`);
      console.log(`Tools: ${profile.live.tools.join(", ") || "-"}`);
    }
    return payload;
  }

  // Declared UNBRAKED: init scaffolds a LOCAL profile file (reversible config
  // write) — same class as tasks `profiles init`, which is unbraked by
  // precedent.
  @Command({ name: "init", description: "Create a reusable meeting profile scaffold" })
  @CommandAccess({ kind: "mutate", resource: "meetings.profiles", action: "init", risk: "medium" })
  @Returns(meetingProfileInitReturnSchema)
  init(
    @Arg("profileId", { description: "Meeting profile id" }) profileId: string,
    @Option({ flags: "--source <kind>", description: "workspace|user", defaultValue: "workspace" })
    sourceKind?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const source = sourceKind?.trim() || "workspace";
    if (source !== "workspace" && source !== "user") {
      fail("Invalid source. Use workspace|user.");
    }
    let payload: ReturnType<typeof initMeetingProfile>;
    try {
      payload = initMeetingProfile(profileId, { sourceKind: source });
    } catch (error) {
      fail(errorMessage(error));
    }

    if (asJson) {
      printJson(payload);
    } else {
      console.log(`Meeting profile created: ${profileId}`);
      console.log(`Path: ${payload.profilePath}`);
    }
    return payload;
  }

  @Command({ name: "validate", description: "Validate one meeting profile or the whole catalog" })
  @CommandAccess({ kind: "read", resource: "meetings.profiles", action: "validate", risk: "low" })
  @Returns(meetingProfilesValidateReturnSchema)
  validate(
    @Arg("profileId", { required: false, description: "Optional meeting profile id" }) profileId?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const results = validateMeetingProfiles(profileId);
    const invalid = results.filter((result) => !result.valid);
    const payload = { valid: invalid.length === 0, results };

    if (asJson) {
      printJson(payload);
    } else {
      for (const result of results) {
        console.log(`${result.valid ? "ok" : "failed"}: ${result.id} (${result.sourceKind})`);
        if (result.error) console.log(`  ${result.error}`);
      }
    }
    if (invalid.length > 0 && !asJson) {
      fail(`Meeting profile validation failed for ${invalid.length} profile(s).`);
    }
    return payload;
  }
}
