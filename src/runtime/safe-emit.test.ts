import { describe, expect, it } from "bun:test";

import { sanitizeRuntimeEventPayload } from "./safe-emit.js";

describe("runtime safe emit", () => {
  it("redacts secrets from internal runtime payloads", () => {
    expect(
      sanitizeRuntimeEventPayload({
        type: "turn.failed",
        error: "Incorrect API key provided: sk-proj-SYNTHETICSECRET123456789",
        rawEvent: { authorization: "Bearer SYNTHETICTOKEN123456789" },
      }),
    ).toEqual({
      type: "turn.failed",
      error: "Incorrect API key provided: [REDACTED]",
      rawEvent: { authorization: "[REDACTED]" },
    });
  });
});
