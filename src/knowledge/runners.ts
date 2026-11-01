// The leader-only Knowledge runners (contract §13.9): the local index (with
// the daily purge), the nightly curator, the mirror sync and the morning DM.
// `daemon.ts` starts them in both leader paths (initial election and
// leadership vacancy) and stops them on shutdown. Both calls are idempotent.

import { logger } from "../utils/logger.js";
import { startKnowledgeCuratorRunner, stopKnowledgeCuratorRunner } from "./curator/runner.js";
import { startKnowledgeDigestRunner, stopKnowledgeDigestRunner } from "./digest/runner.js";
import { startKnowledgeMirrorRunner, stopKnowledgeMirrorRunner } from "./mirror/sync.js";
import { startKnowledgeIndexRunner, stopKnowledgeIndexRunner } from "./store/local-index.js";

const log = logger.child("knowledge:runners");

export interface KnowledgeLeaderRunner {
  name: string;
  start: () => void;
  stop: () => void;
}

export const DEFAULT_KNOWLEDGE_LEADER_RUNNERS: readonly KnowledgeLeaderRunner[] = [
  { name: "index", start: startKnowledgeIndexRunner, stop: stopKnowledgeIndexRunner },
  { name: "curator", start: startKnowledgeCuratorRunner, stop: stopKnowledgeCuratorRunner },
  { name: "mirror", start: startKnowledgeMirrorRunner, stop: stopKnowledgeMirrorRunner },
  { name: "digest", start: startKnowledgeDigestRunner, stop: stopKnowledgeDigestRunner },
];

let started: readonly KnowledgeLeaderRunner[] | null = null;

/** Starts every runner once; a second call is a no-op. One runner failing does not stop the others. */
export function startKnowledgeLeaderRunners(
  runners: readonly KnowledgeLeaderRunner[] = DEFAULT_KNOWLEDGE_LEADER_RUNNERS,
): void {
  if (started) return;
  started = runners;
  for (const runner of runners) {
    try {
      runner.start();
    } catch (error) {
      log.warn("knowledge runner failed to start", {
        runner: runner.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/** Stops what `startKnowledgeLeaderRunners` started; a no-op when nothing runs. */
export function stopKnowledgeLeaderRunners(): void {
  const runners = started;
  if (!runners) return;
  started = null;
  for (const runner of runners) {
    try {
      runner.stop();
    } catch (error) {
      log.warn("knowledge runner failed to stop", {
        runner: runner.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export function knowledgeLeaderRunnersStarted(): boolean {
  return started !== null;
}
