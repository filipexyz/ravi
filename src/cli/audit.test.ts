import { describe, expect, it } from "bun:test";
import { REDACTION_STRUCTURED_KEY_CORPUS, REDACTION_TEXT_CORPUS } from "../test/redaction-corpus.js";
import { sanitizeCliAuditInput } from "./audit.js";

describe("CLI audit redaction", () => {
  it("uses the central sanitizer for structured keys and the shared text corpus", () => {
    const input = {
      ...Object.fromEntries(REDACTION_STRUCTURED_KEY_CORPUS.map((key) => [key, `synthetic-${key}`])),
      messages: REDACTION_TEXT_CORPUS.map((entry) => entry.input),
    };
    const serialized = JSON.stringify(sanitizeCliAuditInput(input));
    for (const key of REDACTION_STRUCTURED_KEY_CORPUS) expect(serialized).not.toContain(`synthetic-${key}`);
    for (const entry of REDACTION_TEXT_CORPUS) expect(serialized).not.toContain(entry.secret);
  });
});
