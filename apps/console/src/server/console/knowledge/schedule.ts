// Work that runs after the response: draining capture jobs and reading a newly
// active Pages release. Both use `after()` from next/server inside a request,
// and a detached promise outside one (scripts, tests). Neither ever throws:
// a publish or a webhook never fails because of knowledge.

import { randomUUID } from "node:crypto";

import { after } from "next/server";

const DRAIN_LIMIT = 10;
const DRAIN_BUDGET_MS = 45_000;

type Task = () => Promise<unknown>;

/** next/server after(() => drainKnowledgeJobs(…, limit 10, budget 45s)); fallback void promise. */
export function scheduleKnowledgeDrain(requestId: string): void {
  runLater(async () => {
    const [{ drainKnowledgeJobs }, { KNOWLEDGE_JOB_HANDLERS }] = await Promise.all([import("./jobs"), import("./job-handlers")]);
    await drainKnowledgeJobs({
      handlers: KNOWLEDGE_JOB_HANDLERS,
      limit: DRAIN_LIMIT,
      budgetMs: DRAIN_BUDGET_MS,
      workerId: `after:${randomUUID()}`,
      requestId,
    });
  }, { requestId, task: "drain" });
}

/** The default publish knowledgeHook: after(() => onActiveSiteManifestWritten(input)). */
export function scheduleKnowledgePageCapture(input: { siteId: string; releaseId: string; requestId: string }): void {
  runLater(async () => {
    const { onActiveSiteManifestWritten } = await import("./producers/page");
    await onActiveSiteManifestWritten(input);
  }, { requestId: input.requestId, task: "page_capture" });
}

/** after(() => startKnowledgeBackfill(input)): the first search of an organization captures what predates Knowledge. */
export function scheduleKnowledgeBackfill(input: { organizationId: string; requestId: string }): void {
  runLater(async () => {
    const { startKnowledgeBackfill } = await import("./backfill");
    await startKnowledgeBackfill(input);
  }, { requestId: input.requestId, task: "backfill" });
}

function runLater(task: Task, context: { requestId: string; task: string }) {
  const guarded = async () => {
    try {
      await task();
    } catch (error) {
      console.warn("[knowledge] scheduled work failed", { ...context, error: error instanceof Error ? error.name : typeof error });
    }
  };
  try {
    after(guarded);
  } catch {
    // Outside a request scope after() throws: run detached instead.
    void guarded();
  }
}
