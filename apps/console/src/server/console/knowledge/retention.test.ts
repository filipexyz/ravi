import { describe, expect, test } from "bun:test";

import type { MarkedRoute } from "./marks";
import { knowledgeRetentionCutoffs, unpinnedArchivedDocuments } from "./retention";

describe("knowledge retention", () => {
  test("cutoffs: query text 30 days, runs 13 calendar months, archived documents and jobs 90 days", () => {
    const cutoffs = knowledgeRetentionCutoffs(new Date("2026-10-17T12:00:00.000Z"));
    expect(cutoffs.queryText.toISOString()).toBe("2026-09-17T12:00:00.000Z");
    expect(cutoffs.runs.toISOString()).toBe("2025-09-17T12:00:00.000Z");
    expect(cutoffs.archivedDocuments.toISOString()).toBe("2026-07-19T12:00:00.000Z");
    expect(cutoffs.finishedJobs.toISOString()).toBe("2026-07-19T12:00:00.000Z");
    expect(cutoffs.closedProposalBodies.toISOString()).toBe("2026-09-17T12:00:00.000Z");
  });

  test("an archived document pinned by any mark is kept", () => {
    const mark = (approvedDocumentId: string) => ({ mark: { approvedDocumentId } }) as unknown as Pick<MarkedRoute, "mark">;
    expect(unpinnedArchivedDocuments([{ id: "d1" }, { id: "d2" }, { id: "d3" }], [mark("d2"), mark("other")])).toEqual(["d1", "d3"]);
    expect(unpinnedArchivedDocuments([{ id: "d1" }], [])).toEqual(["d1"]);
  });
});
