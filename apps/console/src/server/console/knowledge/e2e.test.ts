import { describe, expect, test } from "bun:test";

import { chunkKnowledgeText } from "./ingestion";
import { knowledgeChunkKey } from "./producer";
import { buildKnowledgeQuery } from "./query";
import { buildKnowledgeExcerpt } from "./retrieval";
import { foldKnowledgeText, neutralizeKnowledgeText } from "./text";

// The pure half of the P0 scenario. The database half (producer ingest, FTS
// search, canonical reload, revoke, runs without text) is e2e.db.test.ts.
describe("Knowledge P0 end-to-end scenario (pure)", () => {
  test("manual content becomes chunks whose folded text answers the folded query", () => {
    const chunks = chunkKnowledgeText(
      [
        "# Ravi Knowledge Plane",
        "",
        "The Console centralizes organization data as governed knowledge sources.",
        "Retrieval must cite chunks and respect live source status before agents can use the answer.",
      ].join("\n"),
      { maxChars: 90 },
    );
    const query = buildKnowledgeQuery("live source status");
    expect(chunks.length).toBeGreaterThan(1);
    expect(query?.terms).toEqual(["live", "source", "status"]);

    const matching = chunks.filter((chunk) => {
      const folded = foldKnowledgeText(neutralizeKnowledgeText(chunk.text)).split(" ");
      return (query?.terms ?? []).every((term) => folded.some((word) => word.startsWith(term)));
    });
    expect(matching).toHaveLength(1);
    expect(buildKnowledgeExcerpt(matching[0]?.text ?? "", 160)).toContain("live source status");
  });

  test("identical sections in one document get distinct chunk keys", () => {
    const hash = "a".repeat(64);
    expect(knowledgeChunkKey("h:Trocas", 0, hash)).not.toBe(knowledgeChunkKey("h:Trocas", 1, hash));
    expect(knowledgeChunkKey("h:Trocas", 3, hash)).toBe(`h:Trocas:3:${"a".repeat(16)}`);
  });
});
