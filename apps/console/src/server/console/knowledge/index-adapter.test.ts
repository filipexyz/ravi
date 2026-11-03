import { describe, expect, test } from "bun:test";

import {
  rankKnowledgeCandidates,
  scoreKnowledgeCandidateText,
  uniqueTokens,
  type KnowledgeIndexCandidateRow,
} from "./index-adapter";

describe("Knowledge index adapter", () => {
  test("normalizes query tokens for deterministic lexical matching", () => {
    expect(uniqueTokens("RAG, rag; memória / memoria")).toEqual(["rag", "memoria"]);
  });

  test("scores exact phrases above partial token matches", () => {
    const exact = scoreKnowledgeCandidateText("permission snapshots", "The retrieval flow uses permission snapshots.");
    const partial = scoreKnowledgeCandidateText("permission snapshots", "The retrieval flow checks permission later.");

    expect(exact).toBeGreaterThan(partial);
    expect(partial).toBeGreaterThan(0);
  });

  test("does not return irrelevant candidates", () => {
    expect(scoreKnowledgeCandidateText("calendar events", "Mail threads and meetings")).toBe(0);
  });

  test("ranks candidates by score with stable rank numbers and limit", () => {
    const ranked = rankKnowledgeCandidates(
      [
        row("chunk-c", "Billing and quotas"),
        row("chunk-b", "Knowledge retrieval uses permission snapshots before citations."),
        row("chunk-a", "Permission snapshots"),
      ],
      "permission snapshots",
      { limit: 2 },
    );

    expect(ranked).toHaveLength(2);
    expect(ranked.map((candidate) => candidate.rank)).toEqual([1, 2]);
    expect(ranked[0]?.chunkId).toBe("chunk-a");
    expect(ranked[1]?.chunkId).toBe("chunk-b");
  });
});

function row(chunkId: string, text: string): KnowledgeIndexCandidateRow {
  return {
    chunkId,
    documentId: "document-1",
    sourceId: "source-1",
    projectId: "project-1",
    permissionSnapshotId: "snapshot-1",
    permissionSnapshotHash: "hash-1",
    permissionPolicy: { visibility: "project_private" },
    sourceTitle: "Source",
    documentTitle: "Document",
    sensitivity: "standard",
    text,
    textHash: `${chunkId}-hash`,
    tokenCount: null,
    location: {},
    metadata: {},
  };
}
