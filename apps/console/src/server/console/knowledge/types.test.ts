import { describe, expect, test } from "bun:test";

import { cliApiError, cliErrorPayload } from "@/server/cli/errors";

import { KNOWLEDGE_TRUST_ORDER, knowledgeKindForOriginKey, originKeyPrefixForKind } from "./types";

describe("knowledge vocabulary", () => {
  test("kind comes from the origin_key prefix; null is manual", () => {
    expect(knowledgeKindForOriginKey("meeting:abc")).toBe("meeting");
    expect(knowledgeKindForOriginKey("transcript:abc")).toBe("transcript");
    expect(knowledgeKindForOriginKey("page:site:/faq")).toBe("page");
    expect(knowledgeKindForOriginKey("note:abc")).toBe("note");
    expect(knowledgeKindForOriginKey(null)).toBe("manual");
    expect(knowledgeKindForOriginKey("other:x")).toBe("manual");
    expect(originKeyPrefixForKind("page")).toBe("page:");
    expect(originKeyPrefixForKind("manual")).toBeNull();
  });

  test("trust tiers are ordered from highest to lowest", () => {
    expect(KNOWLEDGE_TRUST_ORDER).toEqual(["approved", "published", "said", "inferred"]);
  });

  test("CLI error codes for knowledge carry their default messages", () => {
    expect(cliErrorPayload(cliApiError(403, "KNOWLEDGE_TURN_NOT_OPERATOR"), "req").error.message).toBe(
      "Knowledge answers only the operator's own turns: the terminal, the operator's direct chat and the operator's routines.",
    );
    expect(cliErrorPayload(cliApiError(403, "KNOWLEDGE_DISABLED"), "req").error.message).toBe(
      "Knowledge is not enabled for this organization.",
    );
  });
});
