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

describe("eval run command", () => {
  it("waits on the remote gateway longer than the longest eval run", async () => {
    await import("reflect-metadata");
    const { getCommandsMetadata } = await import("../cli/decorators.js");
    const { EvalCommands } = await import("../cli/commands/eval.js");
    const { EVAL_MAX_TIMEOUT_MS } = await import("./spec.js");
    const run = getCommandsMetadata(EvalCommands).find((command) => command.name === "run");
    expect(run?.remoteTimeoutMs).toBeGreaterThan(EVAL_MAX_TIMEOUT_MS);
  });
});
