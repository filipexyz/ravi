import { describe, expect, it } from "bun:test";
import { EvalTaskSpecSchema } from "./spec.js";

describe("EvalTaskSpecSchema", () => {
  it("accepts a minimal runnable eval task spec", () => {
    const parsed = EvalTaskSpecSchema.parse({
      version: 1,
      id: "response-smoke",
      prompt: "reply with EVAL_OK",
      session: {
        name: "eval-smoke",
        agentId: "dev",
      },
      artifacts: {
        files: [],
        transcript: true,
      },
      rubric: [
        {
          id: "response_contains",
          type: "response.contains",
          needle: "EVAL_OK",
        },
      ],
      runner: {
        timeoutMs: 45000,
      },
    });

    expect(parsed.id).toBe("response-smoke");
    expect(parsed.session.agentId).toBe("dev");
  });
});
