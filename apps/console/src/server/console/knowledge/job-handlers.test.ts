import { describe, expect, test } from "bun:test";

import { createKnowledgeJobHandlers, KnowledgeJobRetryError } from "./job-handlers";
import type { KnowledgeJobRow } from "./jobs";

function job(patch: Partial<KnowledgeJobRow>): KnowledgeJobRow {
  return { id: "job-1", organizationId: "org", inputJson: {}, ...patch } as KnowledgeJobRow;
}

const ctx = { requestId: "req", now: new Date("2026-10-17T00:00:00.000Z") };

describe("knowledge job handlers", () => {
  test("meeting handlers pass the trigger and the job id, and return ids only", async () => {
    const seen: unknown[] = [];
    const handlers = createKnowledgeJobHandlers({
      captureMeeting: async (input) => {
        seen.push(input);
        return { status: "ingested", sourceId: "s", documentId: "d", versionNumber: 2, chunkCount: 3, previousDocumentId: "d0" };
      },
    });
    const result = await handlers.meeting_repair!(job({ inputJson: { meetingId: "m1" } }), ctx);
    expect(seen).toEqual([{ organizationId: "org", meetingId: "m1", requestId: "req", trigger: "meeting_repair", jobId: "job-1" }]);
    expect(result.resultJson).toEqual({ schemaVersion: 1, status: "ingested", sourceId: "s", documentId: "d", versionNumber: 2, chunkCount: 3 });
  });

  test("terminal meeting outcomes complete the job; not_ready throws a retry code", async () => {
    for (const status of ["gone", "no_project", "not_found"] as const) {
      const handlers = createKnowledgeJobHandlers({ captureMeeting: async () => ({ status }) });
      expect((await handlers.meeting_ready!(job({ inputJson: { meetingId: "m1" } }), ctx)).resultJson).toEqual({ schemaVersion: 1, status });
    }
    const retry = createKnowledgeJobHandlers({ captureMeeting: async () => ({ status: "not_ready" }) });
    const error = await retry.meeting_ready!(job({ inputJson: { meetingId: "m1" } }), ctx).catch((caught) => caught);
    expect(error).toBeInstanceOf(KnowledgeJobRetryError);
    expect(error.code).toBe("meeting_not_ready");
  });

  test("page, backfill and faq jobs capture the route with the job id and the job's own trigger", async () => {
    const seen: unknown[] = [];
    const handlers = createKnowledgeJobHandlers({
      capturePage: async (input) => {
        seen.push(input);
        return { status: "skipped", reason: "empty", sourceId: "s" } as never;
      },
    });
    for (const trigger of ["page_release", "page_backfill", "faq"] as const) {
      const result = await handlers[trigger]!(job({ triggerType: trigger, inputJson: { siteId: "site", releaseId: "rel", routeId: "route" } }), ctx);
      expect(result.resultJson).toEqual({ schemaVersion: 1, status: "empty", sourceId: "s" });
    }
    expect(seen).toHaveLength(3);
    expect(seen.map((input) => (input as { trigger: string }).trigger)).toEqual(["page_release", "page_backfill", "faq"]);
    expect(seen[0]).toEqual({ siteId: "site", releaseId: "rel", routeId: "route", requestId: "req", jobId: "job-1", trigger: "page_release" });
    expect((await handlers.page_release!(job({ inputJson: { siteId: "site" } }), ctx)).resultJson).toEqual({ status: "no_source" });
  });
});
