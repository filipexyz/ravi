/**
 * Class of an assistant history row (sessions/turn-output): `commentary` is an
 * intermediate block, `final` may stand as the turn's answer. NULL is a legacy
 * final row.
 */
export type UtteranceClass = "final" | "commentary";

/** A row that may stand as the turn's answer: commentary is history, never the final answer. */
export function isFinalAssistantMessage(message: { role: string; utterance_class?: string | null }): boolean {
  return message.role === "assistant" && (message.utterance_class ?? "final") === "final";
}
