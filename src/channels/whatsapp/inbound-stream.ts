/**
 * CHANNEL_INBOUND JetStream stream shared by the WhatsApp runtime (publisher, in the
 * `ravi channels` runner) and the daemon's `WhatsAppInboundSource` (reader).
 *
 * Both sides call `ensureChannelInboundStream()` so whichever starts first creates it,
 * and the `ravi-whatsapp-*` durables, with the same configuration.
 */

import {
  AckPolicy,
  DeliverPolicy,
  RetentionPolicy,
  StringCodec,
  type JetStreamClient,
  type JetStreamManager,
} from "nats";
import { getNats } from "../../nats.js";
import { logger } from "../../utils/logger.js";
import { CHANNEL_INBOUND_STREAM, CHANNEL_INBOUND_SUBJECT_FILTER } from "./contract.js";
import {
  WHATSAPP_INBOUND_DURABLES,
  type WhatsAppInboundEvent,
  whatsappInboundKindOf,
  whatsappInboundSubject,
} from "./events.js";

const log = logger.child("channels:inbound-stream");
const sc = StringCodec();

const MAX_AGE_NS = 7 * 24 * 60 * 60 * 1_000_000_000;
const MAX_BYTES = 512 * 1024 * 1024;
/** JetStream dedupe window for `msgID` (redelivered Baileys upserts collapse here). */
const DUPLICATE_WINDOW_NS = 2 * 60 * 1_000_000_000;

/**
 * Ensure the CHANNEL_INBOUND stream and the WhatsApp inbound durables exist.
 *
 * The durables are created on every path (stream created here, by a concurrent
 * creator, or already present), so events the runner publishes before the daemon's
 * first start are kept for the daemon's consumers.
 */
export async function ensureChannelInboundStream(existingJsm?: JetStreamManager): Promise<void> {
  const jsm = existingJsm ?? (await getNats().jetstreamManager());
  await ensureStream(jsm);
  await ensureWhatsAppInboundDurables(jsm);
}

/**
 * Create each WHATSAPP_INBOUND_DURABLES entry that does not exist yet. The config matches runDurablePullLoop
 * exactly: { durable_name, filter_subject, ack_policy: AckPolicy.Explicit, deliver_policy: DeliverPolicy.New }.
 * It never updates or deletes an existing consumer. Per-durable failures are logged at warn level and do not throw.
 */
export async function ensureWhatsAppInboundDurables(jsm: JetStreamManager): Promise<void> {
  for (const { stream, durable, filterSubject } of Object.values(WHATSAPP_INBOUND_DURABLES)) {
    try {
      await jsm.consumers.info(stream, durable);
      continue;
    } catch {
      // Not found: create it.
    }
    try {
      await jsm.consumers.add(stream, {
        durable_name: durable,
        filter_subject: filterSubject,
        ack_policy: AckPolicy.Explicit,
        deliver_policy: DeliverPolicy.New,
      });
      log.info("Created WhatsApp inbound durable", { stream, durable, filter: filterSubject });
    } catch (err) {
      try {
        // A concurrent creator (the daemon or the runner) won the race.
        await jsm.consumers.info(stream, durable);
      } catch {
        log.warn("Could not create WhatsApp inbound durable", { stream, durable, error: err });
      }
    }
  }
}

async function ensureStream(jsm: JetStreamManager): Promise<void> {
  try {
    await jsm.streams.info(CHANNEL_INBOUND_STREAM);
    return;
  } catch {
    // Stream does not exist yet.
  }

  try {
    await jsm.streams.add({
      name: CHANNEL_INBOUND_STREAM,
      description: "Ravi channel inbound events",
      subjects: [CHANNEL_INBOUND_SUBJECT_FILTER],
      retention: RetentionPolicy.Limits,
      storage: "file" as never,
      max_age: MAX_AGE_NS,
      max_bytes: MAX_BYTES,
      duplicate_window: DUPLICATE_WINDOW_NS,
      num_replicas: 1,
    });
  } catch (err) {
    try {
      await jsm.streams.info(CHANNEL_INBOUND_STREAM);
      return;
    } catch {
      throw err;
    }
  }

  log.info("Created CHANNEL_INBOUND JetStream stream", {
    subjects: [CHANNEL_INBOUND_SUBJECT_FILTER],
    retention: "limits",
    max_age_days: 7,
    max_bytes: MAX_BYTES,
  });
}

/**
 * Publish one WhatsApp inbound event on
 * `ravi.channel.inbound.whatsapp.<kind>.<instanceId>`. `event.id` is the JetStream
 * `msgID`, so republishing the same event inside the duplicate window is a no-op.
 */
export async function publishWhatsAppInboundEvent(js: JetStreamClient, event: WhatsAppInboundEvent): Promise<void> {
  const subject = whatsappInboundSubject(whatsappInboundKindOf(event.type), event.instanceId);
  await js.publish(subject, sc.encode(JSON.stringify(event)), { msgID: event.id });
}
