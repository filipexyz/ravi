import { createHash } from "node:crypto";
import { z } from "zod";
import { connectNats, getNats } from "../nats.js";
import { getRaviDbPath } from "../router/router-db.js";
import type { Trigger } from "../triggers/types.js";
import { prError } from "./contracts.js";

export function followHealthTopic(): string {
  return `ravi.pr.follow.health.${createHash("sha256").update(getRaviDbPath()).digest("hex").slice(0, 16)}`;
}
export function followFingerprint(trigger: Partial<Trigger>): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        trigger.id,
        trigger.enabled,
        trigger.topic,
        trigger.filter,
        trigger.agentId,
        trigger.accountId,
        trigger.replySession,
        trigger.replySource,
        trigger.session,
      ]),
    )
    .digest("hex");
}
const healthSchema = z.object({
  running: z.boolean(),
  producerRunning: z.boolean(),
  fingerprint: z.string().nullable(),
});
async function requestRuntimeHealth(triggerId?: string): Promise<unknown> {
  let connection: ReturnType<typeof getNats>;
  try {
    try {
      connection = getNats();
    } catch {
      await connectNats(undefined, { explicit: false, retry: false, quiet: true });
      connection = getNats();
    }
  } catch {
    throw prError("FOLLOW_RUNTIME_UNAVAILABLE", "Cannot reach the active Ravi runtime to verify CI follow.", {
      retryable: true,
    });
  }
  const response = await connection.request(followHealthTopic(), Buffer.from(JSON.stringify({ triggerId })), {
    timeout: 1_000,
  });
  return JSON.parse(new TextDecoder().decode(response.data));
}
export async function requireFollowRuntime(
  trigger?: Trigger,
  probe: (triggerId?: string) => Promise<unknown> = requestRuntimeHealth,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  do {
    try {
      const health = healthSchema.parse(await probe(trigger?.id));
      if (health.running && health.producerRunning && (!trigger || health.fingerprint === followFingerprint(trigger)))
        return;
    } catch {
      /* A stopped/old runtime is not a working follow. Never start a replacement runner here. */
    }
    if (!trigger) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw prError(
    "FOLLOW_RUNTIME_UNAVAILABLE",
    "The active Ravi runtime has not confirmed its CI producer and trigger subscription. Update/start the runtime, then rerun publication.",
    { retryable: true },
  );
}
