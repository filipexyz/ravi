/**
 * Class of an assistant history row (sessions/turn-output): `commentary` is an
 * intermediate block, `final` may stand as the turn's answer. NULL is a legacy
 * final row.
 */
export type UtteranceClass = "final" | "commentary";

/** A runtime event (or its `.response` payload) whose metadata marks it as a provider commentary block. */
export function isCommentaryMetadata(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== "object") return false;
  const item = (metadata as { item?: unknown }).item;
  return Boolean(item && typeof item === "object" && (item as { phase?: unknown }).phase === "commentary");
}

/** A row that may stand as the turn's answer: commentary is history, never the final answer. */
export function isFinalAssistantMessage(message: { role: string; utterance_class?: string | null }): boolean {
  return message.role === "assistant" && (message.utterance_class ?? "final") === "final";
}
