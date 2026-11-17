import { createHash } from "node:crypto";
import { findLocalInboxItemByDedupeKey, upsertLocalInboxItem } from "../inbox/local-db.js";
import { getSessionByName } from "../router/sessions.js";
import type { RuntimeLaunchPrompt } from "./message-types.js";
import type { RuntimeStartCapacitySnapshot } from "./start-admission.js";

export function runtimeStartReceiptKey(
  sessionName: string,
  prompt: RuntimeLaunchPrompt,
  transportIdentity: string,
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([sessionName, transportIdentity, prompt]))
    .digest("hex");
  return `runtime-start:${digest}`;
}

export function findRejectedRuntimeStart(key: string) {
  return findLocalInboxItemByDedupeKey(key);
}

/** Failure propagates: the caller must not ACK unless the full envelope is durable. */
export function preserveRejectedRuntimeStart(input: {
  key: string;
  sessionName: string;
  prompt: RuntimeLaunchPrompt;
  capacity: RuntimeStartCapacitySnapshot;
}) {
  const existing = findRejectedRuntimeStart(input.key);
  if (existing) return { item: existing, created: false };
  const session = getSessionByName(input.sessionName);
  return upsertLocalInboxItem({
    sourceDomain: "system",
    sourceType: "runtime_start_rejected",
    sourceId: input.key,
    dedupeKey: input.key,
    title: "Runtime start needs capacity",
    status: "open",
    priority: "high",
    summary: `Session "${input.sessionName}" was refused before execution. Free capacity and resume the saved prompt envelope.`,
    assignedToAgentId: session?.agentId ?? input.prompt._agentId ?? null,
    occurredAt: Date.now(),
    actorType: "system",
    metadata: {
      sessionKey: session?.sessionKey ?? input.sessionName,
      sessionName: input.sessionName,
      prompt: input.prompt,
      capacity: input.capacity,
      providerHandoff: false,
      recovery: "operator_resume_saved_envelope",
    },
  });
}
