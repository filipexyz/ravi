import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createCallEvent } from "./calls-db.js";
import type { CallRequest, CallResult } from "./types.js";

function metadataFlag(metadata: Record<string, unknown> | null, key: string): unknown {
  if (!metadata) return undefined;
  return metadata[key];
}

export function shouldNotifyCallOrigin(request: CallRequest): boolean {
  if (!request.origin_session_name) return false;
  const explicit =
    metadataFlag(request.metadata_json, "notify_origin") ?? metadataFlag(request.metadata_json, "notifyOrigin");
  return explicit !== false;
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1)}…`;
}

function buildCallResultNotification(request: CallRequest, result: CallResult): string {
  const lines = [
    `Prox call result: ${request.id}`,
    `Outcome: ${result.outcome}`,
    `Person: ${request.target_person_id}`,
    `Reason: ${request.reason}`,
  ];

  if (result.summary?.trim()) {
    lines.push("", `Summary: ${truncateText(result.summary.trim(), 1200)}`);
  }

  if (result.transcript?.trim()) {
    lines.push("", "Transcript excerpt:", truncateText(result.transcript.trim(), 1800));
  }

  lines.push(
    "",
    `Inspect: ravi prox calls show ${request.id} --json`,
    `Transcript: ravi prox calls transcript ${request.id} --json`,
  );

  return lines.join("\n");
}

function spawnDetachedCli(args: string[]): number | undefined {
  if (process.env.RAVI_CALLS_ORIGIN_NOTIFY_DRY_RUN === "1") return undefined;

  const raviBin = resolveRaviCliPath();
  if (!raviBin) {
    throw new Error("Cannot resolve Ravi CLI for call notification.");
  }

  const child = spawn(raviBin, args, {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
  return child.pid;
}

function resolveRaviCliPath(): string | null {
  const explicit = process.env.RAVI_BIN?.trim();
  if (explicit) {
    if (explicit.includes("/") && !existsSync(explicit)) return null;
    return explicit;
  }

  const cwdBin = join(process.cwd(), "bin", "ravi");
  if (existsSync(cwdBin)) return cwdBin;

  const entrypoint = process.argv[1];
  if (!entrypoint) return null;

  const bundleRootBin = join(dirname(dirname(dirname(entrypoint))), "bin", "ravi");
  if (existsSync(bundleRootBin)) return bundleRootBin;

  const sourceRootBin = join(dirname(entrypoint), "..", "bin", "ravi");
  if (existsSync(sourceRootBin)) return sourceRootBin;

  return null;
}

export function notifyCallOrigin(request: CallRequest, result: CallResult, source = "prox.calls"): void {
  if (!shouldNotifyCallOrigin(request)) return;
  const target = request.origin_session_name;
  if (!target) return;

  try {
    const pid = spawnDetachedCli([
      "sessions",
      "inform",
      target,
      buildCallResultNotification(request, result),
      "--barrier",
      "after_response",
    ]);

    createCallEvent({
      request_id: request.id,
      run_id: result.run_id,
      event_type: "result.notified",
      status: result.outcome,
      message:
        process.env.RAVI_CALLS_ORIGIN_NOTIFY_DRY_RUN === "1"
          ? `Origin session notification queued for ${target} (dry run)`
          : `Origin session notification queued for ${target}${pid ? ` (pid ${pid})` : ""}`,
      payload_json: {
        target_session: target,
        result_id: result.id,
      },
      source,
    });
  } catch (error) {
    createCallEvent({
      request_id: request.id,
      run_id: result.run_id,
      event_type: "result.notify_failed",
      status: result.outcome,
      message: error instanceof Error ? error.message : String(error),
      payload_json: {
        target_session: target,
        result_id: result.id,
      },
      source,
    });
  }
}
