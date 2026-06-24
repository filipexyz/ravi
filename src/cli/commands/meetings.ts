import "reflect-metadata";
import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { CliOnly, Command, CommandAccess, Group, Option, Returns } from "../decorators.js";
import { fail, getContext } from "../context.js";
import {
  appendArtifactEvent,
  attachArtifact,
  createArtifact,
  getArtifact,
  updateArtifact,
  type ArtifactRecord,
} from "../../artifacts/store.js";
import { looseObjectSchema } from "./operational-return-schemas.js";
import { finalizeGoogleMeetRecorderRun } from "../../meetings/google-meet/recorder-run.js";

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

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

function spawnDetachedCli(args: string[]): number | undefined {
  const entrypoint = process.argv[1];
  if (!entrypoint) {
    throw new Error("Cannot resolve Ravi CLI entrypoint for async worker.");
  }
  const child = spawn(process.execPath, [entrypoint, ...args], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
  return child.pid;
}

function notifyOwnerSession(artifact: ArtifactRecord, status: "completed" | "failed", message: string): void {
  const target = artifact.sessionName ?? artifact.sessionKey;
  if (!target) return;
  try {
    const pid = spawnDetachedCli(["sessions", "inform", target, message, "--barrier", "after_response"]);
    appendArtifactEvent(artifact.id, {
      eventType: "notified",
      status,
      message: `Owner session notification queued${pid ? ` (pid ${pid})` : ""}`,
      source: "ravi.meetings",
      ...(artifact.agentId ? { actor: artifact.agentId } : {}),
    });
  } catch (error) {
    appendArtifactEvent(artifact.id, {
      eventType: "notification_failed",
      status,
      message: errorMessage(error),
      source: "ravi.meetings",
      ...(artifact.agentId ? { actor: artifact.agentId } : {}),
    });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

function buildGoogleMeetJoinArgs(input: {
  url: string;
  name?: string;
  out?: string;
  profileDir?: string;
  duration?: string;
  maxDuration?: string;
  emptyGrace?: string;
  capture?: string;
  realtimeTranscribe?: boolean;
  realtimeAgent?: boolean;
  speakBack?: boolean;
  realtimeVoice?: string;
  realtimeLanguage?: string;
  realtimeInstructions?: string;
  skipFinalize?: boolean;
}): string[] {
  const args = ["--url", input.url, "--until-empty", "--out", input.out?.trim() || "~/.ravi/meetings/runs"];
  pushOption(args, "--name", input.name);
  pushOption(args, "--profile-dir", input.profileDir);
  pushOption(args, "--duration", input.duration);
  pushOption(args, "--max-duration", input.maxDuration);
  pushOption(args, "--empty-grace", input.emptyGrace);
  pushOption(args, "--capture", input.capture);
  pushOption(args, "--realtime-voice", input.realtimeVoice);
  pushOption(args, "--realtime-language", input.realtimeLanguage);
  pushOption(args, "--realtime-instructions", input.realtimeInstructions);
  if (input.realtimeTranscribe) args.push("--realtime-transcribe");
  if (input.realtimeAgent) args.push("--realtime-agent");
  if (input.speakBack) args.push("--speak-back");
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
  realtimeTranscribe?: boolean;
  realtimeAgent?: boolean;
  speakBack?: boolean;
  realtimeVoice?: string;
  realtimeLanguage?: string;
  realtimeInstructions?: string;
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
  pushOption(args, "--capture", input.capture);
  pushOption(args, "--realtime-voice", input.realtimeVoice);
  pushOption(args, "--realtime-language", input.realtimeLanguage);
  pushOption(args, "--realtime-instructions", input.realtimeInstructions);
  pushFlag(args, "--realtime-transcribe", input.realtimeTranscribe);
  pushFlag(args, "--realtime-agent", input.realtimeAgent);
  pushFlag(args, "--speak-back", input.speakBack);
  pushFlag(args, "--skip-finalize", input.skipFinalize);
  args.push("--artifact-id", input.artifactId, "--async-worker", "--json");
  return args;
}

interface GoogleMeetJoinRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function runGoogleMeetRecorder(command: string, args: string[], asJson: boolean): Promise<GoogleMeetJoinRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, asJson ? [...args, "--json"] : args, {
      env: process.env,
      stdio: asJson ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let stdout = "";
    let stderr = "";
    if (asJson) {
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
  const meetCode = trimmed.match(/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})/i)?.[1];
  return `Google Meet ${meetCode ?? trimmed}`.slice(0, 200);
}

@Group({
  name: "meetings",
  description: "Meeting artifact and provider operations",
  scope: "open",
})
export class MeetingsCommands {
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
    @Option({ flags: "--realtime-transcribe", description: "Enable OpenAI Realtime transcription" })
    realtimeTranscribe?: boolean,
    @Option({ flags: "--realtime-agent", description: "Enable OpenAI Realtime speech agent" }) realtimeAgent?: boolean,
    @Option({ flags: "--speak-back", description: "Allow Realtime agent audio back into the meeting" })
    speakBack?: boolean,
    @Option({ flags: "--realtime-voice <voice>", description: "Realtime output voice" }) realtimeVoice?: string,
    @Option({ flags: "--realtime-language <language>", description: "Optional transcription language hint" })
    realtimeLanguage?: string,
    @Option({ flags: "--realtime-instructions <text>", description: "Realtime agent instructions override" })
    realtimeInstructions?: string,
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
  ) {
    const selectedProvider = provider?.trim() || "google-meet";
    if (selectedProvider !== "google-meet") fail(`Unsupported meeting provider: ${selectedProvider}.`);
    if (!url?.trim()) fail("Missing --url <url>.");
    if (artifactId && !asyncWorker) fail("--artifact-id is reserved for internal meeting async workers.");
    if (asyncWorker && !artifactId) fail("--artifact-id is required in meeting async worker mode.");

    const command = resolveGoogleMeetRecorderExecutable();
    const ctx = contextDefaults();
    const shouldRunAsync = syncMode !== true && asyncWorker !== true && dryRun !== true;
    const args = buildGoogleMeetJoinArgs({
      url: url.trim(),
      name,
      out,
      profileDir,
      duration,
      maxDuration,
      emptyGrace,
      capture,
      realtimeTranscribe,
      realtimeAgent,
      speakBack,
      realtimeVoice,
      realtimeLanguage,
      realtimeInstructions,
      skipFinalize,
    });

    const basePayload = {
      provider: selectedProvider,
      providerRuntime: "google-meet-recorder",
      mode: dryRun ? "dry-run" : "foreground",
      args,
    };
    const optionsPayload = {
      provider: selectedProvider,
      providerRuntime: "google-meet-recorder",
      url: url.trim(),
      name: name ?? null,
      out: out ?? "~/.ravi/meetings/runs",
      profileDir: profileDir ?? null,
      duration: duration ?? null,
      maxDuration: maxDuration ?? null,
      emptyGrace: emptyGrace ?? null,
      capture: capture ?? null,
      realtimeTranscribe: Boolean(realtimeTranscribe),
      realtimeAgent: Boolean(realtimeAgent),
      speakBack: Boolean(speakBack),
      realtimeVoice: realtimeVoice ?? null,
      realtimeLanguage: realtimeLanguage ?? null,
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
        realtimeTranscribe: Boolean(realtimeTranscribe),
        realtimeAgent: Boolean(realtimeAgent),
        speakBack: Boolean(speakBack),
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
      if (asJson) printJson(basePayload);
      else {
        console.log("Meeting provider invocation validated.");
        console.log(`Provider: ${selectedProvider}`);
        console.log(`Args: ${args.join(" ")}`);
      }
      return basePayload;
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
        name,
        out,
        profileDir,
        duration,
        maxDuration,
        emptyGrace,
        capture,
        realtimeTranscribe,
        realtimeAgent,
        speakBack,
        realtimeVoice,
        realtimeLanguage,
        realtimeInstructions,
        skipFinalize,
        artifactId: artifact.id,
      });
      const pid = spawnDetachedCli(workerArgs);
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
        const result = await runGoogleMeetRecorder(command, args, true);
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
          notifyOwnerSession(completedArtifact, "completed", finalArtifact.handoffMessage);
        } else {
          notifyOwnerSession(
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
        notifyOwnerSession(
          failedArtifact,
          "failed",
          ["[System] Inform: Meeting join failed.", "", `Artifact: ${failedArtifact.id}`, `Error: ${message}`].join(
            "\n",
          ),
        );
        throw error;
      }
    }

    const result = await runGoogleMeetRecorder(command, args, Boolean(asJson));
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

  @Command({
    name: "finalize",
    description: "Finalize a completed meeting recorder run into a Ravi meeting.raw artifact",
  })
  @CommandAccess({ kind: "mutate", resource: "meetings", action: "finalize", risk: "medium" })
  @Returns(looseObjectSchema)
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
}
