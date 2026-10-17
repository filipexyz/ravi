// STUB (wave A, K-O1). Owner: K-O5. Contract §13.3: the nightly curator.
// The signatures below are the contract; the bodies are replaced by the owner
// (who may add fields to CuratorRunDeps).

export type CuratorRunDeps = Record<string, unknown>;

/** Leader only; daily at 03:00 local. */
export function startKnowledgeCuratorRunner(): void {
  throw new Error("not implemented: startKnowledgeCuratorRunner");
}

export function stopKnowledgeCuratorRunner(): void {
  throw new Error("not implemented: stopKnowledgeCuratorRunner");
}

export function runCuratorForSubject(
  _input: { agentId: string; contactId: string; chatIds: string[]; sinceMessageId: number },
  _deps?: CuratorRunDeps,
): Promise<{ proposed: number; activated: number; drafts: number; rejectedSpans: number }> {
  throw new Error("not implemented: runCuratorForSubject");
}
