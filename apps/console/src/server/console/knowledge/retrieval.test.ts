import { describe, expect, test } from "bun:test";

import { ConsoleApiError } from "@/server/console/api-error";
import { buildKnowledgeExcerpt, parseRetrieveKnowledgeBody } from "./retrieval";

describe("Knowledge retrieval", () => {
  test("parses retrieval requests with bounded defaults", () => {
    expect(parseRetrieveKnowledgeBody({ query: "  project memory  " })).toEqual({
      query: "project memory",
      limit: 8,
      sourceIds: [],
      strategyKey: "default",
      metadata: {},
    });
  });

  test("rejects empty retrieval queries", () => {
    expect(() => parseRetrieveKnowledgeBody({ query: "   " })).toThrow(ConsoleApiError);
  });

  test("builds compact excerpts without preserving layout whitespace", () => {
    expect(buildKnowledgeExcerpt(" Alpha\n\nBeta   Gamma ", 12)).toBe("Alpha Beta...");
  });
});
