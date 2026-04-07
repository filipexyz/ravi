import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { locateRuntimeTranscript } from "../transcripts.js";
import type { SessionEntry } from "../router/types.js";
import type { LoadedEvalTaskSpec } from "./spec.js";
import { resolveEvalSpecPath } from "./spec.js";

export interface EvalSnapshotFileArtifact {
  path: string;
  absolutePath: string;
  label?: string;
  kind: "missing" | "file" | "directory";
  size?: number;
  mtimeMs?: number;
  sha256?: string;
  text?: string;
  preview?: string;
  entryCount?: number;
}

export interface EvalSnapshotTranscriptMessage {
  role: "user" | "assistant";
  text: string;
  time: string;
}

export interface EvalSnapshotTranscriptArtifact {
  enabled: boolean;
  exists: boolean;
  path?: string;
  messageCount: number;
  combinedText: string;
  messages: EvalSnapshotTranscriptMessage[];
  reason?: string;
}

export interface EvalSnapshot {
  takenAt: string;
  files: EvalSnapshotFileArtifact[];
  transcript: EvalSnapshotTranscriptArtifact | null;
}

export interface EvalFileDiff {
  path: string;
  absolutePath: string;
  beforeKind: EvalSnapshotFileArtifact["kind"];
  afterKind: EvalSnapshotFileArtifact["kind"];
  changed: boolean;
  reason: "unchanged" | "created" | "deleted" | "content_changed" | "directory_changed" | "missing";
}

export interface EvalSnapshotDiff {
  files: EvalFileDiff[];
  transcriptChanged: boolean;
  transcriptMessageDelta: number;
}

const TEXT_SIZE_LIMIT = 200_000;
const PREVIEW_LIMIT = 280;

export function captureEvalSnapshot(task: LoadedEvalTaskSpec, session: SessionEntry | null): EvalSnapshot {
  const files = task.spec.artifacts.files.map((artifact) =>
    snapshotFileArtifact(resolveEvalSpecPath(task, artifact.path), artifact.label),
  );
  const transcript = task.spec.artifacts.transcript ? snapshotTranscriptArtifact(session) : null;
  return {
    takenAt: new Date().toISOString(),
    files,
    transcript,
  };
}

export function diffEvalSnapshots(before: EvalSnapshot, after: EvalSnapshot): EvalSnapshotDiff {
  const files: EvalFileDiff[] = [];
  const beforeMap = new Map(before.files.map((file) => [file.absolutePath, file]));
  const afterMap = new Map(after.files.map((file) => [file.absolutePath, file]));
  const allPaths = [...new Set([...beforeMap.keys(), ...afterMap.keys()])];

  for (const absolutePath of allPaths) {
    const beforeFile = beforeMap.get(absolutePath);
    const afterFile = afterMap.get(absolutePath);
    const path = afterFile?.path ?? beforeFile?.path ?? absolutePath;
    const beforeKind = beforeFile?.kind ?? "missing";
    const afterKind = afterFile?.kind ?? "missing";

    let changed = false;
    let reason: EvalFileDiff["reason"] = "unchanged";

    if (beforeKind === "missing" && afterKind !== "missing") {
      changed = true;
      reason = "created";
    } else if (beforeKind !== "missing" && afterKind === "missing") {
      changed = true;
      reason = "deleted";
    } else if (afterKind === "directory" || beforeKind === "directory") {
      const beforeEntries = beforeFile?.entryCount ?? 0;
      const afterEntries = afterFile?.entryCount ?? 0;
      changed = beforeKind !== afterKind || beforeEntries !== afterEntries;
      reason = changed ? "directory_changed" : "unchanged";
    } else if (afterKind === "file" && beforeKind === "file") {
      changed = beforeFile?.sha256 !== afterFile?.sha256;
      reason = changed ? "content_changed" : "unchanged";
    } else if (afterKind === "missing" && beforeKind === "missing") {
      reason = "missing";
    }

    files.push({
      path,
      absolutePath,
      beforeKind,
      afterKind,
      changed,
      reason,
    });
  }

  const beforeTranscriptCount = before.transcript?.messageCount ?? 0;
  const afterTranscriptCount = after.transcript?.messageCount ?? 0;
  return {
    files,
    transcriptChanged: beforeTranscriptCount !== afterTranscriptCount,
    transcriptMessageDelta: afterTranscriptCount - beforeTranscriptCount,
  };
}

