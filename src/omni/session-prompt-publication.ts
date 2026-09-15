import type { MessageTarget } from "../runtime/message-types.js";

export interface SessionPromptPublicationInput {
  sessionName: string;
  payload: Record<string, unknown>;
  publishDurably(): Promise<unknown>;
  emitRuntimeEvent(topic: string, payload: Record<string, unknown>): Promise<unknown>;
  recordPublishedTrace(input: { sessionName: string; payload: Record<string, unknown> }): unknown;
  onRuntimeEventError(error: unknown): void;
  onTraceError(error: unknown): void;
}

export async function publishSessionPromptPublication(input: SessionPromptPublicationInput): Promise<void> {
  await input.publishDurably();

  if (isMessageTarget(input.payload.source)) {
    input
      .emitRuntimeEvent(`ravi.session.${input.sessionName}.runtime`, {
        type: "prompt.published",
        sessionName: input.sessionName,
        _source: input.payload.source,
        deliveryBarrier: input.payload.deliveryBarrier,
        deliveryBarrierSource: input.payload.deliveryBarrierSource,
        timestamp: new Date().toISOString(),
      })
      .catch(input.onRuntimeEventError);
  }

  try {
    input.recordPublishedTrace({
      sessionName: input.sessionName,
      payload: input.payload,
    });
  } catch (error) {
    input.onTraceError(error);
  }
}

function isMessageTarget(value: unknown): value is MessageTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const target = value as Record<string, unknown>;
  return (
    typeof target.channel === "string" && typeof target.accountId === "string" && typeof target.chatId === "string"
  );
}
