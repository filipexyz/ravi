import { spawn } from "node:child_process";
import { appendArtifactEvent, type ArtifactRecord } from "../artifacts/store.js";

/** Runs this Ravi CLI again, detached, with the same runtime and bundle. */
export function spawnDetachedCli(args: string[], envOverrides?: NodeJS.ProcessEnv): number | undefined {
  const entrypoint = process.argv[1];
  if (!entrypoint) {
    throw new Error("Cannot resolve Ravi CLI entrypoint for async worker.");
  }
  const child = spawn(process.execPath, [entrypoint, ...args], {
    detached: true,
    stdio: "ignore",
    env: envOverrides ? { ...process.env, ...envOverrides } : process.env,
  });
  child.unref();
  return child.pid;
}

/**
 * Tells the session that asked for the meeting what happened, after its
 * current reply (`sessions inform --barrier after_response`), and records the
 * attempt on the artifact.
 */
export function notifyMeetingOwnerSession(
  artifact: ArtifactRecord,
  status: "completed" | "failed",
  message: string,
): void {
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
      message: error instanceof Error ? error.message : String(error),
      source: "ravi.meetings",
      ...(artifact.agentId ? { actor: artifact.agentId } : {}),
    });
  }
}