function snapshotFileArtifact(absolutePath: string, label?: string): EvalSnapshotFileArtifact {
  if (!existsSync(absolutePath)) {
    return {
      path: absolutePath,
      absolutePath,
      ...(label ? { label } : {}),
      kind: "missing",
    };
  }

  const stat = statSync(absolutePath);
  if (stat.isDirectory()) {
    return {
      path: absolutePath,
      absolutePath,
      ...(label ? { label } : {}),
      kind: "directory",
      mtimeMs: stat.mtimeMs,
      entryCount: safeReadDirCount(absolutePath),
    };
  }

  const buffer = readFileSync(absolutePath);
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  const text = buffer.length <= TEXT_SIZE_LIMIT && isProbablyText(buffer) ? buffer.toString("utf8") : undefined;
  const normalized = text?.replace(/\s+/g, " ").trim();

  return {
    path: absolutePath,
    absolutePath,
    ...(label ? { label } : {}),
    kind: "file",
    size: buffer.length,
    mtimeMs: stat.mtimeMs,
    sha256,
    ...(text !== undefined ? { text } : {}),
    ...(normalized ? { preview: normalized.slice(0, PREVIEW_LIMIT) } : {}),
  };
}

function snapshotTranscriptArtifact(session: SessionEntry | null): EvalSnapshotTranscriptArtifact {
  if (!session) {
    return {
      enabled: true,
      exists: false,
      messageCount: 0,
      combinedText: "",
      messages: [],
      reason: "Session not found.",
    };
  }

  const located = locateRuntimeTranscript({
    runtimeProvider: session.runtimeProvider,
    providerSessionId: session.providerSessionId,
    sdkSessionId: session.sdkSessionId,
    agentCwd: session.agentCwd,
  });

  if (!located.path || !existsSync(located.path)) {
    return {
      enabled: true,
      exists: false,
      path: located.path,
      messageCount: 0,
      combinedText: "",
      messages: [],
      reason: located.reason ?? "Transcript not found.",
    };
  }

  const raw = readFileSync(located.path, "utf8");
  const messages = extractNormalizedTranscriptMessages(raw);
  return {
    enabled: true,
    exists: true,
    path: located.path,
    messageCount: messages.length,
    combinedText: messages.map((message) => message.text).join("\n"),
    messages: messages.slice(-40),
  };
}

function safeReadDirCount(path: string): number {
  try {
    return readdirSync(path).length;
  } catch {
    return 0;
  }
}

function isProbablyText(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  let suspicious = 0;
  for (const byte of sample) {
    if (byte === 9 || byte === 10 || byte === 13) continue;
    if (byte >= 32 && byte <= 126) continue;
    if (byte >= 160) continue;
    suspicious += 1;
  }
  return suspicious / Math.max(1, sample.length) < 0.1;
}

export function extractNormalizedTranscriptMessages(raw: string): EvalSnapshotTranscriptMessage[] {
  const lines = raw.trim().split("\n").filter(Boolean);
  const messages: EvalSnapshotTranscriptMessage[] = [];

  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as Record<string, any>;

      if (entry.type === "user" && entry.message?.content) {
        const text = normalizeTranscriptContent(entry.message.content);
        if (!text) continue;
        messages.push({
          role: "user",
          text,
          time: typeof entry.timestamp === "string" ? entry.timestamp : "",
        });
        continue;
      }

      if (entry.type === "assistant" && entry.message?.content) {
        const text = normalizeTranscriptContent(entry.message.content);
        if (!text) continue;
        messages.push({
          role: "assistant",
          text,
          time: typeof entry.timestamp === "string" ? entry.timestamp : "",
        });
        continue;
      }

      if (
        entry.type === "response_item" &&
        entry.payload?.type === "message" &&
        entry.payload?.role &&
        entry.payload?.content
      ) {
        const role = entry.payload.role === "assistant" ? "assistant" : entry.payload.role === "user" ? "user" : null;
        if (!role) continue;

        const text = normalizeTranscriptContent(entry.payload.content);
        if (!text) continue;

        messages.push({
          role,
          text,
          time: typeof entry.timestamp === "string" ? entry.timestamp : "",
        });
      }
    } catch {
      // Ignore malformed transcript lines.
    }
  }

  return messages;
}

function normalizeTranscriptContent(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && typeof (part as { type?: unknown }).type === "string") {
          const typed = part as { type: string; text?: string };
          if (
            (typed.type === "text" || typed.type === "input_text" || typed.type === "output_text") &&
            typeof typed.text === "string"
          ) {
            return typed.text;
          }
        }
        return "";
      })
      .join(" ")
      .trim();
  }

  return "";
}
