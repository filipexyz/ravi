// When the Console says a cloud recording is ready (or the bot failed), this
// installation turns it into local artifacts in the background, with the same
// `ravi meetings fetch` an operator would run, so the inbox loop never waits on
// a media download.

import { logger } from "../utils/logger.js";
import { MEETING_RECORDING_FAILED_EVENT, MEETING_RECORDING_READY_EVENT } from "./cloud.js";
import { spawnDetachedCli } from "./handoff.js";

const log = logger.child("meetings:inbox");

export interface MeetingInboxPayload {
  eventType: string;
  payload?: Record<string, unknown> | null;
}

/** The `ravi meetings fetch` arguments for an inbox item, or null when it is not a cloud recording event. */
export function meetingFetchArgsForInboxItem(item: MeetingInboxPayload): string[] | null {
  if (item.eventType !== MEETING_RECORDING_READY_EVENT && item.eventType !== MEETING_RECORDING_FAILED_EVENT) {
    return null;
  }
  const meetingId = item.payload?.meetingId;
  if (typeof meetingId !== "string" || !/^[0-9a-f-]{36}$/i.test(meetingId)) return null;
  const projectId = item.payload?.projectId;
  return [
    "meetings",
    "fetch",
    meetingId,
    ...(typeof projectId === "string" && /^[0-9a-f-]{36}$/i.test(projectId) ? ["--project", projectId] : []),
    "--json",
  ];
}

export function handOffMeetingInboxItem(
  item: MeetingInboxPayload,
  spawn: (args: string[]) => number | undefined = spawnDetachedCli,
): boolean {
  const args = meetingFetchArgsForInboxItem(item);
  if (!args) return false;
  try {
    const pid = spawn(args);
    log.info("Cloud meeting fetch started", { meetingId: args[2], eventType: item.eventType, pid: pid ?? null });
    return true;
  } catch (error) {
    log.warn("Cloud meeting fetch could not start", {
      meetingId: args[2],
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
