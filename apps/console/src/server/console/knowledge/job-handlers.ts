import type { JsonRecord } from "@/server/db/schema";

import type { KnowledgeJobHandler, KnowledgeJobRow, KnowledgeTriggerType } from "./jobs";
import { captureMeetingForKnowledge, type MeetingCaptureTrigger } from "./producers/meeting";
import { capturePageRoute } from "./producers/page";
import type { ProducerIngestResult } from "./producer";

// The drain's handlers: meeting captures, page captures (release and backfill)
// and the /faq capture. Each passes the claimed job's id to the producer, which
// then writes no job row of its own, so a capture leaves exactly one job row.
// A handler returns only ids, counts and status codes: never text.

/** Outcomes that end the job without a retry; the tick never repairs them again. */
export const MEETING_TERMINAL_STATUSES = ["gone", "no_project", "not_found"] as const;

/** A meeting that is not done yet is worth retrying; the job backs off. */
export class KnowledgeJobRetryError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "KnowledgeJobRetryError";
  }
}

export function createKnowledgeJobHandlers(deps: {
  captureMeeting?: typeof captureMeetingForKnowledge;
  capturePage?: typeof capturePageRoute;
} = {}): Partial<Record<KnowledgeTriggerType, KnowledgeJobHandler>> {
  const captureMeeting = deps.captureMeeting ?? captureMeetingForKnowledge;
  const capturePage = deps.capturePage ?? capturePageRoute;

  const meeting =
    (trigger: MeetingCaptureTrigger): KnowledgeJobHandler =>
    async (job, ctx) => {
      const meetingId = stringField(job, "meetingId");
      if (!meetingId) return { resultJson: { status: "not_found" } };
      const result = await captureMeeting({
        organizationId: job.organizationId,
        meetingId,
        requestId: ctx.requestId,
        trigger,
        jobId: job.id,
      });
      if (result.status === "not_ready") throw new KnowledgeJobRetryError("meeting_not_ready");
      return { resultJson: resultJson(result) };
    };

  const page: KnowledgeJobHandler = async (job, ctx) => {
    const siteId = stringField(job, "siteId");
    const releaseId = stringField(job, "releaseId");
    const routeId = stringField(job, "routeId");
    if (!siteId || !releaseId || !routeId) return { resultJson: { status: "no_source" } };
    const trigger = job.triggerType === "page_backfill" || job.triggerType === "faq" ? job.triggerType : "page_release";
    const result = await capturePage({ siteId, releaseId, routeId, requestId: ctx.requestId, jobId: job.id, trigger });
    return { resultJson: resultJson(result) };
  };

  return {
    meeting_ready: meeting("meeting_ready"),
    meeting_repair: meeting("meeting_repair"),
    meeting_backfill: meeting("meeting_backfill"),
    page_release: page,
    page_backfill: page,
    faq: page,
  };
}

export const KNOWLEDGE_JOB_HANDLERS: Partial<Record<KnowledgeTriggerType, KnowledgeJobHandler>> = createKnowledgeJobHandlers();

function resultJson(result: ProducerIngestResult | { status: string }): JsonRecord {
  if (!("sourceId" in result)) return { schemaVersion: 1, status: result.status };
  if (result.status === "skipped") return { schemaVersion: 1, status: result.reason, sourceId: result.sourceId };
  if (result.status === "unchanged") {
    return { schemaVersion: 1, status: "unchanged", sourceId: result.sourceId, documentId: result.documentId, versionNumber: result.versionNumber };
  }
  return {
    schemaVersion: 1,
    status: "ingested",
    sourceId: result.sourceId,
    documentId: result.documentId,
    versionNumber: result.versionNumber,
    chunkCount: result.chunkCount,
  };
}

function stringField(job: KnowledgeJobRow, key: string): string | null {
  const value = job.inputJson[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}
