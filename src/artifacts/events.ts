import { isExplicitConnect, publish } from "../nats.js";
import { logger } from "../utils/logger.js";
import type { ArtifactEvent, ArtifactRecord } from "./store.js";

const log = logger.child("artifacts:events");

export type ArtifactLifecycleTopic =
  | "ravi.artifacts.created"
  | "ravi.artifacts.running"
  | "ravi.artifacts.completed"
  | "ravi.artifacts.failed"
  | "ravi.artifacts.archived";

type ArtifactLifecyclePublisher = (subject: string, payload: Record<string, unknown>) => Promise<void> | void;

let publisherForTests: ArtifactLifecyclePublisher | null = null;

export function setArtifactLifecycleEventPublisherForTests(publisher?: ArtifactLifecyclePublisher): void {
  publisherForTests = publisher ?? null;
}

export function resolveArtifactLifecycleTopic(
  event: Pick<ArtifactEvent, "eventType" | "status">,
): ArtifactLifecycleTopic | null {
  const eventType = event.eventType.trim().toLowerCase();
  const status = event.status?.trim().toLowerCase() || "";

  if (eventType === "created") return "ravi.artifacts.created";
  if (eventType === "running" || eventType === "started") return "ravi.artifacts.running";
  if (eventType === "completed") return "ravi.artifacts.completed";
  if (eventType === "failed") return "ravi.artifacts.failed";
  if (eventType === "archived") return "ravi.artifacts.archived";

  if (eventType === "updated") {
    if (status === "running") return "ravi.artifacts.running";
    if (status === "completed") return "ravi.artifacts.completed";
    if (status === "failed") return "ravi.artifacts.failed";
    if (status === "archived") return "ravi.artifacts.archived";
  }

  return null;
}

export function emitArtifactLifecycleEvent(input: { artifact: ArtifactRecord; event: ArtifactEvent }): void {
  const subject = resolveArtifactLifecycleTopic(input.event);
  if (!subject) return;

  const publisher = publisherForTests ?? (isExplicitConnect() ? publish : null);
  if (!publisher) return;

  const payload = buildArtifactLifecyclePayload(input);
  Promise.resolve(publisher(subject, payload)).catch((error) => {
    log.warn("Failed to publish artifact lifecycle event", {
      subject,
      artifactId: input.artifact.id,
      eventId: input.event.id,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

export function buildArtifactLifecyclePayload(input: {
  artifact: ArtifactRecord;
  event: ArtifactEvent;
}): Record<string, unknown> {
  const { artifact, event } = input;
  return {
    version: 1,
    eventType: "artifact.lifecycle",
    lifecycle: subjectLifecycle(resolveArtifactLifecycleTopic(event)),
    artifact: {
      id: artifact.id,
      kind: artifact.kind,
      title: artifact.title ?? null,
      summary: artifact.summary ?? null,
      status: artifact.status,
      uri: artifact.uri ?? null,
      filePath: artifact.filePath ?? null,
      blobPath: artifact.blobPath ?? null,
      mimeType: artifact.mimeType ?? null,
      sizeBytes: artifact.sizeBytes ?? null,
      sha256: artifact.sha256 ?? null,
      sessionKey: artifact.sessionKey ?? null,
      sessionName: artifact.sessionName ?? null,
      agentId: artifact.agentId ?? null,
      taskId: artifact.taskId ?? null,
      messageId: artifact.messageId ?? null,
      channel: artifact.channel ?? null,
      accountId: artifact.accountId ?? null,
      chatId: artifact.chatId ?? null,
      threadId: artifact.threadId ?? null,
      createdAt: artifact.createdAt,
      updatedAt: artifact.updatedAt,
    },
    event: {
      id: event.id,
      artifactId: event.artifactId,
      eventType: event.eventType,
      status: event.status ?? null,
      message: event.message ?? null,
      source: event.source ?? null,
      actor: event.actor ?? null,
      payload: event.payload ?? null,
      createdAt: event.createdAt,
    },
    occurredAt: new Date(event.createdAt).toISOString(),
  };
}

function subjectLifecycle(subject: ArtifactLifecycleTopic | null): string {
  return subject?.replace("ravi.artifacts.", "") ?? "unknown";
}
