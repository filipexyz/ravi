import { RetentionPolicy, type JetStreamManager } from "nats";
import { getNats } from "../nats.js";
import { logger } from "../utils/logger.js";

const log = logger.child("events:audit-stream");

export const RAVI_EVENTS_STREAM = "RAVI_EVENTS";

export const RAVI_EVENTS_SUBJECTS = [
  "ravi.session.*.response",
  "ravi.session.*.runtime",
  "ravi.session.*.claude",
  "ravi.session.*.tool",
  "ravi.session.*.stream",
  "ravi.session.*.delivery",
  "ravi.session.*.adapter.>",
  "ravi.session.abort",
  "ravi.session.reset.requested",
  "ravi.session.reset.completed",
  "ravi.session.delete.requested",
  "ravi.session.delete.completed",
  "ravi.session.model.changed",
  "ravi.session.runtime.control",
  "ravi.approval.>",
  "ravi.audit.>",
  "ravi.inbound.>",
  "ravi.outbound.>",
  "ravi.media.send",
  "ravi.contacts.>",
  "ravi.instances.>",
  "ravi.whatsapp.>",
  "ravi.config.changed",
  "ravi.triggers.>",
  "ravi.cron.>",
  "ravi.heartbeat.>",
  "ravi._cli.cli.>",
] as const;

const MAX_AGE_NS = 7 * 24 * 60 * 60 * 1_000_000_000; // 7 days
const MAX_BYTES = 512 * 1024 * 1024; // bounded replay history, not archival storage

function sorted(value: readonly string[]): string[] {
  return [...value].sort();
}

function sameSubjects(current: readonly string[] | undefined, expected: readonly string[]): boolean {
  return JSON.stringify(sorted(current ?? [])) === JSON.stringify(sorted(expected));
}

export async function ensureRaviEventsStream(jsm?: JetStreamManager): Promise<void> {
  const manager = jsm ?? (await getNats().jetstreamManager());

  try {
    const info = await manager.streams.info(RAVI_EVENTS_STREAM);
    if (sameSubjects(info.config.subjects, RAVI_EVENTS_SUBJECTS)) {
      log.debug("RAVI_EVENTS stream already exists");
      return;
    }

    await manager.streams.update(RAVI_EVENTS_STREAM, {
      ...info.config,
      subjects: [...RAVI_EVENTS_SUBJECTS],
      description: "Ravi internal audit/replay events for session debugging",
      max_age: MAX_AGE_NS,
      max_bytes: MAX_BYTES,
      num_replicas: 1,
    });
    log.info("Updated RAVI_EVENTS stream subjects", {
      subjects: RAVI_EVENTS_SUBJECTS,
    });
    return;
  } catch {
    // Stream does not exist yet.
  }

  await manager.streams.add({
    name: RAVI_EVENTS_STREAM,
    description: "Ravi internal audit/replay events for session debugging",
    subjects: [...RAVI_EVENTS_SUBJECTS],
    retention: RetentionPolicy.Limits,
    storage: "file" as never,
    max_age: MAX_AGE_NS,
    max_bytes: MAX_BYTES,
    num_replicas: 1,
  });

  log.info("Created RAVI_EVENTS JetStream stream", {
    subjects: RAVI_EVENTS_SUBJECTS,
    retention: "limits",
    storage: "file",
    max_age_days: 7,
    max_bytes: MAX_BYTES,
  });
}
