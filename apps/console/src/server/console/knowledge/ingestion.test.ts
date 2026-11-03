import { describe, expect, test } from "bun:test";

import { ConsoleApiError } from "@/server/console/api-error";
import {
  chunkKnowledgeSourceText,
  chunkKnowledgeText,
  parseIngestKnowledgeSourceBody,
} from "./ingestion";

describe("Knowledge ingestion pipeline", () => {
  test("parses manual text ingestion with safe defaults", () => {
    const parsed = parseIngestKnowledgeSourceBody({
      content: "# Notes\n\nRavi knowledge plane",
      title: "  Notes  ",
    });

    expect(parsed).toEqual({
      content: "# Notes\n\nRavi knowledge plane",
      title: "Notes",
      mimeType: "text/markdown",
      language: null,
      filename: null,
      idempotencyKey: null,
      metadata: {},
    });
  });

  test("rejects empty ingestion content", () => {
    expect(() => parseIngestKnowledgeSourceBody({ content: "   " })).toThrow(ConsoleApiError);
  });

  test("chunks text deterministically with hashes and character spans", () => {
    const chunks = chunkKnowledgeText(
      "Alpha paragraph with enough words.\n\nBeta paragraph with more content for retrieval.",
      { maxChars: 40 },
    );

    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toMatchObject({
      ordinal: 0,
      text: "Alpha paragraph with enough words.",
      charStart: 0,
      charEnd: 34,
    });
    expect(chunks[0]?.textHash).toMatch(/^[a-f0-9]{64}$/);
    expect(chunks[1]).toMatchObject({
      ordinal: 1,
      text: "Beta paragraph with more content for",
      charStart: 36,
      charEnd: 72,
    });
    expect(chunks[2]).toMatchObject({
      ordinal: 2,
      text: "retrieval.",
      charStart: 73,
      charEnd: 83,
    });
  });

  test("does not create empty chunks for surrounding whitespace", () => {
    const chunks = chunkKnowledgeText("  Alpha  \n\n  Beta  ", { maxChars: 12 });
    expect(chunks.map((chunk) => chunk.text)).toEqual(["Alpha", "Beta"]);
  });

  test("preserves Ravi meeting transcript speaker and timestamp boundaries", () => {
    const chunks = chunkKnowledgeSourceText(
      [
        "# Meet",
        "",
        "## Transcript",
        "",
        "- [00:00:03] Luís Filipe: Vamos centralizar conhecimento no Console.",
        "- [00:00:08] Ravi:",
        "  Retrieval precisa citar chunks com governança.",
      ].join("\n"),
      { sourceType: "meeting" },
    );

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatchObject({
      text: "Luís Filipe: Vamos centralizar conhecimento no Console.",
      location: { transcriptTimestamp: "00:00:03" },
      metadata: {
        segmentKind: "meeting_transcript",
        speakerName: "Luís Filipe",
      },
    });
    expect(chunks[1]).toMatchObject({
      text: "Ravi: Retrieval precisa citar chunks com governança.",
      location: { transcriptTimestamp: "00:00:08" },
      metadata: {
        segmentKind: "meeting_transcript",
        speakerName: "Ravi",
      },
    });
  });
});
